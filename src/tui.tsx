/**
 * TUI 侧边栏插件 — oc-plugin-usage 的 UI 部分
 * ===========================================
 * 
 * 这个文件的用途：
 *   在 opencode 终端界面（TUI）的右侧栏中显示一个 "Usage" 面板，
 *   展示 AI 模型的使用统计数据（会话数、工具调用、费用等）。
 *
 * 它是怎么被加载的：
 *   在 tui.json 中配置了这个文件的路径后，opencode 启动时会自动加载并运行它。
 *
 * 和 index.ts（Server 插件）的关系：
 *   - index.ts  负责"收集数据"：监听事件，把用量写入 JSON 文件
 *   - tui.tsx   负责"展示数据"：读取 JSON 文件，渲染到侧边栏
 *   两者通过同一个 JSON 文件（~/.opencode/oc-plugin-usage-data.json）交换数据
 *
 * 技术栈：
 *   - SolidJS  ：前端框架（类似 React），处理 UI 和数据绑定
 *   - @opentui/solid ：opencode 自己的 UI 组件库（box, text, Show, For 等）
 *   - TypeScript .tsx ：支持写 HTML 标签的 TypeScript
 *
 * 如果你是完全的初学者，建议按以下顺序阅读：
 *   1. 先看"接口定义"部分，理解数据结构
 *   2. 再看"工具函数"部分，理解数据怎么处理
 *   3. 看 UsageSidebar 组件，理解 UI 怎么渲染
 *   4. 最后看底部的插件注册部分
 */

// ============================================================================
// 文件头部
// ============================================================================

// @jsxImportSource 告诉 TypeScript: "当我写 <box> 这样的 HTML 标签时，
// 请用 @opentui/solid 这个库来翻译成 JavaScript 代码"
/** @jsxImportSource @opentui/solid */

// -------- 导入 OpenCode TUI 插件需要的类型 --------
// TuiPlugin   : TUI 插件函数的标准类型（用来写 async (api) => { ... } 的函数签名）
// TuiPluginModule : 插件模块的导出格式（必须导出 { id, tui } 这样的对象）
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// -------- 导入 SolidJS 的核心功能 --------
// createSignal : 创建一个"可变化的值"（类似 React 的 useState）
//                例：const [count, setCount] = createSignal(0)
//                count() 读取值，setCount(1) 修改值
// createMemo   : 创建一个"计算结果"（类似缓存，依赖的数据变了就自动重算）
//                例：const doubled = createMemo(() => count() * 2)
// For          : 循环渲染组件（类似 React 的 .map()）
//                <For each={列表}>{元素 => <div>{元素}</div>}</For>
// Show         : 条件渲染（类似 React 的 {条件 && <div>}）
//                <Show when={条件}><div>...</div></Show>
// onCleanup    : 注册一个函数，在组件销毁时执行（清理定时器、取消订阅等）
import { createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js"

// -------- 导入 Node.js 内置模块 --------
// readFileSync : 同步读取文件内容（返回字符串或 Buffer）
// existsSync   : 检查文件是否存在（返回 true/false）
// writeFileSync : 同步写入文件
import { readFileSync, writeFileSync, existsSync } from "fs"

// join         : 拼接文件路径（跨平台兼容）
//               例：join("/home/user", ".opencode", "data.json") → "/home/user/.opencode/data.json"
import { join } from "path"

// homedir      : 获取当前用户的家目录路径
//               例：homedir() → "/home/ubuntu"
import { homedir } from "os"


// ============================================================================
// 常量
// ============================================================================

// 数据文件的完整路径
// 例：/home/ubuntu/.opencode/oc-plugin-usage-data.json
// Server 插件（index.ts）把用量数据写入这个文件，TUI 插件从这里读取
const DATA_FILE = join(homedir(), ".opencode", "oc-plugin-usage-data.json")

// 阈值配置文件（调整快捷键见下方 thresholdKeyHint）
const CONFIG_FILE = join(homedir(), ".opencode", "oc-plugin-usage-config.json")

// 读取用量提醒阈值（%）：文件（手动调整） > 默认 80
function readThresholdFile(): number {
  try {
    if (existsSync(CONFIG_FILE)) {
      const n = Number(JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))?.usageThresholdPercent)
      if (Number.isFinite(n) && n > 0 && n <= 100) return n
    }
  } catch {
    // 文件损坏时用默认值
  }
  return 80
}

// 写入用量提醒阈值（%）
function writeThresholdFile(percent: number) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({ usageThresholdPercent: percent }, null, 2))
  } catch {
    // 写入失败时静默忽略（下次调整时重试）
  }
}

// fmtPct: 百分比格式化 —— 整数不带小数点（API 返回整数时避免假的 ".0"），
// 有小数时保留 1 位（如 12% / 12.3%）
function fmtPct(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function fmtCredits(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

// fmtMoney: 货币格式化 —— CNY 用 ¥ 前缀，其他币种显示在数值后面（如 "12.34 USD"）
function fmtMoney(n: number, currency?: string): string {
  const v = n.toFixed(2)
  return !currency || currency === "CNY" ? `¥${v}` : `${v} ${currency}`
}

// 已提醒过的百分比（跨组件共享，状态栏组件负责检查）
//   只在"跨越阈值"时提醒一次，避免每轮刷新都弹：
//   1. 首次达到阈值 → 提醒
//   2. 比上次提醒高了 ≥5 个百分点 → 提醒（50→55→60… 逐步升级）
//   3. 上次提醒时还没到阈值（阈值被调低了）→ 提醒
const lastNotified = new Map<string, number>()
function crossedThreshold(key: string, pct: number, threshold: number): boolean {
  const last = lastNotified.get(key)
  if (pct < threshold) return false
  if (last === undefined || last < threshold || pct >= last + 5) {
    lastNotified.set(key, pct)
    return true
  }
  return false
}

// 当前会话正在使用的提供商（只会有一个）
//   /models 选中的模型记录在最近一条 user message 的 info.model.providerID；
//   assistant 的 providerID 是实际传输层 provider，不能作为模型归属
function getActiveProviderId(api: any, sessionId?: string): string | undefined {
  if (!api?.state?.ready || !sessionId) return undefined
  try {
    const msgs = api.state.session.messages(sessionId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i]?.info ?? msgs[i]
      if (info.role === "user" && info.model?.providerID) {
        return info.model.providerID
      }
    }
  } catch {
    // 会话尚未加载完时忽略
  }
  return undefined
}


// ============================================================================
// 接口定义（TypeScript 的类型定义，描述数据的"形状"）
// ============================================================================

// GoWindow: OpenCode Go 的一个"时间窗口"数据
// Go 订阅有 3 个时间窗口限制：
//   - rolling5h：最近 5 小时的费用（限额 $12）
//   - weekly    ：最近 7 天的费用（限额 $30）
//   - monthly   ：最近 30 天的费用（限额 $60）
interface GoWindow {
  cost: number       // 此窗口内的总费用（美元）
  limit: number      // 此窗口的限额（美元）
  remaining: number  // 剩余可用额度（limit - cost）
}

// GoWindows: Go 的三个时间窗口汇总
interface GoWindows {
  rolling5h: GoWindow
  weekly: GoWindow
  monthly: GoWindow
}

// GoApiWindow: 官方 /zen/go/v1/usage API 返回的时间窗口
//   percent  : 已用百分比（和 opencode.ai 工作台一致）
//   resetsAt : 重置时间（ISO 格式）
interface GoApiWindow {
  status?: string
  percent: number
  resetsAt?: string
}

// GoApiUsage: 官方 API 的三个窗口汇总
interface GoApiUsage {
  rolling: GoApiWindow
  weekly: GoApiWindow
  monthly: GoApiWindow
  lastChecked?: string
}

// ChatGptUsage: ChatGPT (chatgpt.com) 用量 —— 来自 backend-api/wham/usage
//   primary   : 5 小时窗口
//   secondary : 每周窗口
//   credits   : 剩余 Credits
interface ChatGptUsage {
  planType?: string
  primary: GoApiWindow
  secondary?: GoApiWindow
  credits?: number
  creditUsage?: ChatGptCreditUsage
  lastChecked?: string
}

interface CreditUsageBreakdown {
  codex: number
  work: number
  total: number
}

interface ChatGptCreditUsage {
  daily: Record<string, CreditUsageBreakdown>
  last7Days: CreditUsageBreakdown
  lastChecked?: string
}

// ProviderUsage: 一个 AI 服务提供商的使用数据
// 例如 "openai"（OpenAI）、"anthropic"（Anthropic）、"opencode-go"（Go）
// 问号（?）表示这个字段可以不存在（可选字段）
interface ProviderUsage {
  cost?: number                                           // 总费用
  limit?: number | null                                    // 限额（null 表示无限额）
  remaining?: number                                       // 剩余额度
  totalTokens?: number                                     // 总 token 数
  lastChecked?: string                                     // 最后一次查询时间（ISO 格式）
  dailyCosts?: Record<string, number>                      // 按天汇总的费用 { "2026-07-18": 8.5, "2026-07-17": 6.2 }
  recentEvents?: Array<{ time: number; cost: number }>    // 最近的事件列表（用于计算 rolling 5h）
  goWindows?: GoWindows                                    // Go 的三窗口数据（只有 Go provider 会有）
  goApi?: GoApiUsage                                       // Go 官方 API 数据（percent + resetsAt）
  chatgpt?: ChatGptUsage                                   // ChatGPT 用量数据（wham/usage）
  tokenrhythm?: TokenRhythmUsage                           // TokenRhythm 账户数据（钱包 + 用量汇总）
}

// TokenRhythmUsage: TokenRhythm（tokenrhythm.studio）账户数据
// 来自 /api/wallet/summary 和 /api/usage-summary，与账户页"实际可用总额/总成本"同源
interface TokenRhythmUsage {
  availableBalance?: number  // 实际可用总额（CNY）
  currency?: string          // 币种，默认 CNY
  totalCost?: number         // 累计成本（已产生费用，CNY）
  calls?: number             // 累计调用次数
  authExpired?: boolean      // Cookie 失效（401），数据为旧值
  lastChecked?: string
}

// DayStats: 某一天的使用统计
interface DayStats {
  date: string                        // 日期，如 "2026-07-18"
  sessions: number                    // 这一天创建的会话数
  toolCalls: Record<string, number>   // 工具调用次数表，{ "read": 42, "bash": 31 }
  filesEdited: number                 // 文件编辑次数
  errors: number                      // 错误次数
  toastsShown: number                 // 提示弹出次数
  promptAppends: number               // 提示追加次数
  commandsExecuted: number            // 命令执行次数
}

// UsageData: 插件的完整数据（会保存到 JSON 文件）
// 这个结构决定了一个对象里嵌套了哪些子对象
interface UsageData {
  lastUpdated: string                          // 数据最后更新时间
  startDate: string                            // 数据记录的起始日期
  totals: {                                    // 累计总数（从 startDate 开始）
    sessions: number
    toolCalls: number
    filesEdited: number
    errors: number
    toastsShown: number
    promptAppends: number
    commandsExecuted: number
  }
  byDate: Record<string, DayStats>             // 按日期分组的数据，key 是 "YYYY-MM-DD"
  providerUsage: Record<string, ProviderUsage> // 按 provider 分组的数据，key 是 provider 名称
}


// ============================================================================
// 工具函数（纯函数，处理数据计算）
// ============================================================================

/**
 * 从 JSON 文件加载数据
 * 如果文件不存在或内容损坏，返回一个空的默认数据
 */
function loadData(): UsageData {
  try {
    if (existsSync(DATA_FILE)) {
      // existsSync 检查文件存不存在
      // readFileSync 读取文件内容（UTF-8 编码）
      // JSON.parse 把 JSON 字符串转成 JavaScript 对象
      return JSON.parse(readFileSync(DATA_FILE, "utf-8"))
    }
  } catch {
    // 如果文件损坏（JSON 格式错误），catch 住异常，继续往下执行
  }
  // 文件不存在或损坏 → 返回一个"空"的默认数据
  return {
    lastUpdated: new Date().toISOString(),
    startDate: "",
    totals: { sessions: 0, toolCalls: 0, filesEdited: 0, errors: 0, toastsShown: 0, promptAppends: 0, commandsExecuted: 0 },
    byDate: {},
    providerUsage: {},
  }
}


// ============================================================================
// 显示名称映射
// ============================================================================
// provider 的内部 ID（如 "opencode-go"）和显示名称（如 "Go"）的对应关系
const DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  opencode: "Zen",
  "opencode-go": "Go",
}

// ============================================================================
// 国际化（i18n）
// ============================================================================

// 界面语言：可通过 tui.json 的插件选项配置，例如：
//   { "plugin": [["/path/to/oc-plugin-usage/src/tui.tsx", { "language": "zh" }]] }
type Lang = "en" | "zh"

interface Strings {
  usage: string
  sessionCache: string
  hitRate: string
  input: string
  read: string
  write: string
  noTurns: string
  providers: string
  noneConfigured: string
  rolling5h: string
  weekly: string
  monthly: string
  resets: string
  used: string
  cost: string
  left: string
  tokens: string
  updated: string
  inUse: string
  configured: string
  notConfigured: string
  noActiveProvider: string
  plan: string
  balance: string
  creditsSpent: string
  codexCredits: string
  workCredits: string
  availBalance: string
  totalCost: string
  calls: string
  cookieExpired: string
  threshold: string
  adjustThreshold: string
  setThresholdTitle: string
  setThresholdDesc: (current: number) => string
  invalidThreshold: string
  thresholdSet: (n: number) => string
  alertTitle: string
  alertMessage: (name: string, pct: number, threshold: number) => string
}

function makeStrings(lang: Lang): Strings {
  return lang === "zh"
    ? {
        usage: "用量",
        sessionCache: "会话缓存",
        hitRate: "命中率",
        input: "输入",
        read: "缓存读取",
        write: "缓存写入",
        noTurns: "暂无助手回复",
        providers: "提供商",
        noneConfigured: "未配置",
        rolling5h: "最近5小时",
        weekly: "本周",
        monthly: "本月",
        resets: "重置",
        used: "已用",
        cost: "费用",
        left: "剩余",
        tokens: "Token数",
        updated: "更新",
        inUse: "使用中",
        configured: "已配置",
        notConfigured: "未配置",
        noActiveProvider: "未检测到使用中的提供商",
        plan: "计划",
        balance: "Credits余额",
        creditsSpent: "近7天 Credits",
        codexCredits: "Codex Credits",
        workCredits: "Work Credits",
        availBalance: "实际可用总额",
        totalCost: "累计成本",
        calls: "调用次数",
        cookieExpired: "Cookie 已过期，请更新 tokenrhythm-cookie.txt",
        threshold: "提醒阈值",
        adjustThreshold: "调整阈值",
        setThresholdTitle: "设置用量提醒阈值 (%)",
        setThresholdDesc: (current: number) => `当前阈值 ${current}%。达到或超过该百分比时提醒（系统通知 + 声音）。`,
        invalidThreshold: "请输入 1~100 之间的数字",
        thresholdSet: (n: number) => `用量提醒阈值已设为 ${n}%`,
        alertTitle: "AI 用量提醒",
        alertMessage: (name: string, pct: number, threshold: number) =>
          `${name}：已用 ${pct.toFixed(0)}%（提醒阈值 ${threshold}%）`,
      }
    : {
        usage: "Usage",
        sessionCache: "Session Cache",
        hitRate: "Hit rate",
        input: "Input",
        read: "Read",
        write: "Write",
        noTurns: "No assistant turns yet",
        providers: "Providers",
        noneConfigured: "None configured",
        rolling5h: "Rolling 5h",
        weekly: "Weekly",
        monthly: "Monthly",
        resets: "Resets",
        used: "Used",
        cost: "Cost",
        left: "Left",
        tokens: "Tokens",
        updated: "Updated",
        inUse: "In use",
        configured: "Configured",
        notConfigured: "Not configured",
        noActiveProvider: "No provider in use",
        plan: "Plan",
        balance: "Credits balance",
        creditsSpent: "Credits (7d)",
        codexCredits: "Codex Credits",
        workCredits: "Work Credits",
        availBalance: "Available",
        totalCost: "Total cost",
        calls: "Calls",
        cookieExpired: "Cookie expired, update tokenrhythm-cookie.txt",
        threshold: "Alert threshold",
        adjustThreshold: "Adjust threshold",
        setThresholdTitle: "Set usage alert threshold (%)",
        setThresholdDesc: (current: number) => `Current threshold: ${current}%. Notify (system notification + sound) when usage reaches or exceeds it.`,
        invalidThreshold: "Enter a number between 1 and 100",
        thresholdSet: (n: number) => `Alert threshold set to ${n}%`,
        alertTitle: "AI usage alert",
        alertMessage: (name: string, pct: number, threshold: number) =>
          `${name}: ${pct.toFixed(0)}% used (threshold ${threshold}%)`,
      }
}

// ============================================================================
// 热门提供商元数据（品牌色徽标 + 图标字符，模拟 logo 效果）
// ============================================================================

interface ProviderMeta {
  id: string        // provider 的内部 ID（auth.json / 消息里的 providerID）
  name: string      // 显示名称
  color: string     // 品牌色（徽标颜色）
  glyph: string     // 图标字符（终端里代替 logo）
}

const PROVIDER_META: ProviderMeta[] = [
  { id: "opencode-go", name: "opencode", color: "#3b82f6", glyph: "◆" },
  { id: "opencode", name: "Zen", color: "#8b5cf6", glyph: "◈" },
  { id: "openai", name: "OpenAI", color: "#10a37f", glyph: "●" },
  { id: "anthropic", name: "Claude", color: "#d97757", glyph: "◉" },
  { id: "google", name: "Gemini", color: "#4285f4", glyph: "◆" },
  { id: "codex", name: "Codex", color: "#64748b", glyph: "✦" },
  { id: "xai", name: "Grok", color: "#e2e8f0", glyph: "✧" },
  { id: "deepseek", name: "DeepSeek", color: "#4f46e5", glyph: "❖" },
  { id: "zhipuai", name: "GLM", color: "#2563eb", glyph: "❖" },
  { id: "siliconflow-cn", name: "SiliconFlow", color: "#0891b2", glyph: "❖" },
  { id: "tokenrhythm", name: "TokenRhythm", color: "#06b6d4", glyph: "⬢" },
]


// ============================================================================
// UsageSidebar 组件 — 侧边栏的核心 UI
// ============================================================================

/**
 * UsageSidebar 是侧边栏面板的主组件
 *
 * 它接收一个 props 参数，其中 api 是 opencode 提供的 TUI API 对象，
 * 通过 api 可以访问：
 *   - api.theme.current : 当前主题的颜色配置（文字颜色、背景色等）
 *   - api.state.session : 当前会话的数据
 *   - api.client        : opencode 的 SDK 客户端（可以调用 API）
 *
 * 组件渲染的 UI 结构（从上到下）：
 *   ▼ Usage（总开关）
 *     ▼ Session Cache ← 当前会话的缓存命中率
 *     ▼ Providers     ← OpenAI/Anthropic/Go/Zen 的费用和进度条
 */
function UsageSidebar(props: { api: any; sessionId?: string; lang?: Lang }) {
  // t : 当前语言的界面文案（en 或 zh，由 tui.json 的 language 选项控制）
  const t = makeStrings(props.lang ?? "en")

  // -------- 响应式状态（SolidJS 的 createSignal） --------
  // createSignal 返回一个 [getter, setter] 对
  // 例：const [count, setCount] = createSignal(0)
  //     count() 读取当前值
  //     setCount(5) 设置新值（会触发 UI 自动更新）

  // data       : 从 JSON 文件加载的完整用量数据
  //              每 30 秒自动重新读取一次
  const [data, setData] = createSignal(loadData())

  // 以下 3 个状态控制各个区域的折叠/展开
  // true = 展开（可见）, false = 折叠（隐藏）
  const [open, setOpen] = createSignal(true)              // Usage 总标题
  const [openCache, setOpenCache] = createSignal(true)    // Session Cache 区域（默认展开）
  const [openProviders, setOpenProviders] = createSignal(true) // Providers 区域（默认展开）

  // goApi：官方 /zen/go/v1/usage API 的实时数据（每 1 分钟刷新）
  const [goApi, setGoApi] = createSignal<GoApiUsage | null>(null)

  // goUpdated：最近一次成功拉取官方 API 的时间戳（用于"更新"显示）
  const [goUpdated, setGoUpdated] = createSignal<number | null>(null)

  // threshold：用量提醒阈值（%），从配置文件读取；每 30 秒随数据一起刷新
  const [threshold, setThreshold] = createSignal(readThresholdFile())

  // thresholdKeyHint：调整阈值的快捷键提示
  //  Ctrl+O 在任意终端都有独立编码，不会被系统/终端拦截（Ctrl+Shift+U 在 Ubuntu/GNOME 被占用）
  const thresholdKeyHint = "Ctrl+O"

  // 直接调用官方 API（和 opencode.ai 工作台 /go 页面相同的数据源）
  // 无需 workspace ID 或浏览器 cookie，用 auth.json 里的 Go API key 即可
  async function refreshGoApi() {
    try {
      const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
      if (!existsSync(authPath)) return
      const auth = JSON.parse(readFileSync(authPath, "utf-8"))
      const key = auth["opencode-go"]?.key
      if (!key) return
      const resp = await fetch("https://opencode.ai/zen/go/v1/usage", {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!resp.ok) return
      const json = await resp.json()
      const u = json?.usage
      if (u?.rolling && u?.weekly && u?.monthly) {
        setGoApi({
          rolling: { status: u.rolling.status, percent: u.rolling.percent, resetsAt: u.rolling.resetsAt },
          weekly: { status: u.weekly.status, percent: u.weekly.percent, resetsAt: u.weekly.resetsAt },
          monthly: { status: u.monthly.status, percent: u.monthly.percent, resetsAt: u.monthly.resetsAt },
          lastChecked: new Date().toISOString(),
        })
        setGoUpdated(Date.now())
      }
    } catch {
      // 网络错误或 key 无效时静默失败，回退到 JSON 文件里的数据
    }
  }
  refreshGoApi()
  const goApiTimer = setInterval(refreshGoApi, 60000)
  onCleanup(() => clearInterval(goApiTimer))

  // -------- 主题 --------
  // theme() 返回当前主题对象，包含各种颜色定义
  // 例：theme().text       → 文字颜色
  //     theme().textMuted  → 次要文字颜色
  //     theme().accent     → 强调色
  //     theme().success    → 成功/安全色（绿色系）
  //     theme().warning    → 警告色（黄色系）
  //     theme().error      → 错误色（红色系）
  const theme = () => props.api.theme.current

  // -------- 定时刷新 --------
  // setInterval: 每隔 30000 毫秒（30 秒）执行一次
  //   执行时调用 loadData() 重新读取文件，然后用 setData() 更新状态
  //   setData() 更新后，所有依赖 data() 的 UI 都会自动刷新
  const timer = setInterval(() => {
    setData(loadData())
    setThreshold(readThresholdFile())
  }, 30000)

  // onCleanup: 当组件被销毁时（比如切换到其他页面），清除定时器
  //   这很重要！如果不清理，定时器会永远运行，造成内存泄漏
  onCleanup(() => clearInterval(timer))

  // -------- 计算属性（createMemo） --------
  // createMemo: 创建一个"记忆化的计算值"
  //   它只依赖 data()，只有 data() 变化时才会重新计算
  //   如果 data() 没变，直接返回缓存的结果（避免重复计算）

  // providers : 所有 Provider 的用量数据
  const providers = createMemo(() => data().providerUsage)

  // readAuthKeys: 从 auth.json 读取哪些 provider 已经登录
  //   API key 型：有 key 字段就算已配置
  //   OAuth 型（如 openai 的 ChatGPT 登录）：有 refresh token 就算已配置
  const readAuthKeys = (): Record<string, boolean> => {
    try {
      const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
      if (!existsSync(authPath)) return {}
      const auth = JSON.parse(readFileSync(authPath, "utf-8"))
      const out: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(auth)) {
        const entry = v as any
        out[id] = Boolean(entry?.key) || (entry?.type === "oauth" && Boolean(entry?.refresh))
      }
      return out
    } catch {
      return {}
    }
  }

  // activeProviderId : 当前会话正在使用的提供商（只会有一个）
  //   用 /models 里当前模型所属的提供商；会话模型还没建立时回退到最近消息
  const activeProviderId = createMemo(() => getActiveProviderId(props.api, props.sessionId))

  // knownProviders : 提供商列表 —— 只包含当前正在使用的那个提供商
  //   用哪个模型就显示哪个提供商（切换模型后自动变化）
  const knownProviders = createMemo(() => {
    const id = activeProviderId()
    if (!id) return []
    const puMap = providers()
    const keys = readAuthKeys()
    const meta = PROVIDER_META.find((m) => m.id === id)
    return [
      {
        id,
        name: meta?.name ?? DISPLAY_NAMES[id] ?? id,
        color: meta?.color ?? "#94a3b8",
        glyph: meta?.glyph ?? "●",
        active: true,
        configured: Boolean(keys[id]) || Boolean(puMap[id]?.tokenrhythm),
        pu: puMap[id],
      },
    ]
  })

  // goUsage : 优先用官方 API 的实时数据，其次用 JSON 文件里缓存的 goApi，都没有才回退 goWindows
  const goUsage = createMemo(() => {
    const live = goApi()
    if (live) return live
    const pu = providers()["opencode-go"]
    if (pu?.goApi) return pu.goApi
    return null
  })

  // cacheStats : 当前会话的缓存统计
  // 从 opencode 状态里读取当前会话的所有消息，累加 tokens 字段：
  //   input  = 每次请求的输入 token（未命中缓存的部分）
  //   read   = 命中缓存的输入 token（cache read）
  //   write  = 写入缓存的 token（cache write）
  //   hit    = 缓存命中率 = read / (input + read)
  const cacheStats = createMemo(() => {
    const stats = { input: 0, output: 0, read: 0, write: 0, turns: 0, hit: 0 }
    if (!props.api.state?.ready || !props.sessionId) return stats
    try {
      const msgs = props.api.state.session.messages(props.sessionId)
      for (const m of msgs) {
        const t = (m as any).tokens
        if (!t) continue
        stats.input += t.input || 0
        stats.output += t.output || 0
        stats.read += t.cache?.read || 0
        stats.write += t.cache?.write || 0
        stats.turns++
      }
    } catch {
      // 会话尚未加载完时可能抛错，返回当前已累计的值
    }
    stats.hit = stats.input + stats.read > 0 ? (stats.read / (stats.input + stats.read)) * 100 : 0
    return stats
  })

  // -------- UI 辅助函数 --------
  // 这些小函数返回 JSX 元素（HTML 标签），用来避免重复写相同的代码

  // label: 折叠/展开的三角箭头
  //   isOpen = true  →  "▼"（向下三角，表示已展开）
  //   isOpen = false →  "▶"（向右三角，表示已折叠）
  const label = (isOpen: boolean) => (
    <text fg={theme().text}>{isOpen ? "▼" : "▶"}</text>
  )

  // pctColor: 根据百分比返回对应的颜色
  //   90% 以上 → error（红色）
  //   70~90%  → warning（黄色）
  //   70% 以下 → success（绿色）
  const pctColor = (pct: number) => {
    if (pct >= 90) return theme().error
    if (pct >= 70) return theme().warning
    return theme().success
  }

  // cacheColor: 缓存命中率的颜色
  //   60% 以上 → success（绿色，说明大部分输入走了缓存，省钱）
  //   30~60%  → warning（黄色）
  //   30% 以下 → error（红色）
  const cacheColor = (hit: number) => {
    if (hit >= 60) return theme().success
    if (hit >= 30) return theme().warning
    return theme().error
  }

  // displayWidth: 计算字符串在终端里的显示宽度（中文等宽字符按 2 格算）
  const displayWidth = (s: string) => {
    let w = 0
    for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1
    return w
  }

  // padLabel: 把标签补空格到固定宽度，让"标签 + 数值"整齐对齐
  //   例：padLabel("命中率") → "命中率   "（补到 10 格）
  const padLabel = (s: string, width = 10) => {
    const pad = Math.max(0, width - displayWidth(s))
    return s + " ".repeat(pad)
  }

  // BarRow: 一行"标签 + 色块进度条 + 百分比"
  //   例：最近5小时  ██████░░ 66%
  const BarRow = (labelText: string, pct: number, color: string) => {
    const barLen = 8
    const filled = Math.round((pct / 100) * barLen)
    return (
      <box flexDirection="row" gap={1}>
        <text fg={theme().textMuted}>{padLabel(labelText)}</text>
        <text fg={color}>
          {"█".repeat(filled)}{"░".repeat(Math.max(0, barLen - filled))}
        </text>
        <text fg={color}>{fmtPct(pct)}%</text>
      </box>
    )
  }

  // InfoRow: 一行"标签 + 数值"（数值用强调色显示）
  const InfoRow = (labelText: string, value: string) => (
    <box flexDirection="row" gap={1}>
      <text fg={theme().textMuted}>{padLabel(labelText)}</text>
      <text fg={theme().text}>{value}</text>
    </box>
  )

  // divider: 区域之间的分隔线
  const divider = () => (
    <text fg={theme().borderSubtle}>{"─".repeat(24)}</text>
  )

  // fmtTokens: 把 token 数格式化成易读形式
  //   例：fmtTokens(123456) → "123.5k"
  const fmtTokens = (n: number) => {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
    return String(n)
  }

  // resetIn: 计算距离重置时间的倒计时（精确到分钟）
  //   例：resetIn("2026-07-18T12:00:00Z") → "3h 42m"、"45m" 或 "4d 12h"（超过 24 小时显示天 + 小时）
  const resetIn = (iso: string) => {
    const diff = new Date(iso).getTime() - Date.now()
    if (diff <= 0) return "now"
    const totalMinutes = Math.round(diff / 60000)
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  // GoWindowPercent: 一个官方 API 时间窗口的渲染
  //   第一行：标签 + 色块进度条 + 已用百分比
  //   第二行：对齐的"重置"倒计时
  const GoWindowPercent = (labelText: string, w: GoApiWindow) => (
    <box>
      {BarRow(labelText, w.percent, pctColor(w.percent))}
      <Show when={w.resetsAt}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{padLabel(t.resets)}</text>
          <text fg={theme().accent}>{resetIn(w.resetsAt!)}</text>
        </box>
      </Show>
    </box>
  )

  // ProviderDetails: 某个 provider 的用量明细
  //   Go：官方 API 三窗口进度条；其他：费用/剩余/Token 数
  const ProviderDetails = (id: string, pu?: ProviderUsage) => (
    <box paddingLeft={2}>
      <Show when={id === "opencode-go" && goUsage()}>
        {InfoRow(t.plan, "Go")}
        {GoWindowPercent(t.rolling5h, goUsage()!.rolling)}
        {GoWindowPercent(t.weekly, goUsage()!.weekly)}
        {GoWindowPercent(t.monthly, goUsage()!.monthly)}
      </Show>

      <Show when={id === "opencode-go" && !goUsage() && pu?.goWindows}>
        {BarRow(t.rolling5h, (pu!.goWindows!.rolling5h.cost / pu!.goWindows!.rolling5h.limit) * 100, pctColor((pu!.goWindows!.rolling5h.cost / pu!.goWindows!.rolling5h.limit) * 100))}
        {BarRow(t.weekly, (pu!.goWindows!.weekly.cost / pu!.goWindows!.weekly.limit) * 100, pctColor((pu!.goWindows!.weekly.cost / pu!.goWindows!.weekly.limit) * 100))}
        {BarRow(t.monthly, (pu!.goWindows!.monthly.cost / pu!.goWindows!.monthly.limit) * 100, pctColor((pu!.goWindows!.monthly.cost / pu!.goWindows!.monthly.limit) * 100))}
      </Show>

      <Show when={id !== "opencode-go" && pu?.cost != null}>
        {InfoRow(t.cost, `$${pu!.cost!.toFixed(2)}`)}
      </Show>

      {/* ChatGPT：限额窗口与 Analytics Credits 分开显示 */}
      <Show when={id === "openai" && pu?.chatgpt}>
        <Show when={pu!.chatgpt!.planType}>
          {InfoRow(t.plan, pu!.chatgpt!.planType!.charAt(0).toUpperCase() + pu!.chatgpt!.planType!.slice(1))}
        </Show>
        {GoWindowPercent(t.rolling5h, pu!.chatgpt!.primary)}
        <Show when={pu!.chatgpt!.secondary}>
          {GoWindowPercent(t.weekly, pu!.chatgpt!.secondary!)}
        </Show>
        <Show when={pu!.chatgpt!.credits != null}>
          {InfoRow(t.balance, fmtCredits(pu!.chatgpt!.credits!))}
        </Show>
        <Show when={pu!.chatgpt!.creditUsage}>
          {InfoRow(t.creditsSpent, fmtCredits(pu!.chatgpt!.creditUsage!.last7Days.total))}
          {InfoRow(t.codexCredits, fmtCredits(pu!.chatgpt!.creditUsage!.last7Days.codex))}
          {InfoRow(t.workCredits, fmtCredits(pu!.chatgpt!.creditUsage!.last7Days.work))}
        </Show>
      </Show>

      {/* TokenRhythm：账户余额与累计成本（和 tokenrhythm.studio 账户页同源） */}
      <Show when={id === "tokenrhythm" && pu?.tokenrhythm}>
        <Show when={pu!.tokenrhythm!.availableBalance != null}>
          {InfoRow(t.availBalance, fmtMoney(pu!.tokenrhythm!.availableBalance!, pu!.tokenrhythm!.currency))}
        </Show>
        <Show when={pu!.tokenrhythm!.totalCost != null}>
          {InfoRow(t.totalCost, fmtMoney(pu!.tokenrhythm!.totalCost!, pu!.tokenrhythm!.currency))}
        </Show>
        <Show when={pu!.tokenrhythm!.calls != null}>
          {InfoRow(t.calls, pu!.tokenrhythm!.calls!.toLocaleString())}
        </Show>
        <Show when={pu!.tokenrhythm!.authExpired}>
          <text fg={theme().warning} paddingLeft={2}>{t.cookieExpired}</text>
        </Show>
      </Show>

      <Show when={id !== "opencode-go" && pu?.limit != null && pu!.limit! > 0 && pu?.cost != null}>
        {BarRow(t.used, (pu!.cost! / pu!.limit!) * 100, pctColor((pu!.cost! / pu!.limit!) * 100))}
      </Show>

      <Show when={pu?.remaining != null && id !== "opencode-go"}>
        {InfoRow(t.left, `$${pu!.remaining!.toFixed(2)}`)}
      </Show>

      <Show when={pu?.totalTokens != null}>
        {InfoRow(t.tokens, pu!.totalTokens!.toLocaleString())}
      </Show>
    </box>
  )

  // -------- 以下是主渲染结构（JSX，看起来像 HTML） --------
  // 从 <box> 开始一直到 </box>，就是整个侧边栏面板的 UI

return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        {label(open())}
        <text fg={theme().text}><b>⚡ {t.usage}</b></text>
      </box>
      <Show when={open()}>
        <box paddingLeft={1}>

          <box flexDirection="row" gap={1} onMouseDown={() => setOpenCache((x) => !x)}>
            {label(openCache())}
            <text fg={theme().text}><b>💾 {t.sessionCache}</b></text>
          </box>

          <Show when={openCache() && cacheStats().turns > 0}>
            <box paddingLeft={2}>
              {BarRow(t.hitRate, cacheStats().hit, cacheColor(cacheStats().hit))}
              {InfoRow(t.input, fmtTokens(cacheStats().input))}
              {InfoRow(t.read, fmtTokens(cacheStats().read))}
              {InfoRow(t.write, fmtTokens(cacheStats().write))}
            </box>
          </Show>
          {/* 上面的命中率经 BarRow 用 fmtPct 格式化：整数不带 .0 */}

          <Show when={openCache() && cacheStats().turns === 0}>
            <text fg={theme().textMuted} paddingLeft={2}>
              {t.noTurns}
            </text>
          </Show>

          {divider()}

          <box flexDirection="row" gap={1} onMouseDown={() => setOpenProviders((x) => !x)}>
            {label(openProviders())}
            <text fg={theme().text}><b>🌐 {t.providers}</b></text>
          </box>
          <Show when={openProviders()}>
            <Show when={knownProviders().length === 0}>
              <text fg={theme().textMuted} paddingLeft={2}>{t.noActiveProvider}</text>
            </Show>
            <For each={knownProviders()}>
              {(p) => (
                <box paddingLeft={2}>
                  {/* 徽标 + 名称 + 状态 */}
                  <box flexDirection="row" gap={1}>
                    <text fg={p.color}>{p.glyph}</text>
                    <text fg={p.active ? theme().accent : theme().text}>
                      <b>{p.name}</b>
                    </text>
                    <box flexGrow={1} />
                    <text fg={p.active ? theme().accent : p.configured ? theme().success : theme().textMuted}>
                      {p.active ? t.inUse : p.configured ? t.configured : t.notConfigured}
                    </text>
                  </box>
                  {/* 当前使用的提供商显示明细 */}
                  <Show when={p.pu || (p.id === "opencode-go" && goUsage())}>
                    {ProviderDetails(p.id, p.pu)}
                  </Show>
                </box>
              )}
            </For>

            {/* 提醒阈值：只显示数值，不绘制进度条 */}
            <box flexDirection="row" gap={1} paddingLeft={2}>
              <text fg={theme().textMuted}>{padLabel(t.threshold)}</text>
              <text fg={theme().accent}><b>{fmtPct(threshold())}%</b></text>
              <text fg={theme().textMuted}>· {thresholdKeyHint}</text>
            </box>

            {/* Go 数据在显示时，用真正的 API 拉取时间；否则用数据文件的保存时间 */}
            <Show when={goUsage() && goUpdated()}>
              <text fg={theme().textMuted} paddingLeft={2}>
                {t.updated}: {new Date(goUpdated()!).toLocaleTimeString(undefined, { hour12: false })}
              </text>
            </Show>
            <Show when={!goUsage() && data().lastUpdated}>
              <text fg={theme().textMuted} paddingLeft={2}>
                {t.updated}: {new Date(data().lastUpdated).toLocaleTimeString(undefined, { hour12: false })}
              </text>
            </Show>
          </Show>
        </box>
      </Show>
    </box>
  )
}


// ============================================================================
// 系统通知 + 常驻状态栏
// ============================================================================

// checkAllAlerts : 检查所有提供商是否跨越了提醒阈值
//   跨越时弹 TUI toast + 发系统通知（+ 声音）
//   由下面的 UsageStatusBar 每 30 秒调用一次
async function checkAllAlerts(api: any, data: UsageData, t: Strings, threshold: number) {
  if (!api?.attention?.notify) return
  const alerts: Array<{ name: string; pct: number }> = []
  const puMap = data.providerUsage || {}
  for (const [pid, pu] of Object.entries(puMap)) {
    const name = DISPLAY_NAMES[pid] || pid
    if (pid === "opencode-go" && pu.goApi) {
      for (const [wname, w] of Object.entries({ [t.rolling5h]: pu.goApi.rolling, [t.weekly]: pu.goApi.weekly, [t.monthly]: pu.goApi.monthly })) {
        if (crossedThreshold(`go.${wname}`, w.percent, threshold)) {
          alerts.push({ name: `${name} ${wname}`, pct: w.percent })
        }
      }
    } else if (pid === "openai" && pu.chatgpt) {
      const windows: Record<string, GoApiWindow> = { [t.rolling5h]: pu.chatgpt.primary }
      if (pu.chatgpt.secondary) windows[t.weekly] = pu.chatgpt.secondary
      for (const [wname, w] of Object.entries(windows)) {
        if (crossedThreshold(`chatgpt.${wname}`, w.percent, threshold)) {
          alerts.push({ name: `${name} ${wname}`, pct: w.percent })
        }
      }
    }
    if (pu.cost != null && pu.limit != null && pu.limit > 0) {
      const pct = (pu.cost / pu.limit) * 100
      if (crossedThreshold(`cost.${pid}`, pct, threshold)) {
        alerts.push({ name, pct })
      }
    }
  }
  for (const a of alerts) {
    const title = `${t.alertTitle}: ${a.name}`
    const message = t.alertMessage(a.name, a.pct, threshold)
    const variant = a.pct >= 100 ? "error" : "warning"
    try {
      api.ui?.toast?.({ variant, title, message })
    } catch {
      // toast 不可用时静默失败
    }
    try {
      await api.attention.notify({
        title,
        message,
        notification: true,
        sound: { name: a.pct >= 100 ? "error" : "default" },
      })
    } catch {
      // 通知不可用时静默失败（如未开 attention）
    }
  }
}

// UsageStatusBar: 侧边栏底部常驻状态栏 —— 常驻显示当前提供商的用量 + 阈值
//   - 注册在 sidebar_footer 槽位（single_winner，order 50 赢得内置插件）
//   - 固定在侧边栏底部，不随内容滚动；每 30 秒重新读取数据文件，
//     同时检查所有提供商是否跨越阈值 → 系统通知（api.attention.notify）
//   - 右侧保留内置 footer 原本的 目录: 分支 信息
function UsageStatusBar(props: { api: any; sessionId?: string; lang: Lang }) {
  const t = makeStrings(props.lang ?? "en")
  const [data, setData] = createSignal(loadData())
  const [threshold, setThreshold] = createSignal(readThresholdFile())
  const theme = () => props.api.theme.current

  const timer = setInterval(() => {
    setData(loadData())
    setThreshold(readThresholdFile())
  }, 30000)
  onCleanup(() => clearInterval(timer))

  const activeId = createMemo(() => getActiveProviderId(props.api, props.sessionId))

  // 当前提供商的所有用量窗口（用于状态栏显示最大百分比）
  const windows = createMemo(() => {
    const id = activeId()
    if (!id) return []
    const pu = data().providerUsage?.[id]
    const out: Array<{ name: string; pct: number }> = []
    if (id === "opencode-go" && pu?.goApi) {
      out.push({ name: t.rolling5h, pct: pu.goApi.rolling.percent })
      out.push({ name: t.weekly, pct: pu.goApi.weekly.percent })
      out.push({ name: t.monthly, pct: pu.goApi.monthly.percent })
    } else if (id === "openai" && pu?.chatgpt) {
      out.push({ name: t.rolling5h, pct: pu.chatgpt.primary.percent })
      if (pu.chatgpt.secondary) out.push({ name: t.weekly, pct: pu.chatgpt.secondary.percent })
    } else if (pu?.cost != null && pu?.limit != null && pu.limit > 0) {
      out.push({ name: t.used, pct: (pu.cost / pu.limit) * 100 })
    }
    return out
  })

  // 每次数据刷新时检查所有提供商是否跨越阈值 → 系统通知
  createEffect(() => {
    checkAllAlerts(props.api, data(), t, threshold())
  })

  const id = activeId()
  if (id === undefined || windows().length === 0) return null

  const meta = PROVIDER_META.find((m) => m.id === id)
  const maxPct = Math.max(...windows().map((w) => w.pct))
  const over = maxPct >= threshold()
  const barColor = over ? (maxPct >= 100 ? theme().error : theme().warning) : theme().textMuted

  // 内置 footer 原本显示的 目录（分支在应用最底部栏已显示，这里只补目录名）
  const dir = props.api.state?.path?.directory
  const base = dir ? String(dir).split(/[\\/]/).pop() : undefined

  return (
    <box flexDirection="row" gap={1}>
      <text fg={meta?.color ?? "#94a3b8"}>{meta?.glyph ?? "●"}</text>
      <text fg={theme().text}><b>{meta?.name ?? id}</b></text>
      <text fg={barColor}>{fmtPct(maxPct)}%</text>
      <text fg={theme().textMuted}>·{threshold()}%</text>
      <box flexGrow={1} />
      <text fg={theme().textMuted}>{base}</text>
    </box>
  )
}


// ============================================================================
// 插件注册 — 这是 opencode 加载插件的入口
// ============================================================================

/**
 * tui: TUI 插件函数
 *
 * 当 opencode 启动时，会调用这个函数，传入 api 对象。
 * api 提供了 opencode 的各种功能：
 *   - api.slots.register() : 注册 UI 插槽（把组件挂到侧边栏/标题栏等位置）
 *   - api.theme            : 主题（颜色配置）
 *   - api.state            : opencode 的状态（会话列表等）
 *   - api.client           : SDK 客户端（可以调用 API）
 *   - api.kv               : 键值存储（持久化小数据）
 *   - api.keymap           : 快捷键管理
 *   - api.lifecycle        : 生命周期管理（onDispose 等）
 */
const tui: TuiPlugin = async (api, options) => {
  // 语言选项：tui.json 里用元组形式配置
  //   { "plugin": [["/path/to/oc-plugin-usage/src/tui.tsx", { "language": "zh" }]] }
  // 支持 "zh"（中文）或 "en"（英文，默认）
  const opts = (options || {}) as { language?: string }
  const lang: Lang = opts.language === "zh" ? "zh" : "en"
  const t = makeStrings(lang)

  // 调整提醒阈值的对话框（Ctrl+O 或命令面板触发）
  const DialogPrompt = api.ui.DialogPrompt
  function openThresholdDialog() {
    const current = readThresholdFile()
    api.ui.dialog.replace(
      () => (
        <DialogPrompt
          title={t.setThresholdTitle}
          description={() => (
            <text fg={api.theme.current.textMuted}>{t.setThresholdDesc(current)}</text>
          )}
          placeholder="10-100"
          value={String(current)}
          onConfirm={(v) => {
            const n = Math.round(Number(v))
            if (Number.isFinite(n) && n >= 1 && n <= 100) {
              writeThresholdFile(n)
              api.ui.toast({ variant: "success", message: t.thresholdSet(n) })
            } else {
              api.ui.toast({ variant: "error", message: t.invalidThreshold })
            }
            api.ui.dialog.clear()
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ),
      () => {},
    )
  }

  // 调整提醒阈值的命令（命令面板 Ctrl+P 可搜到；回车触发）
  // 用 v1 兼容的 api.command.register —— 保证命令出现在命令面板
  api.command?.register(() => [
    {
      title: lang === "zh" ? "设置用量提醒阈值" : "Set usage alert threshold",
      value: "oc-plugin-usage.set-threshold",
      description: lang === "zh" ? `当前 ${readThresholdFile()}%` : `Current ${readThresholdFile()}%`,
      category: "Usage",
      onSelect: () => openThresholdDialog(),
    },
  ])

  // 快捷键层：Ctrl+O 触发同一个对话框（终端不支持组合键时可用命令面板）
  // 注意：keymap 的修饰键只有 ctrl/shift/meta/super/hyper，没有 alt
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "oc-plugin-usage.set-threshold",
          title: lang === "zh" ? "设置用量提醒阈值" : "Set usage alert threshold",
          category: "Usage",
          run: () => openThresholdDialog(),
        },
      ],
    })
  } catch {
    // 命令层注册失败不影响命令面板入口
  }
  try {
    api.keymap.registerLayer({
      bindings: [{ key: "ctrl+o", cmd: "oc-plugin-usage.set-threshold" }],
    })
  } catch {
    // 绑定键解析失败（终端不支持）时忽略
  }

  // api.slots.register() : 注册一个"插槽插件"
  // 插槽 = opencode 界面上的特定位置（比如侧边栏、Logo 区域等）
  // 你可以在这些位置插入自定义的 UI 内容
  api.slots.register({
    /**
     * order : 渲染顺序（数字越小越靠前）
     *
     * opencode 内置的侧边栏内容的顺序是：
     *   100 : Context（上下文信息，token 数等）
     *   200 : MCP（MCP 服务器状态）
     *   300 : LSP（语言服务器状态）
     *   400 : Todo（待办事项列表）
     *   500 : Files（变更文件列表）
     *
     * 我们选择 150，让 Usage 面板显示在 Context（100）之后，MCP（200）之前
     */
    order: 150,

    // slots : 你要在哪些插槽位置插入 UI
    slots: {
      /**
       * sidebar_content : 侧边栏主体内容区域
       *
       * 这个函数在每次渲染侧边栏时被调用
       * 返回的 JSX 会被渲染到这个位置
       * props 包含当前会话的 session_id 等信息
       */
sidebar_content(_ctx, props) {
        // props.session_id : 当前正在查看的会话 ID（用于计算该会话的缓存命中率）
        return <UsageSidebar api={api} sessionId={props.session_id} lang={lang} />
      },
    },
  })

  // sidebar_footer 是 single_winner 槽位：内置插件以 order 100 注册，
  // 我们以 order 50 注册才能赢得它（否则显示不了常驻状态栏）
  api.slots.register({
    order: 50,
    slots: {
      sidebar_footer(_ctx, props) {
        return <UsageStatusBar api={api} sessionId={props.session_id} lang={lang} />
      },
    },
  })
}

/**
 * plugin : 插件的导出对象
 *
 * opencode 要求 TUI 插件模块的默认导出是 { id, tui } 格式
 *   - id  : 插件的唯一标识符（用于日志、管理面板等）
 *   - tui : TUI 插件函数（上面定义的）
 *
 * TuiPluginModule 确保类型正确（导出格式符合 opencode 的要求）
 */
const plugin: TuiPluginModule & { id: string } = {
  id: "oc-plugin-usage-sidebar",
  tui,
}

// 默认导出（ES Module 规范）
// opencode 通过 import 加载这个文件时，拿到的就是这个对象
export default plugin
