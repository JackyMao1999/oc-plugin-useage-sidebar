import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG = {
  thresholdPercent: 80,
  saveIntervalMs: 30000,
  providerCheckIntervalMs: 300000,
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
  "opencode-go": "Go",
};

interface PluginOptions {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  goApiKey?: string;
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

function formatProviderUsage(pu: ProviderUsage, label: string): string {
  const lines: string[] = [`--- ${label} ---`];
  if (pu.goApi) {
    const fmt = (w: GoApiWindow) =>
      `${w.percent.toFixed(1)}% used${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString()})` : ""}`;
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
  const thresholdPct = opts.usageThresholdPercent ?? CONFIG.thresholdPercent;
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
      data.providerUsage.openai = pu;
      markDirty();
      if (pu.limit != null && pu.cost != null && pu.limit > 0) {
        const pct = (pu.cost / pu.limit) * 100;
        if (pct >= thresholdPct) {
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
        if (pct >= thresholdPct) {
          await notifyThreshold(ctx as any, "Anthropic", pct, pu.cost, pu.limit);
        }
      }
    };
    poll();
    setInterval(poll, CONFIG.providerCheckIntervalMs);
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
        if (w.percent >= thresholdPct) {
          await tryShowToast(ctx, `Go ${name}: ${w.percent.toFixed(0)}% used`, w.percent >= 100 ? "error" : "warning");
        }
      }
    };
    pollGo();
    setInterval(pollGo, CONFIG.providerCheckIntervalMs);
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
                  if (pct >= thresholdPct) {
                    await notifyThreshold(ctx as any, `${DISPLAY_NAMES[pid] || pid} ${name}`, pct, w.cost, w.limit);
                  }
                }
              }
            } else if (data.providerUsage[pid].limit != null && data.providerUsage[pid].limit > 0) {
              const pct = ((data.providerUsage[pid].cost || 0) / data.providerUsage[pid].limit) * 100;
              if (pct >= thresholdPct) {
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
