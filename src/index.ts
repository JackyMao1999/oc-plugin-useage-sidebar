import { Plugin } from "@opencode/plugin";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG = {
  // V2 的 TUI 侧边栏从同一个 JSON 文件读数据，写得太慢会导致切换供应商后长时间看不到新数据
  saveIntervalMs: 5000,
  providerCheckIntervalMs: 60000,
  dataFileName: "oc-plugin-usage-data.json",
};

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
  // 窗口长度（秒）。ChatGPT 的 wham/usage 用同一个 primary/secondary 字段返回不同
  // 粒度的窗口：18000=5h、604800=7d、2592000=30d，展示层据此选择标签。
  windowSeconds?: number;
}
interface GoApiUsage {
  rolling: GoApiWindow;
  weekly: GoApiWindow;
  monthly: GoApiWindow;
  lastChecked?: string;
}

interface ResponseMetrics {
  responses: number;
  ttftMsTotal: number;
  outputTokens: number;
  generationMsTotal: number;
}

interface ResponseState {
  sessionID?: string;
  providerID?: string;
  createdAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  outputTokens: number;
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
  responseMetrics?: ResponseMetrics;
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
// 窗口粒度不固定（5 小时 / 每周 / 月度，由 windowSeconds 决定），标签交给展示层推导
interface ChatGptUsage {
  planType?: string;
  primary: GoApiWindow;
  secondary?: GoApiWindow; // 部分账号（含免费/企业）只有单一窗口
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

// ============================================================================
// V2 凭证读取
// ----------------------------------------------------------------------------
// OpenCode V2 不再使用 ~/.local/share/opencode/auth.json：凭证存放在
// opencode.db 的 credential 表里，插件只能通过 ctx.integration.connection 读取。
// connection.resolve() 会在 access token 剩余有效期不足 5 分钟时，用
// integration 自己注册的 refresh 方法刷新并写回存储，所以插件不需要（也不应该）
// 自己刷新 OpenAI 的一次性 refresh token。
// ============================================================================

interface ProviderCredential {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  accountId?: string;
}

// provider 内部 ID → 可能的 integration ID（V2 里两者命名不一定一致）
const INTEGRATION_IDS: Record<string, string[]> = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  deepseek: ["deepseek"],
  "opencode-go": ["opencode-go", "opencode", "opencode-zen", "zen"],
};

function normalizeCredential(value: any): ProviderCredential | null {
  if (!value || typeof value !== "object") return null;
  const expires = Number(value.expires);
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
  return {
    type: typeof value.type === "string" ? value.type : undefined,
    access: typeof value.access === "string" && value.access ? value.access : undefined,
    refresh: typeof value.refresh === "string" && value.refresh ? value.refresh : undefined,
    expires: Number.isFinite(expires) ? expires : undefined,
    key: typeof value.key === "string" && value.key.trim() ? value.key.trim() : undefined,
    accountId: typeof metadata.accountID === "string" ? metadata.accountID : undefined,
  };
}

// V1 回退：老版本把凭证放在 auth.json。V2 下该文件通常不存在。
function readLegacyCredential(providerID: string): ProviderCredential | null {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    return normalizeCredential(auth?.[providerID]);
  } catch {
    return null;
  }
}

// 读取某个 provider 的当前凭证：V2 优先，读不到再回退 auth.json。
async function readCredential(ctx: any, providerID: string): Promise<ProviderCredential | null> {
  const connection = ctx?.integration?.connection;
  if (connection?.active && connection?.resolve) {
    for (const integrationID of INTEGRATION_IDS[providerID] ?? [providerID]) {
      try {
        const active = await connection.active(integrationID);
        if (!active) continue;
        const value = normalizeCredential(await connection.resolve(active));
        if (value) return value;
      } catch {
        // 该 integration 未登录 / 不可用，尝试下一个候选 ID
      }
    }
  }
  return readLegacyCredential(providerID);
}

function chatGptAccountHeaders(accountId?: string): Record<string, string> {
  const id = accountId?.trim();
  return id && id !== "personal" ? { "ChatGPT-Account-ID": id } : {};
}

// 查询 ChatGPT 用量（chatgpt.com 后台的 wham/usage，与 Codex Cloud 分析页同一数据源）。
// 返回的 primary/secondary 窗口粒度不固定：5 小时（18000s）、每周（604800s）、
// 月度（2592000s）都出现过，因此这里同时记录 limit_window_seconds，交给展示层决定标签。
async function checkChatGPTUsage(credential: ProviderCredential | null, accountId?: string): Promise<ChatGptUsage | null> {
  try {
    if (!credential || credential.type !== "oauth" || !credential.access) return null;
    // resolve() 已负责续期；此时仍然过期说明 opencode 侧刷新失败，等下一轮
    if (credential.expires != null && credential.expires < Date.now()) return null;

    const headers = {
      Authorization: `Bearer ${credential.access}`,
      ...chatGptAccountHeaders(accountId ?? credential.accountId),
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
      const resetAfter = Number(x.reset_after_seconds);
      const windowSeconds = Number(x.limit_window_seconds);
      const resetsAtMs = Number.isFinite(resetAt) && resetAt > 0
        ? resetAt * 1000
        : Number.isFinite(resetAfter) && resetAfter > 0
          ? Date.now() + resetAfter * 1000
          : undefined;
      return {
        status: typeof x.status === "string" ? x.status : undefined,
        percent,
        resetsAt: resetsAtMs != null ? new Date(resetsAtMs).toISOString() : undefined,
        windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : undefined,
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

function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// 由窗口长度推断标签：5 小时 / 24 小时 / 每周 / 每月。
// OpenAI 的 wham/usage 用同一组 primary/secondary 字段返回不同粒度的窗口
// （免费/企业账号是月度，Plus/Pro 是 5h + 每周），不能写死。
function windowLabel(w: GoApiWindow): string {
  const s = w.windowSeconds;
  if (!s || !Number.isFinite(s)) return "5h";
  if (s <= 6 * 3600) return "5h";
  if (s <= 2 * 86400) return "24h";
  if (s <= 10 * 86400) return "weekly";
  if (s <= 45 * 86400) return "monthly";
  return `${Math.round(s / 86400)}d`;
}

function formatProviderUsage(pu: ProviderUsage, label: string): string {
  const lines: string[] = [`--- ${label} ---`];
  const fmtPct = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (pu.chatgpt) {
    const fmt = (w: GoApiWindow) =>
      `${fmtPct(w.percent)}% used${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString()})` : ""}`;
    if (pu.chatgpt.planType) lines.push(`  Plan:       ${pu.chatgpt.planType}`);
    lines.push(`  ${windowLabel(pu.chatgpt.primary).padEnd(10)} ${fmt(pu.chatgpt.primary)}`);
    if (pu.chatgpt.secondary) {
      lines.push(`  ${windowLabel(pu.chatgpt.secondary).padEnd(10)} ${fmt(pu.chatgpt.secondary)}`);
    }
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
  if (pu.responseMetrics?.responses) {
    const metrics = pu.responseMetrics;
    const avgTtft = metrics.ttftMsTotal / metrics.responses;
    lines.push(`  Avg TTFT:   ${formatDurationMs(avgTtft)}`);
    if (metrics.outputTokens > 0 && metrics.generationMsTotal > 0) {
      const tokensPerSecond = metrics.outputTokens / (metrics.generationMsTotal / 1000);
      lines.push(`  Avg TPS:     ${tokensPerSecond.toFixed(1)} tokens/s`);
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

const UsagePlugin = Plugin.define({
  id: "oc-plugin-usage",
  async setup(ctx) {
  const opts = (ctx.options || {}) as PluginOptions;
  const dataFile = join(homedir(), ".opencode", CONFIG.dataFileName);
  const data = loadData(dataFile);
  let unsaved = false;

  const intervals: ReturnType<typeof setInterval>[] = [];
  const addInterval = (callback: () => void, delay: number) => {
    const timer = setInterval(callback, delay);
    intervals.push(timer);
    return timer;
  };

  function markDirty() {
    unsaved = true;
  }

  addInterval(() => {
    if (unsaved) {
      saveData(dataFile, data);
      unsaved = false;
    }
  }, CONFIG.saveIntervalMs);

  if (opts.openaiApiKey) {
    const poll = async () => {
      const pu = await checkOpenAIUsage(opts.openaiApiKey!);
      if (!pu) return;
      data.providerUsage.openai = { ...data.providerUsage.openai, ...pu };
      markDirty();
    };
    poll();
    addInterval(() => { void poll(); }, CONFIG.providerCheckIntervalMs);
  }

  if (opts.anthropicApiKey) {
    const poll = async () => {
      const pu = await checkAnthropicUsage(opts.anthropicApiKey!);
      if (!pu) return;
      data.providerUsage.anthropic = { ...data.providerUsage.anthropic, ...pu };
      markDirty();
    };
    poll();
    addInterval(() => { void poll(); }, CONFIG.providerCheckIntervalMs);
  }

  const deepseekKey = opts.deepseekApiKey || (await readCredential(ctx, "deepseek"))?.key || null;
  if (deepseekKey) {
    const pollDeepSeek = async () => {
      // 每轮重新读取：用户在 opencode 里重新登录后无需重启插件
      const key = opts.deepseekApiKey || (await readCredential(ctx, "deepseek"))?.key;
      if (!key) return;
      const usage = await checkDeepSeekBalance(key);
      if (!usage) return;
      const pu = data.providerUsage.deepseek || { lastChecked: new Date().toISOString() };
      pu.deepseek = usage;
      data.providerUsage.deepseek = pu;
      markDirty();
    };
    pollDeepSeek();
    addInterval(() => { void pollDeepSeek(); }, CONFIG.providerCheckIntervalMs);
  }

  const responseStates = new Map<string, ResponseState>();
  const trackedResponses = new Set<string>();
  const sessionModels = new Map<string, string>();
  const sessionCosts = new Map<string, number>();
  const sessionTokens = new Map<string, number>();

  const finiteTimestamp = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const ensureResponseState = (messageID: string, sessionID?: string) => {
    const existing = responseStates.get(messageID);
    if (existing) {
      if (sessionID) existing.sessionID = sessionID;
      return existing;
    }
    const state: ResponseState = { sessionID, outputTokens: 0 };
    responseStates.set(messageID, state);
    return state;
  };

  const recordResponseMetrics = (messageID: string) => {
    if (trackedResponses.has(messageID)) return;
    const state = responseStates.get(messageID);
    if (!state || !state.providerID || state.createdAt == null || state.firstTokenAt == null || state.completedAt == null) return;

    const ttftMs = state.firstTokenAt - state.createdAt;
    const generationMs = state.completedAt - state.firstTokenAt;
    if (!Number.isFinite(ttftMs) || ttftMs < 0 || !Number.isFinite(generationMs) || generationMs <= 0) return;

    const pu = data.providerUsage[state.providerID] || { lastChecked: new Date().toISOString() };
    const metrics = pu.responseMetrics || (pu.responseMetrics = {
      responses: 0,
      ttftMsTotal: 0,
      outputTokens: 0,
      generationMsTotal: 0,
    });
    metrics.responses += 1;
    metrics.ttftMsTotal += ttftMs;
    if (state.outputTokens > 0) {
      metrics.outputTokens += state.outputTokens;
      metrics.generationMsTotal += generationMs;
    }
    pu.lastChecked = new Date().toISOString();
    data.providerUsage[state.providerID] = pu;
    trackedResponses.add(messageID);
    responseStates.delete(messageID);
    markDirty();
  };

  const goKey = opts.goApiKey || (await readCredential(ctx, "opencode-go"))?.key || null;
  if (goKey) {
    const pollGo = async () => {
      const key = opts.goApiKey || (await readCredential(ctx, "opencode-go"))?.key;
      if (!key) return;
      const goApi = await checkGoUsage(key);
      if (!goApi) return;
      const go = data.providerUsage["opencode-go"] || { cost: 0, lastChecked: new Date().toISOString() };
      go.goApi = goApi;
      data.providerUsage["opencode-go"] = go;
      markDirty();
    };
    void pollGo();
    addInterval(() => { void pollGo(); }, CONFIG.providerCheckIntervalMs);
  }

  // ChatGPT / Codex 用量轮询（读取 V2 的 openai OAuth 凭证，无需 API key）
  const pollChatGpt = async () => {
    // 每轮重新 resolve：opencode 会在 token 临近过期时刷新并写回存储
    const credential = await readCredential(ctx, "openai");
    const usage = await checkChatGPTUsage(credential, opts.chatGptAccountId);
    if (!usage) return;
    const pu = data.providerUsage["openai"] || { lastChecked: new Date().toISOString() };
    pu.chatgpt = usage;
    data.providerUsage["openai"] = pu;
    markDirty();
  };
  void pollChatGpt();
  addInterval(() => { void pollChatGpt(); }, CONFIG.providerCheckIntervalMs);

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
    void pollTokenRhythm();
    addInterval(() => { void pollTokenRhythm(); }, CONFIG.providerCheckIntervalMs);
  }

  addInterval(() => {
    if (trackedResponses.size > 10000) trackedResponses.clear();
    if (responseStates.size > 10000) responseStates.clear();
    const go = data.providerUsage["opencode-go"];
    if (go?.recentEvents && go.recentEvents.length > 100) {
      const sixHours = 6 * 60 * 60 * 1000;
      const old = Date.now() - sixHours;
      go.recentEvents = go.recentEvents.filter(e => e.time >= old);
      go.goWindows = calculateGoWindows(go);
      markDirty();
    }
  }, 3600000);

  const addProviderCost = (providerID: string, cost: number, timestamp: number) => {
    if (!Number.isFinite(cost) || cost <= 0) return;
    const pu = data.providerUsage[providerID] || { cost: 0, lastChecked: new Date().toISOString() };
    pu.cost = (pu.cost || 0) + cost;
    pu.lastChecked = new Date(timestamp).toISOString();
    if (providerID === "opencode-go") {
      pu.dailyCosts ??= {};
      const day = new Date(timestamp).toISOString().slice(0, 10);
      pu.dailyCosts[day] = (pu.dailyCosts[day] || 0) + cost;
      pu.recentEvents ??= [];
      pu.recentEvents.push({ time: timestamp, cost });
      if (pu.recentEvents.length > 1000) {
        const old = Date.now() - 6 * 60 * 60 * 1000;
        pu.recentEvents = pu.recentEvents.filter((event) => event.time >= old);
      }
      pu.goWindows = calculateGoWindows(pu);
    }
    data.providerUsage[providerID] = pu;
  };

  const updateSessionUsage = (event: any) => {
    const usage = event?.data;
    const sessionID = typeof usage?.sessionID === "string" ? usage.sessionID : undefined;
    if (!sessionID) return;

    // session.usage.updated contains the cumulative usage for a session. The
    // event does not carry a model reference, so keep the model selected by
    // session.created/session.model.selected/session.step.started above.
    const providerID = sessionModels.get(sessionID) || "unknown";

    const currentCost = Number(usage.cost);
    const previousCost = sessionCosts.get(sessionID) || 0;
    if (Number.isFinite(currentCost) && currentCost >= previousCost) {
      sessionCosts.set(sessionID, currentCost);
      addProviderCost(providerID, currentCost - previousCost, finiteTimestamp(event.created) ?? Date.now());
    }

    const tokens = usage.tokens;
    if (tokens && typeof tokens === "object") {
      const currentTokens = [tokens.input, tokens.output, tokens.reasoning]
        .map(Number)
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + value, 0);
      const previousTokens = sessionTokens.get(sessionID) || 0;
      if (currentTokens >= previousTokens) {
        sessionTokens.set(sessionID, currentTokens);
        const pu = data.providerUsage[providerID] || { lastChecked: new Date().toISOString() };
        pu.totalTokens = (pu.totalTokens || 0) + currentTokens - previousTokens;
        data.providerUsage[providerID] = pu;
      }
    }
    markDirty();
  };

  const updateResponseFromStep = (event: any) => {
    const usage = event?.data;
    const sessionID = typeof usage?.sessionID === "string" ? usage.sessionID : undefined;
    const messageID = typeof usage?.assistantMessageID === "string" ? usage.assistantMessageID : undefined;
    if (!sessionID || !messageID) return;

    const state = ensureResponseState(messageID, sessionID);
    state.providerID ??= sessionModels.get(sessionID);
    const outputTokens = Number(usage.tokens?.output);
    if (Number.isFinite(outputTokens) && outputTokens >= 0) {
      state.outputTokens = outputTokens;
    }
    state.completedAt = finiteTimestamp(event.created) ?? Date.now();
    recordResponseMetrics(messageID);
  };

  const finalizeSessionResponses = (sessionID: string, completedAt: number) => {
    for (const [messageID, state] of responseStates) {
      if (state.sessionID !== sessionID || trackedResponses.has(messageID)) continue;
      state.completedAt = completedAt;
      recordResponseMetrics(messageID);
    }
  };

  const handleEvent = (event: any) => {
    const today = ensureTodayStats(data);
    const payload = event?.data ?? event?.properties ?? {};
    const timestamp = finiteTimestamp(event?.created) ?? Date.now();

    switch (event?.type) {
      case "session.created":
        today.sessions++;
        if (payload.model?.providerID) sessionModels.set(payload.sessionID, payload.model.providerID);
        markDirty();
        break;
      case "session.model.selected":
        if (payload.sessionID && payload.model?.providerID) sessionModels.set(payload.sessionID, payload.model.providerID);
        break;
      case "session.step.started": {
        const messageID = payload.assistantMessageID;
        const sessionID = payload.sessionID;
        if (sessionID && payload.model?.providerID) sessionModels.set(sessionID, payload.model.providerID);
        if (messageID && sessionID) {
          const state = ensureResponseState(messageID, sessionID);
          state.providerID = payload.model?.providerID || sessionModels.get(sessionID);
          state.createdAt = finiteTimestamp(payload.started) ?? timestamp;
        }
        break;
      }
      case "session.text.delta":
        if (payload.assistantMessageID && typeof payload.delta === "string" && payload.delta.length > 0) {
          const state = ensureResponseState(payload.assistantMessageID, payload.sessionID);
          state.firstTokenAt ??= timestamp;
        }
        break;
      case "session.text.ended":
        if (payload.assistantMessageID) ensureResponseState(payload.assistantMessageID, payload.sessionID);
        break;
      case "session.step.ended":
        updateResponseFromStep(event);
        break;
      case "session.step.failed":
        updateResponseFromStep(event);
        break;
      case "session.usage.updated":
        updateSessionUsage(event);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle":
        if (payload.sessionID) finalizeSessionResponses(payload.sessionID, timestamp);
        if (event.type === "session.execution.failed") today.errors++;
        markDirty();
        break;
      case "filesystem.changed":
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
    }
  };

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        handleEvent(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("oc-plugin-usage event stream stopped", error);
    }
  })();

  await ctx.tool.hook("execute.after", (event) => {
    const today = ensureTodayStats(data);
    const name = event.tool || "unknown";
    today.toolCalls[name] = (today.toolCalls[name] ?? 0) + 1;
    markDirty();
  });

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "usage_stats",
      description:
        "Get AI model usage statistics including session counts, tool usage, file edits, " +
        "response latency, output speed, and provider API costs. Call this when the user asks about usage, consumption, tokens, costs, or quotas.",
      input: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["today", "week", "month", "rolling", "all"],
            description: "Time period for aggregation",
          },
        },
        additionalProperties: false,
      },
      async execute(input) {
        const requested = (input as { period?: string })?.period;
        const period: Period = ["today", "week", "month", "rolling", "all"].includes(requested || "")
          ? requested as Period
          : "today";
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
        return { content: parts.join("\n") };
      },
    });
  });

  return () => {
    controller.abort();
    for (const timer of intervals) clearInterval(timer);
    saveData(dataFile, data);
  };
  },
});

export default UsagePlugin;
