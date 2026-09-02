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
import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"

// -------- 导入 Node.js 内置模块 --------
// readFileSync : 同步读取文件内容（返回字符串或 Buffer）
// existsSync   : 检查文件是否存在（返回 true/false）
import { readFileSync, existsSync } from "fs"

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
 *     ▼ Today        ← 今天的会话数、工具调用数等
 *     ▼ Tools        ← 最常用的工具排名（前 5 名）
 *     ▶ Period       ← 可选周期汇总（today/week/month/all）
 *     ▶ Cumulative   ← 从开始到现在的全部累计
 *     ▼ Providers    ← OpenAI/Anthropic/Go/Zen 的费用和进度条
 */
function UsageSidebar(props: { api: any; sessionId?: string }) {

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

  // goApi：官方 /zen/go/v1/usage API 的实时数据（每 5 分钟刷新）
  const [goApi, setGoApi] = createSignal<GoApiUsage | null>(null)

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
      }
    } catch {
      // 网络错误或 key 无效时静默失败，回退到 JSON 文件里的数据
    }
  }
  refreshGoApi()
  const goApiTimer = setInterval(refreshGoApi, 300000)
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
  const timer = setInterval(() => setData(loadData()), 30000)

  // onCleanup: 当组件被销毁时（比如切换到其他页面），清除定时器
  //   这很重要！如果不清理，定时器会永远运行，造成内存泄漏
  onCleanup(() => clearInterval(timer))

  // -------- 计算属性（createMemo） --------
  // createMemo: 创建一个"记忆化的计算值"
  //   它只依赖 data()，只有 data() 变化时才会重新计算
  //   如果 data() 没变，直接返回缓存的结果（避免重复计算）

  // providers : 所有 Provider 的用量数据
  const providers = createMemo(() => data().providerUsage)

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

  // ProgressBar: 进度条组件
  //   用 "█" 和 "░" 字符画出 8 格长的进度条
  //   例：pct = 42 → filled = 3 → "███░░░░░ 42%"
  const ProgressBar = (pct: number) => {
    const barLen = 8                                                    // 进度条长度（8 格）
    const filled = Math.round((pct / 100) * barLen)                    // 已填充的格数
    const color = pctColor(pct)
    return (
      // <box> : 一个容器（类似 HTML 的 <div>）
      //   flexDirection="row" : 子元素水平排列
      //   gap={1}             : 子元素之间间隔 1 个单位
      //   paddingLeft={2}     : 左边内边距 2 个单位（实现缩进效果）
      <box flexDirection="row" gap={1} paddingLeft={2}>
        {/* <text> : 显示一段文字
            fg={color} : 文字颜色（foreground） */}
        <text fg={color}>
          {/* "█".repeat(3) → "███"
              "░".repeat(5) → "░░░░░"
              两者拼接 → "███░░░░░" */}
          {"█".repeat(filled)}{"░".repeat(Math.max(0, barLen - filled))}
        </text>
        <text fg={color}>{pct.toFixed(1)}%</text>
      </box>
    )
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

  // fmtTokens: 把 token 数格式化成易读形式
  //   例：fmtTokens(123456) → "123.5k"
  const fmtTokens = (n: number) => {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
    return String(n)
  }

  // resetIn: 计算距离重置时间的倒计时
  //   例：resetIn("2026-07-18T12:00:00Z") → "3.2h"、"45m" 或 "4.5d"（超过 24 小时显示天）
  const resetIn = (iso: string) => {
    const diff = new Date(iso).getTime() - Date.now()
    if (diff <= 0) return "now"
    const hours = diff / 3600000
    if (hours >= 24) return `${(hours / 24).toFixed(1)}d`
    return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(diff / 60000)}m`
  }

  // GoWindowPercent: 一个官方 API 时间窗口的渲染
  //   显示 "已用 X%" 进度条 + 重置倒计时
  const GoWindowPercent = (label: string, w: GoApiWindow) => (
    <box>
      <text fg={theme().textMuted}>
        {label}: {w.percent.toFixed(1)}% used
      </text>
      {ProgressBar(w.percent)}
      <Show when={w.resetsAt}>
        <text fg={theme().textMuted}>
          Resets: {resetIn(w.resetsAt!)}
        </text>
      </Show>
    </box>
  )

  // -------- 以下是主渲染结构（JSX，看起来像 HTML） --------
  // 从 <box> 开始一直到 </box>，就是整个侧边栏面板的 UI

return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        {label(open())}
        <text fg={theme().text}><b>Usage</b></text>
      </box>
      <Show when={open()}>
        <box paddingLeft={1}>

          <box flexDirection="row" gap={1} onMouseDown={() => setOpenCache((x) => !x)}>
            {label(openCache())}
            <text fg={theme().text}><b>Session Cache</b></text>
          </box>

          <Show when={openCache() && cacheStats().turns > 0}>
            <box paddingLeft={2}>
              <text fg={cacheColor(cacheStats().hit)}>
                Hit rate: {cacheStats().hit.toFixed(1)}%
              </text>
              <text fg={theme().textMuted}>
                Input:    {fmtTokens(cacheStats().input)}
              </text>
              <text fg={theme().textMuted}>
                Read:     {fmtTokens(cacheStats().read)}
              </text>
              <text fg={theme().textMuted}>
                Write:    {fmtTokens(cacheStats().write)}
              </text>
            </box>
          </Show>

          <Show when={openCache() && cacheStats().turns === 0}>
            <text fg={theme().textMuted} paddingLeft={2}>
              No assistant turns yet
            </text>
          </Show>

          <box flexDirection="row" gap={1} onMouseDown={() => setOpenProviders((x) => !x)}>
            {label(openProviders())}
            <text fg={theme().text}><b>Providers</b></text>
          </box>
          <Show when={openProviders()}>
            <Show when={Object.keys(providers()).length === 0}>
              <text fg={theme().textMuted} paddingLeft={2}>None configured</text>
            </Show>

            <For each={Object.entries(providers())}>
              {([name, pu]) => (
                <box paddingLeft={2}>
                  <text fg={theme().accent}>{DISPLAY_NAMES[name] || name}</text>

                  <Show when={name === "opencode-go" && goUsage()}>
                    {GoWindowPercent("Rolling 5h", goUsage()!.rolling)}
                    {GoWindowPercent("Weekly", goUsage()!.weekly)}
                    {GoWindowPercent("Monthly", goUsage()!.monthly)}
                  </Show>

                  <Show when={name === "opencode-go" && !goUsage() && pu.goWindows}>
                    <text fg={theme().textMuted}>
                      Rolling 5h: ${pu.goWindows!.rolling5h.cost.toFixed(2)} / ${pu.goWindows!.rolling5h.limit}
                    </text>
                    {ProgressBar((pu.goWindows!.rolling5h.cost / pu.goWindows!.rolling5h.limit) * 100)}
                    <text fg={theme().textMuted}>
                      Weekly:     ${pu.goWindows!.weekly.cost.toFixed(2)} / ${pu.goWindows!.weekly.limit}
                    </text>
                    {ProgressBar((pu.goWindows!.weekly.cost / pu.goWindows!.weekly.limit) * 100)}
                    <text fg={theme().textMuted}>
                      Monthly:    ${pu.goWindows!.monthly.cost.toFixed(2)} / ${pu.goWindows!.monthly.limit}
                    </text>
                    {ProgressBar((pu.goWindows!.monthly.cost / pu.goWindows!.monthly.limit) * 100)}
                  </Show>

                  <Show when={!pu.goWindows && pu.cost != null}>
                    <text fg={theme().textMuted}>Cost: ${pu.cost!.toFixed(2)}</text>
                  </Show>

                  <Show when={!pu.goWindows && pu.limit != null && pu.limit! > 0 && pu.cost != null}>
                    {ProgressBar((pu.cost! / pu.limit!) * 100)}
                  </Show>

                  <Show when={pu.remaining != null && !pu.goWindows}>
                    <text fg={theme().textMuted}>Left: ${pu.remaining!.toFixed(2)}</text>
                  </Show>

                  <Show when={pu.totalTokens != null}>
                    <text fg={theme().textMuted}>Tokens: {pu.totalTokens!.toLocaleString()}</text>
                  </Show>
                </box>
              )}
            </For>

            <Show when={Object.keys(providers()).length > 0 && data().lastUpdated}>
              <text fg={theme().textMuted} paddingLeft={2}>
                Updated: {new Date(data().lastUpdated).toLocaleTimeString()}
              </text>
            </Show>
          </Show>
        </box>
      </Show>
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
const tui: TuiPlugin = async (api) => {
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
        return <UsageSidebar api={api} sessionId={props.session_id} />
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
