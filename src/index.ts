import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG = {
  thresholdPercent: 80,
  saveIntervalMs: 30000,
  providerCheckIntervalMs: 60000,
  dataFileName: "oc-plugin-usage-data.json",
};

// 阈值配置文件：TUI 插件手动调整阈值时写入，Server 每轮询读取，两边保持一致
const CONFIG_FILE = join(homedir(), ".opencode", "oc-plugin-usage-config.json");

// 读取阈值：文件（用户手动调整） > 插件选项 > 默认 80
function readThresholdFile(): number {
  try {
    if (existsSync(CONFIG_FILE)) {
      const n = Number(JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))?.usageThresholdPercent);
      if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    }
  } catch {
    // 文件损坏时用默认值
  }
  return CONFIG.thresholdPercent;
}

// 已提醒过的百分比：只在"跨越阈值"时提醒一次，避免每轮轮询都弹
//   1. 首次达到阈值 → 提醒
//   2. 比上次提醒高了 ≥10 个百分点 → 提醒（80→90→100 逐步升级）
//   3. 上次提醒时还没到阈值（阈值被调低了）→ 提醒
const notifiedPct = new Map<string, number>();
function crossedThreshold(key: string, pct: number, threshold: number): boolean {
  const last = notifiedPct.get(key);
  if (pct < threshold) return false;
  if (last === undefined || last < threshold || pct >= last + 10) {
    notifiedPct.set(key, pct);
    return true;
  }
  return false;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

interface UsageData {
  lastUpdated: string;
  startDate: string;
  totals: {
    sessions: number;
    toolCalls: number;
    filesEdited: number;
    errors: number;
    toastsShown: number;
    promptAppends: number;
    commandsExecuted: number;
  };
  byDate: Record<string, DayStats>;
  providerUsage: Record<string, ProviderUsage>;
  processedSessions?: string[];
}

interface DayStats {
  date: string;
  sessions: number;
  toolCalls: Record<string, number>;
  filesEdited: number;
  errors: number;
  toastsShown: number;
  promptAppends: number;
  commandsExecuted: number;
}

interface GoWindow {
  cost: number;
  limit: number;
  remaining: number;
}
interface GoWindows {
  rolling5h: GoWindow;
  weekly: GoWindow;
  monthly: GoWindow;
}

interface GoApiWindow {
  status?: string;
  percent: number;
  resetsAt?: string;
}
interface GoApiUsage {
  rolling: GoApiWindow;
  weekly: GoApiWindow;
  monthly: GoApiWindow;
  lastChecked?: string;
}

interface ProviderUsage {
  cost?: number;
  limit?: number | null;
  remaining?: number;
  totalTokens?: number;
  lastChecked?: string;
  dailyCosts?: Record<string, number>;
  recentEvents?: Array<{ time: number; cost: number }>;
  goWindows?: GoWindows;
  goApi?: GoApiUsage;
  chatgpt?: ChatGptUsage;
  tokenrhythm?: TokenRhythmUsage;
  deepseek?: DeepSeekUsage;
}

// TokenRhythm（tokenrhythm.studio）账户用量 —— 来自 /api/wallet/summary 和 /api/usage-summary
// 与账户页（/account/account）的"实际可用总额"和"总成本（已产生费用）"同源
interface TokenRhythmUsage {
  availableBalance?: number; // 实际可用总额（CNY）
  currency?: string;         // 币种，默认 CNY
  totalCost?: number;        // 累计成本（已产生费用，CNY）
  calls?: number;            // 累计调用次数
  authExpired?: boolean;     // Cookie 失效（401），数据为旧值
  lastChecked?: string;
}

interface DeepSeekUsage {
  totalBalance?: number;
  grantedBalance?: number;
  toppedUpBalance?: number;
  currency?: string;
  isAvailable?: boolean;
  lastChecked?: string;
}

// ChatGPT (chatgpt.com) 用量 —— 来自 backend-api/wham/usage
interface ChatGptUsage {
  planType?: string;
  primary: GoApiWindow;    // 5 小时窗口
  secondary?: GoApiWindow; // 每周窗口（部分账号可能没有）
  credits?: number;        // 剩余 Credits
  creditUsage?: ChatGptCreditUsage;
  lastChecked?: string;
}

interface CreditUsageBreakdown {
  codex: number;
  work: number;
  total: number;
}

interface ChatGptCreditUsage {
  daily: Record<string, CreditUsageBreakdown>;
  last7Days: CreditUsageBreakdown;
  lastChecked?: string;
}

interface CreditUsageEvent {
  date?: string;
  product_surface?: string;
  credit_amount?: number | string;
}

function emptyCreditUsageBreakdown(): CreditUsageBreakdown {
  return { codex: 0, work: 0, total: 0 };
}

// 与 Codex Cloud Analytics 的个人账号页面保持一致：按 surface 分为 Codex / Work，直接累加 Credits。
function aggregateCreditUsage(events: unknown): ChatGptCreditUsage {
  const daily: Record<string, CreditUsageBreakdown> = {};
  const cutoff = dateNDaysAgo(7);
  if (Array.isArray(events)) {
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as CreditUsageEvent;
      const date = typeof event.date === "string" ? event.date.slice(0, 10) : "";
      const amount = Number(event.credit_amount);
      if (!date || date < cutoff || !Number.isFinite(amount)) continue;

      const day = daily[date] || (daily[date] = emptyCreditUsageBreakdown());
      const bucket = typeof event.product_surface === "string" && event.product_surface.startsWith("work_")
        ? "work"
        : "codex";
      day[bucket] += amount;
      day.total += amount;
    }
  }

  const last7Days = emptyCreditUsageBreakdown();
  for (const day of Object.values(daily)) {
    last7Days.codex += day.codex;
    last7Days.work += day.work;
    last7Days.total += day.total;
  }

  return { daily, last7Days, lastChecked: new Date().toISOString() };
}

const GO_LIMITS = {
  fiveHour: 12,
  weekly: 30,
  monthly: 60,
};

function calculateGoWindows(pu: ProviderUsage): GoWindows {
  const now = Date.now();
  const fiveHoursMs = 5 * 60 * 60 * 1000;

  let rolling5hCost = 0;
  if (pu.recentEvents) {
    const cutoff = now - fiveHoursMs;
    for (const evt of pu.recentEvents) {
      if (evt.time >= cutoff) rolling5hCost += evt.cost;
    }
  }

  let weeklyCost = 0;
  let monthlyCost = 0;
  if (pu.dailyCosts) {
    const weekCutoff = dateNDaysAgo(7);
    const monthCutoff = dateNDaysAgo(30);
    for (const [date, cost] of Object.entries(pu.dailyCosts)) {
      if (date >= monthCutoff) monthlyCost += cost;
      if (date >= weekCutoff) weeklyCost += cost;
    }
  }

  return {
    rolling5h: { cost: rolling5hCost, limit: GO_LIMITS.fiveHour, remaining: Math.max(0, GO_LIMITS.fiveHour - rolling5hCost) },
    weekly: { cost: weeklyCost, limit: GO_LIMITS.weekly, remaining: Math.max(0, GO_LIMITS.weekly - weeklyCost) },
    monthly: { cost: monthlyCost, limit: GO_LIMITS.monthly, remaining: Math.max(0, GO_LIMITS.monthly - monthlyCost) },
  };
}

function readGoKeyFromAuth(): string | null {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    return auth["opencode-go"]?.key || null;
  } catch {
    return null;
  }
}

async function checkGoUsage(apiKey: string): Promise<GoApiUsage | null> {
  try {
    const resp = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const u = json?.usage;
    if (!u?.rolling || !u?.weekly || !u?.monthly) return null;
    return {
      rolling: { status: u.rolling.status, percent: u.rolling.percent, resetsAt: u.rolling.resetsAt },
      weekly: { status: u.weekly.status, percent: u.weekly.percent, resetsAt: u.weekly.resetsAt },
      monthly: { status: u.monthly.status, percent: u.monthly.percent, resetsAt: u.monthly.resetsAt },
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ChatGPT OAuth 客户端 ID（与 Codex CLI 一致，用于刷新 access token）
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// 通过 refresh token 换取 access token，并把新的 token 写回 auth.json。
// OpenAI 的 refresh token 是一次性的（旋转）：一旦被消费，旧的 refresh token 立即失效。
// 因此必须把刷新结果写回 auth.json，否则 opencode 与插件会互相把对方的 refresh token 弄失效。
async function refreshChatGptToken(refresh: string): Promise<{ access: string; expires: number; refresh: string } | null> {
  try {
    const resp = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}&client_id=${CHATGPT_OAUTH_CLIENT_ID}`,
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    if (!json?.access_token) return null;
    const next = {
      access: json.access_token,
      expires: Date.now() + (json.expires_in || 3600) * 1000,
      refresh: json.refresh_token || refresh,
    };
    try {
      const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
      if (existsSync(authPath)) {
        const auth = JSON.parse(readFileSync(authPath, "utf-8"));
        if (auth["openai"]) {
          auth["openai"].access = next.access;
          auth["openai"].refresh = next.refresh;
          auth["openai"].expires = next.expires;
          writeFileSync(authPath, JSON.stringify(auth, null, 2));
        }
      }
    } catch {
      // 写回失败不影响本次查询（token 已在内存中）
    }
    return next;
  } catch {
    return null;
  }
}

function chatGptAccountHeaders(accountId?: string): Record<string, string> {
  const id = accountId?.trim();
  return id && id !== "personal" ? { "ChatGPT-Account-ID": id } : {};
}

// 查询 ChatGPT 用量（chatgpt.com 后台的 wham/usage，与 Codex Cloud 分析页同一数据源）
async function checkChatGPTUsage(accountId?: string): Promise<ChatGptUsage | null> {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const oa = auth["openai"];
    if (!oa) return null;

    // 优先使用 auth.json 里 opencode 维护的 access token（opencode 会在后台刷新并写回）。
    // 不要单独用缓存的 refresh token 刷新：OpenAI 的 refresh token 是一次性的，
    // 插件抢先刷新会消耗掉 opencode 手里的 refresh token，导致两边都用不了，
    // 从而造成用量百分比一直停留在旧值。
    let access: string | null =
      typeof oa.access === "string" && oa.access ? oa.access : null;
    const expires = Number(oa.expires);
    if (access && (!Number.isFinite(expires) || expires < Date.now() + 5 * 60 * 1000)) {
      access = null; // access token 缺失或即将过期，走 refresh 分支
    }
    if (!access) {
      if (typeof oa.refresh !== "string" || !oa.refresh) return null;
      const refreshed = await refreshChatGptToken(oa.refresh);
      if (!refreshed) return null;
      access = refreshed.access;
    }

    const headers = {
      Authorization: `Bearer ${access}`,
      ...chatGptAccountHeaders(accountId),
    };
    const [resp, creditsResp] = await Promise.all([
      fetch("https://chatgpt.com/backend-api/wham/usage", { headers }),
      fetch("https://chatgpt.com/backend-api/wham/usage/credit-usage-events", { headers }).catch(() => null),
    ]);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const rl = json?.rate_limit;
    if (!rl?.primary_window) return null;
    const window = (x: any): GoApiWindow | undefined => {
      if (!x) return undefined;
      const percent = Number(x.used_percent);
      if (!Number.isFinite(percent)) return undefined;
      const resetAt = Number(x.reset_at);
      return {
        status: typeof x.status === "string" ? x.status : undefined,
        percent,
        resetsAt: Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toISOString() : undefined,
      };
    };
    const primary = window(rl.primary_window);
    if (!primary) return null;
    let creditUsage: ChatGptCreditUsage | undefined;
    if (creditsResp?.ok) {
      try {
        creditUsage = aggregateCreditUsage((await creditsResp.json())?.data);
      } catch {
        // Analytics 数据异常时不影响限额窗口显示。
      }
    }
    return {
      planType: json?.plan_type,
      primary,
      secondary: window(rl.secondary_window),
      credits: json?.credits?.balance != null && Number.isFinite(Number(json.credits.balance))
        ? Number(json.credits.balance)
        : undefined,
      creditUsage,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// TokenRhythm 会话 Cookie：优先用插件选项 tokenrhythmCookie，其次读
// ~/.opencode/tokenrhythm-cookie.txt（把浏览器里 /api 请求的整个 Cookie 头粘进去即可）
function readTokenRhythmCookie(opts: PluginOptions): string | null {
  const fromOption = opts.tokenrhythmCookie?.trim();
  if (fromOption) return fromOption;
  try {
    const cookieFile = join(homedir(), ".opencode", "tokenrhythm-cookie.txt");
    if (existsSync(cookieFile)) {
      const c = readFileSync(cookieFile, "utf-8").trim();
      if (c) return c;
    }
  } catch {
    // 读取失败当作未配置
  }
  return null;
}

// 查询 TokenRhythm 账户数据（钱包余额 + 用量汇总，和 /account/account 页面同源）。
// 该站的管理 API 只认浏览器登录会话（Cookie），不支持 API key 认证。
async function checkTokenRhythmUsage(cookie: string): Promise<TokenRhythmUsage | null> {
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  try {
    const headers = { Cookie: cookie, Accept: "application/json" };
    const [walletResp, usageResp] = await Promise.all([
      fetch("https://tokenrhythm.studio/api/wallet/summary", { headers }),
      fetch("https://tokenrhythm.studio/api/usage-summary", { headers }),
    ]);
    if (walletResp.status === 401 || usageResp.status === 401) {
      return { authExpired: true, lastChecked: new Date().toISOString() };
    }
    if (!walletResp.ok && !usageResp.ok) return null;
    // 响应可能是 {code,message,data} 包装，也可能是裸对象
    const unwrap = async (resp: Response): Promise<any> => {
      try {
        const json: any = await resp.json();
        return json?.data && typeof json.data === "object" ? json.data : json;
      } catch {
        return null;
      }
    };
    const wallet = walletResp.ok ? await unwrap(walletResp) : null;
    const usage = usageResp.ok ? await unwrap(usageResp) : null;
    const availableBalance = num(wallet?.availableBalanceCny);
    const totalCost = num(usage?.costCny);
    if (availableBalance == null && totalCost == null) return null;
    return {
      availableBalance,
      currency: typeof wallet?.currency === "string" ? wallet.currency : "CNY",
      totalCost,
      calls: num(usage?.calls),
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function bootstrapGoHistory(ctx: any, data: UsageData, trackedCosts: Set<string>): Promise<void> {
  const log = (msg: string) => {
    try { ctx.client?.app?.log({ body: { service: "oc-plugin-usage", level: "info", message: msg } }); } catch {}
  };
  try {
    const sessionsRes = await ctx.client.v2.session.list({ directory: ctx.directory });
    const sessions: any[] = sessionsRes?.data?.data || [];
    const processed = new Set(data.processedSessions || []);

    for (const session of sessions) {
      if (processed.has(session.id)) continue;
      processed.add(session.id);

      const pid = session.model?.providerID || "unknown";
      const cost = session.cost || 0;
      if (cost <= 0) continue;

      if (!data.providerUsage[pid]) {
        data.providerUsage[pid] = { cost: 0, lastChecked: new Date().toISOString() };
      }
      data.providerUsage[pid].cost = (data.providerUsage[pid].cost || 0) + cost;

      if (pid === "opencode-go") {
        const go = data.providerUsage[pid]!;
        if (!go.dailyCosts) go.dailyCosts = {};
        const ts = session.time?.created || Date.now();
        const dateKey = new Date(ts).toISOString().slice(0, 10);
        go.dailyCosts[dateKey] = (go.dailyCosts[dateKey] || 0) + cost;
        if (!go.recentEvents) go.recentEvents = [];
        if (ts > Date.now() - 6 * 60 * 60 * 1000) {
          go.recentEvents.push({ time: ts, cost });
        }
        go.goWindows = calculateGoWindows(go);
      }
    }
    data.processedSessions = Array.from(processed);
  } catch (e) {
    log(`bootstrap: error: ${e}`);
  }
}

const DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  opencode: "Zen",
  "opencode-go": "opencode",
  tokenrhythm: "TokenRhythm",
};

interface PluginOptions {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  goApiKey?: string;
  chatGptAccountId?: string;
  tokenrhythmCookie?: string;
  deepseekApiKey?: string;
  usageThresholdPercent?: number;
}

function readProviderKey(provider: string): string | null {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const key = auth[provider]?.key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

function loadData(filePath: string): UsageData {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {
    // corrupt data — start fresh
  }
  return {
    lastUpdated: new Date().toISOString(),
    startDate: todayKey(),
    totals: { sessions: 0, toolCalls: 0, filesEdited: 0, errors: 0, toastsShown: 0, promptAppends: 0, commandsExecuted: 0 },
    byDate: {},
    providerUsage: {},
    processedSessions: [],
  };
}

function saveData(filePath: string, data: UsageData): void {
  const dirPath = dirname(filePath);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  data.lastUpdated = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function ensureTodayStats(data: UsageData): DayStats {
  const key = todayKey();
  if (!data.byDate[key]) {
    data.byDate[key] = {
      date: key,
      sessions: 0,
      toolCalls: {},
      filesEdited: 0,
      errors: 0,
      toastsShown: 0,
      promptAppends: 0,
      commandsExecuted: 0,
    };
  }
  return data.byDate[key];
}

function sumToolCalls(d: DayStats): number {
  return Object.values(d.toolCalls).reduce((a, b) => a + b, 0);
}

type Period = "today" | "week" | "month" | "rolling" | "all";

function aggregate(data: UsageData, period: Period) {
  const today = todayKey();
  let cutoff: string | null;
  switch (period) {
    case "today":
      cutoff = today;
      break;
    case "week":
      cutoff = dateNDaysAgo(7);
      break;
    case "month":
    case "rolling":
      cutoff = dateNDaysAgo(30);
      break;
    default:
      cutoff = null;
  }
  const result = { sessions: 0, toolCalls: 0, filesEdited: 0, errors: 0, toastsShown: 0, promptAppends: 0, commandsExecuted: 0 };
  for (const [date, day] of Object.entries(data.byDate)) {
    if (cutoff && date < cutoff) continue;
    result.sessions += day.sessions;
    result.toolCalls += sumToolCalls(day);
    result.filesEdited += day.filesEdited;
    result.errors += day.errors;
    result.toastsShown += day.toastsShown;
    result.promptAppends += day.promptAppends;
    result.commandsExecuted += day.commandsExecuted;
  }
  return result;
}

function formatStats(stats: ReturnType<typeof aggregate>, period: string): string {
  return [
    `Period: ${period}`,
    `  Sessions:          ${stats.sessions}`,
    `  Tool calls:        ${stats.toolCalls}`,
    `  Files edited:      ${stats.filesEdited}`,
    `  Errors:            ${stats.errors}`,
    `  Toasts shown:      ${stats.toastsShown}`,
    `  Prompt appends:    ${stats.promptAppends}`,
    `  Commands executed: ${stats.commandsExecuted}`,
  ].join("\n");
}

function formatProviderUsage(pu: ProviderUsage, label: string): string {
  const lines: string[] = [`--- ${label} ---`];
  const fmtPct = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (pu.chatgpt) {
    const fmt = (w: GoApiWindow) =>
      `${fmtPct(w.percent)}% used${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString()})` : ""}`;
    if (pu.chatgpt.planType) lines.push(`  Plan:       ${pu.chatgpt.planType}`);
    lines.push(`  5h:         ${fmt(pu.chatgpt.primary)}`);
    if (pu.chatgpt.secondary) lines.push(`  Weekly:     ${fmt(pu.chatgpt.secondary)}`);
    if (pu.chatgpt.credits != null) lines.push(`  Credits:    ${pu.chatgpt.credits.toFixed(1)}`);
    if (pu.chatgpt.creditUsage) {
      lines.push(`  Credits 7d: ${pu.chatgpt.creditUsage.last7Days.total.toFixed(1)}`);
      lines.push(`    Codex:    ${pu.chatgpt.creditUsage.last7Days.codex.toFixed(1)}`);
      lines.push(`    Work:     ${pu.chatgpt.creditUsage.last7Days.work.toFixed(1)}`);
    }
  }
  if (pu.tokenrhythm) {
    const tr = pu.tokenrhythm;
    const money = (n: number, currency?: string) =>
      currency && currency !== "CNY" ? `${n.toFixed(2)} ${currency}` : `¥${n.toFixed(2)}`;
    if (tr.availableBalance != null) lines.push(`  Available:  ${money(tr.availableBalance, tr.currency)}`);
    if (tr.totalCost != null) lines.push(`  Total cost: ${money(tr.totalCost, tr.currency)}`);
    if (tr.calls != null) lines.push(`  Calls:      ${tr.calls.toLocaleString()}`);
    if (tr.authExpired) lines.push(`  Note:       session cookie expired, showing stale data`);
  }
  if (pu.deepseek) {
    const ds = pu.deepseek;
    const money = (n: number) => `${n.toFixed(2)} ${ds.currency || "CNY"}`;
    if (ds.totalBalance != null) lines.push(`  Balance:    ${money(ds.totalBalance)}`);
    if (ds.toppedUpBalance != null) lines.push(`  Recharged:  ${money(ds.toppedUpBalance)}`);
    if (ds.grantedBalance != null) lines.push(`  Granted:    ${money(ds.grantedBalance)}`);
    if (ds.isAvailable === false) lines.push(`  Note:       balance unavailable for API calls`);
  }
  if (pu.goApi) {
    const fmt = (w: GoApiWindow) =>
      `${fmtPct(w.percent)}% used${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString()})` : ""}`;
    lines.push(`  Plan:       Go`);
    lines.push(`  Rolling 5h: ${fmt(pu.goApi.rolling)}`);
    lines.push(`  Weekly:     ${fmt(pu.goApi.weekly)}`);
    lines.push(`  Monthly:    ${fmt(pu.goApi.monthly)}`);
  } else if (pu.goWindows) {
    const fmt = (w: GoWindow) => `$${w.cost.toFixed(2)} / $${w.limit} (${w.limit > 0 ? ((w.cost / w.limit) * 100).toFixed(1) : 0}%)`;
    lines.push(`  Rolling 5h: ${fmt(pu.goWindows.rolling5h)}`);
    lines.push(`  Weekly:     ${fmt(pu.goWindows.weekly)}`);
    lines.push(`  Monthly:    ${fmt(pu.goWindows.monthly)}`);
  } else {
    if (pu.cost != null) lines.push(`  Cost:       $${pu.cost.toFixed(2)}`);
    if (pu.totalTokens != null) lines.push(`  Tokens:     ${pu.totalTokens.toLocaleString()}`);
    if (pu.limit != null) lines.push(`  Limit:      $${pu.limit}`);
    if (pu.remaining != null) lines.push(`  Remaining:  $${pu.remaining.toFixed(2)}`);
    if (pu.limit != null && pu.cost != null && pu.limit > 0) {
      const pct = ((pu.cost / pu.limit) * 100).toFixed(1);
      lines.push(`  Used:       ${pct}%`);
    }
  }
  return lines.join("\n");
}

async function checkOpenAIUsage(apiKey: string): Promise<ProviderUsage | null> {
  try {
    const today = todayKey();
    const start = dateNDaysAgo(30);
    const [usageResp, subResp] = await Promise.all([
      fetch(`https://api.openai.com/v1/dashboard/billing/usage?start_date=${start}&end_date=${today}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      fetch("https://api.openai.com/v1/dashboard/billing/subscription", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }).catch(() => null),
    ]);
    if (!usageResp.ok) return null;
    const usage: any = await usageResp.json();
    let sub: any = null;
    if (subResp?.ok) sub = await subResp.json();
    const cost = usage.total_usage ? usage.total_usage / 100 : 0;
    const limit = sub?.hard_limit_usd ?? sub?.system_hard_limit_usd ?? null;
    return {
      cost,
      limit,
      remaining: limit != null ? limit - cost : undefined,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function checkAnthropicUsage(apiKey: string): Promise<ProviderUsage | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/usage", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    return {
      totalTokens: json.total_tokens,
      cost: json.total_cost,
      limit: json.credit_limit ?? null,
      remaining: json.remaining_credits,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function checkDeepSeekBalance(apiKey: string): Promise<DeepSeekUsage | null> {
  try {
    const resp = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const balance = Array.isArray(json?.balance_infos) ? json.balance_infos[0] : null;
    if (!balance) return null;
    const num = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };
    const totalBalance = num(balance.total_balance);
    const grantedBalance = num(balance.granted_balance);
    const toppedUpBalance = num(balance.topped_up_balance);
    if (totalBalance == null && grantedBalance == null && toppedUpBalance == null) return null;
    return {
      totalBalance,
      grantedBalance,
      toppedUpBalance,
      currency: typeof balance.currency === "string" ? balance.currency : "CNY",
      isAvailable: typeof json.is_available === "boolean" ? json.is_available : undefined,
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

type ToastApi = { showToast: (input: { body: { message: string; variant: "info" | "warning" | "error" } }) => Promise<void> };

async function notifyThreshold(
  api: { tui?: ToastApi },
  provider: string,
  pct: number,
  cost: number,
  limit: number | null,
): Promise<void> {
  if (!api?.tui?.showToast) return;
  try {
    await api.tui.showToast({
      body: {
        message: `${provider}: ${pct.toFixed(0)}% of limit used ($${cost.toFixed(2)} / $${limit})`,
        variant: pct >= 100 ? "error" : "warning",
      },
    });
  } catch {
    // toast may not be available in non-TUI mode
  }
}

async function tryShowToast(ctx: any, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  try {
    await ctx.tui.showToast({ body: { message, variant } });
  } catch {
    // TUI 不可用时静默失败
  }
}

const UsagePlugin: Plugin = async (ctx, rawOptions) => {
  const opts = (rawOptions || {}) as PluginOptions;
  const dataFile = join(homedir(), ".opencode", CONFIG.dataFileName);
  const data = loadData(dataFile);
  let unsaved = false;

  function markDirty() {
    unsaved = true;
  }

  const saveTimer = setInterval(() => {
    if (unsaved) {
      saveData(dataFile, data);
      unsaved = false;
    }
  }, CONFIG.saveIntervalMs);

  if ((ctx as any)?.tui?.showToast) {
    try {
      await (ctx as any).tui.showToast({
        body: {
          message: "oc-plugin-usage started",
          variant: "info",
        },
      });
    } catch {
      // toast may not be available in non-TUI mode
    }
  }

  if (opts.openaiApiKey) {
    const poll = async () => {
      const pu = await checkOpenAIUsage(opts.openaiApiKey!);
      if (!pu) return;
      data.providerUsage.openai = { ...data.providerUsage.openai, ...pu };
      markDirty();
      if (pu.limit != null && pu.cost != null && pu.limit > 0) {
        const pct = (pu.cost / pu.limit) * 100;
        if (crossedThreshold("openai.cost", pct, readThresholdFile())) {
          await notifyThreshold(ctx as any, "OpenAI", pct, pu.cost, pu.limit);
        }
      }
    };
    poll();
    setInterval(poll, CONFIG.providerCheckIntervalMs);
  }

  if (opts.anthropicApiKey) {
    const poll = async () => {
      const pu = await checkAnthropicUsage(opts.anthropicApiKey!);
      if (!pu) return;
      data.providerUsage.anthropic = pu;
      markDirty();
      if (pu.limit != null && pu.cost != null && pu.limit > 0) {
        const pct = (pu.cost / pu.limit) * 100;
        if (crossedThreshold("anthropic.cost", pct, readThresholdFile())) {
          await notifyThreshold(ctx as any, "Anthropic", pct, pu.cost, pu.limit);
        }
      }
    };
    poll();
    setInterval(poll, CONFIG.providerCheckIntervalMs);
  }

  const deepseekKey = opts.deepseekApiKey || readProviderKey("deepseek");
  if (deepseekKey) {
    const pollDeepSeek = async () => {
      const usage = await checkDeepSeekBalance(deepseekKey);
      if (!usage) return;
      const pu = data.providerUsage.deepseek || { lastChecked: new Date().toISOString() };
      pu.deepseek = usage;
      data.providerUsage.deepseek = pu;
      markDirty();
    };
    pollDeepSeek();
    setInterval(pollDeepSeek, CONFIG.providerCheckIntervalMs);
  }

  const trackedCosts = new Set<string>();

  if (!data.providerUsage["opencode-go"]?.goWindows) {
    const goKey = opts.goApiKey || readGoKeyFromAuth();
    if (goKey) {
      bootstrapGoHistory(ctx, data, trackedCosts).then(() => {
        markDirty();
      }).catch(() => {});
    }
  }

  const goKey = opts.goApiKey || readGoKeyFromAuth();
  if (goKey) {
    const pollGo = async () => {
      const goApi = await checkGoUsage(goKey!);
      if (!goApi) return;
      const go = data.providerUsage["opencode-go"] || { cost: 0, lastChecked: new Date().toISOString() };
      go.goApi = goApi;
      data.providerUsage["opencode-go"] = go;
      markDirty();
      for (const [name, w] of Object.entries({ "Rolling 5h": goApi.rolling, Weekly: goApi.weekly, Monthly: goApi.monthly })) {
        if (crossedThreshold(`go.${name}`, w.percent, readThresholdFile())) {
          await tryShowToast(ctx, `Go ${name}: ${w.percent.toFixed(0)}% used`, w.percent >= 100 ? "error" : "warning");
        }
      }
    };
    pollGo();
    setInterval(pollGo, CONFIG.providerCheckIntervalMs);
  }

  // ChatGPT 用量轮询（OAuth 登录，无需 API key）
  const pollChatGpt = async () => {
    const usage = await checkChatGPTUsage(opts.chatGptAccountId);
    if (!usage) return;
    const pu = data.providerUsage["openai"] || { lastChecked: new Date().toISOString() };
    pu.chatgpt = usage;
    data.providerUsage["openai"] = pu;
    markDirty();
    const windows: Record<string, GoApiWindow> = { "5h": usage.primary };
    if (usage.secondary) windows.Weekly = usage.secondary;
    for (const [name, w] of Object.entries(windows)) {
      if (crossedThreshold(`chatgpt.${name}`, w.percent, readThresholdFile())) {
        await tryShowToast(ctx, `ChatGPT ${name}: ${w.percent.toFixed(0)}% used`, w.percent >= 100 ? "error" : "warning");
      }
    }
  };
  pollChatGpt();
  setInterval(pollChatGpt, CONFIG.providerCheckIntervalMs);

  // TokenRhythm 账户数据轮询（需要浏览器会话 Cookie，未配置时跳过）
  const tokenRhythmCookie = readTokenRhythmCookie(opts);
  if (tokenRhythmCookie) {
    const pollTokenRhythm = async () => {
      // Cookie 文件可能被用户随时更新，每轮重新读取
      const cookie = readTokenRhythmCookie(opts);
      if (!cookie) return;
      const usage = await checkTokenRhythmUsage(cookie);
      if (!usage) return;
      // 合并写入，保留 message 事件累计的 cost 等字段
      const pu = data.providerUsage["tokenrhythm"] || { lastChecked: new Date().toISOString() };
      pu.tokenrhythm = usage;
      data.providerUsage["tokenrhythm"] = pu;
      markDirty();
    };
    pollTokenRhythm();
    setInterval(pollTokenRhythm, CONFIG.providerCheckIntervalMs);
  }

  const cleanupInterval = setInterval(() => {
    if (trackedCosts.size > 10000) trackedCosts.clear();
    const go = data.providerUsage["opencode-go"];
    if (go?.recentEvents && go.recentEvents.length > 100) {
      const sixHours = 6 * 60 * 60 * 1000;
      const old = Date.now() - sixHours;
      go.recentEvents = go.recentEvents.filter(e => e.time >= old);
      go.goWindows = calculateGoWindows(go);
      markDirty();
    }
  }, 3600000);

  const cleanup = () => {
    clearInterval(saveTimer);
    clearInterval(cleanupInterval);
    saveData(dataFile, data);
  };
  process.on("exit", cleanup);

  return {
    event: async ({ event }: { event: Event }) => {
      const today = ensureTodayStats(data);
      switch (event.type) {
        case "session.created":
          today.sessions++;
          tryShowToast(ctx, "新会话已开始 ✨");
          markDirty();
          break;
        case "session.error":
          today.errors++;
          markDirty();
          break;
        case "file.edited":
          today.filesEdited++;
          markDirty();
          break;
        case "tui.toast.show":
          today.toastsShown++;
          markDirty();
          break;
        case "tui.prompt.append":
          today.promptAppends++;
          markDirty();
          break;
        case "tui.command.execute":
          today.commandsExecuted++;
          markDirty();
          break;
        case "message.updated": {
          const msg = (event as any).properties.info;
          if (msg?.role === "assistant" && typeof msg.cost === "number" && msg.cost > 0 && !trackedCosts.has(msg.id)) {
            trackedCosts.add(msg.id);
            const pid = msg.providerID || "unknown";
            if (!data.providerUsage[pid]) {
              data.providerUsage[pid] = { cost: 0, lastChecked: new Date().toISOString() };
            }
            data.providerUsage[pid].cost = (data.providerUsage[pid].cost || 0) + msg.cost;
            data.providerUsage[pid].lastChecked = new Date().toISOString();

            if (pid === "opencode-go") {
              const go = data.providerUsage[pid];
              if (!go.dailyCosts) go.dailyCosts = {};
              const day = todayKey();
              go.dailyCosts[day] = (go.dailyCosts[day] || 0) + msg.cost;
              if (!go.recentEvents) go.recentEvents = [];
              go.recentEvents.push({ time: Date.now(), cost: msg.cost });
              if (go.recentEvents.length > 1000) {
                const sixHours = 6 * 60 * 60 * 1000;
                const old = Date.now() - sixHours;
                go.recentEvents = go.recentEvents.filter(e => e.time >= old);
              }
              go.goWindows = calculateGoWindows(go);
            }

            if (data.providerUsage[pid].goWindows) {
              const gw = data.providerUsage[pid].goWindows!;
              for (const [name, w] of Object.entries({ "Rolling 5h": gw.rolling5h, Weekly: gw.weekly, Monthly: gw.monthly })) {
                if (w.limit > 0) {
                  const pct = (w.cost / w.limit) * 100;
                  if (crossedThreshold(`go.${name}`, pct, readThresholdFile())) {
                    await notifyThreshold(ctx as any, `${DISPLAY_NAMES[pid] || pid} ${name}`, pct, w.cost, w.limit);
                  }
                }
              }
            } else if (data.providerUsage[pid].limit != null && data.providerUsage[pid].limit > 0) {
              const pct = ((data.providerUsage[pid].cost || 0) / data.providerUsage[pid].limit) * 100;
              if (crossedThreshold(`cost.${pid}`, pct, readThresholdFile())) {
                await notifyThreshold(ctx as any, DISPLAY_NAMES[pid] || pid, pct, data.providerUsage[pid].cost || 0, data.providerUsage[pid].limit);
              }
            }
            markDirty();
          }
          break;
        }
      }
    },
    "tool.execute.after": async (input: { tool?: string }) => {
      const today = ensureTodayStats(data);
      const name = input.tool ?? "unknown";
      today.toolCalls[name] = (today.toolCalls[name] ?? 0) + 1;
      markDirty();
    },
    tool: {
      usage_stats: tool({
        description:
          "Get AI model usage statistics including session counts, tool usage, file edits, " +
          "and provider API costs. Call this when the user asks about usage, consumption, tokens, costs, or quotas.",
        args: {
          period: tool.schema
            .enum(["today", "week", "month", "rolling", "all"])
            .describe("Time period for aggregation"),
        },
        async execute(args: { period?: Period }) {
          const period = args.period ?? "today";
          const stats = aggregate(data, period);
          const parts: string[] = [
            "╔══════════════════════════════════╗",
            "║     AI Model Usage Report        ║",
            "╚══════════════════════════════════╝",
            "",
            formatStats(stats, period),
          ];
          for (const [pid, pu] of Object.entries(data.providerUsage)) {
            parts.push("", formatProviderUsage(pu, DISPLAY_NAMES[pid] || pid));
          }
          parts.push("", `Last updated: ${data.lastUpdated}`);
          return parts.join("\n");
        },
      }),
    },
  };
};

export default UsagePlugin;
