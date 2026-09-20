# oc-plugin-usage

[English](./README.md) | **中文**

为 [opencode](https://opencode.ai) 开发的 AI 模型用量监控插件。在右侧侧边栏显示当前会话的**缓存命中率**和 **OpenCode Go 套餐用量**，也可选监控 OpenAI/Anthropic 的配额。

## 功能

- **跟随当前模型** — 侧边栏只显示当前使用中的那一个提供商；在 `/models` 里一选新模型就立刻切换（opencode 要等下一次发消息才把选择落库，插件通过 `~/.local/state/opencode/model.json` 提前跟随）
- **会话缓存命中率** — 实时统计当前会话的 `cache read / (input + read)`，显示 Hit rate、Input、Read、Write
- **响应速度** — 统计首字延迟（TTFT）和输出速度（Tokens/s）；侧边栏显示当前会话平均值，`usage_stats` 显示持久化累计值
- **Go 套餐用量** — 通过官方 API 显示 Rolling 5h / Weekly / Monthly 的已用百分比 + 重置倒计时（超过 24 小时自动显示为天）
- **ChatGPT 用量** — 读取 ChatGPT 后台的 `wham/usage` 和 `wham/usage/credit-usage-events`，显示计划类型、限额窗口（按 `limit_window_seconds` 自动识别 5 小时 / 每周 / 月度，账号有哪些窗口就显示哪些）、剩余 Credits，以及与 Codex Cloud Analytics 一致的近7天 Codex/Work Credits 汇总；用标准 OpenAI OAuth 登录即可，无需 API key。凭证直接读 OpenCode V2 的凭证存储，插件不会自己去刷 OpenAI 的一次性 refresh token（由 opencode 负责续期）
- **TokenRhythm 账户** — 当前提供商为 `tokenrhythm` 时，侧边栏显示 tokenrhythm.studio 的**实际可用总额**和**累计成本**（与账户页同源数字）；需要浏览器会话 Cookie（见下文）
- **DeepSeek 余额** — 当前提供商为 `deepseek` 时，通过 DeepSeek API key 显示总余额、充值余额和赠送余额；自动读取 OpenCode 登录保存的 key，也可手动配置
- **StepFun 余额和 Step Plan 用量** — 当前提供商为 `stepfun` 或 `stepfun-step-plan` 时，通过官方账户 API 显示余额；配置账户页会话后，还会显示套餐名称、5 小时 / 每周 / Credit 三个用量窗口、今日 Credits 与调用次数（见下文）
- **Provider 配额（可选）** — 连接 OpenAI/Anthropic 计费 API，显示真实费用和限额
- **AI 可调用** — `usage_stats` 工具可让模型在收到询问时报告用量
- **Toast 提醒** — 接近限额时弹出警告（默认阈值 80%）
- **JSON 持久化** — 数据保存在 `~/.opencode/oc-plugin-usage-data.json`

## 安装

### 一键安装（推荐）

克隆仓库后直接执行：

```bash
./install.sh
```

安装器会安装依赖、用绝对路径注册本地插件包，并在修改配置前自动备份已有
配置；重复执行不会产生重复条目。OpenCode V2 会自动加载插件包的 `./tui`
导出作为侧边栏。侧边栏使用中文时执行：

```bash
./install.sh --language zh
```

以后如需移除注册（不会删除用量数据），执行：

```bash
./install.sh --uninstall
```

更多选项可查看 `./install.sh --help`，包括试运行、跳过依赖安装和自定义配置目录。

> 当前仓库适配 OpenCode V2 插件 API。

### 1. 克隆 / 复制插件

```bash
git clone git@github.com:JackyMao1999/oc-plugin-useage.git
# 或把文件夹复制到任意位置，例如 ~/.opencode/plugins/oc-plugin-usage
```

安装依赖（使用一键安装器时会自动执行）：

```bash
cd oc-plugin-usage
npm install
npx tsc   # 可选，类型检查/构建
```

### 2. 注册插件（opencode.json）

使用克隆后插件目录的**绝对路径**。除非插件已经发布到 npm，否则不要直接写裸名
`"oc-plugin-usage"`。

全局配置（`~/.config/opencode/opencode.json` 或 `~/.opencode/opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/oc-plugin-useage-sidebar",
      "options": {
        "language": "zh"
      }
    }
  ]
}
```

`language` 支持 `"en"`（默认）和 `"zh"`（中文）。插件按
①opencode.json 里的 `options` → ②插件自己的配置文件
`~/.opencode/oc-plugin-usage-config.json` 里的 `language` → ③`en` 的顺序解析，
改完重启 opencode 生效；`usageThresholdPercent` 同样支持这两种写法。不需要单独配置 `tui.json`
或 `cli.json`，OpenCode V2 会自动加载插件包的 `./tui` 导出。

### 3. 重启 opencode

插件只在启动时加载。退出后重新运行 `opencode` —— 右侧侧边栏会出现 **Usage → Session Cache → Providers**。

### 工作空间 / Go 套餐

**无需任何工作空间配置。** 侧边栏通过官方 API 获取你的 Go 套餐用量：

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <opencode-go key>
```

`opencode-go` 的 API key 会自动从 `~/.local/share/opencode/auth.json` 读取，任何已登录 Go 计划的用户开箱即用。Web 后台对应地址是 `https://opencode.ai/workspace/<你的工作空间ID>/go`，但插件不需要工作空间 ID，也不需要浏览器 cookie。

### 可选：配置 Provider API key

```json
{
  "plugins": [{
    "package": "/path/to/oc-plugin-useage-sidebar",
    "options": {
      "openaiApiKey": "sk-...",
      "anthropicApiKey": "sk-ant-...",
      "deepseekApiKey": "sk-...",
      "stepfunApiKey": "sk-...",
      "usageThresholdPercent": 80,
      "language": "zh"
    }
  }]
}
```

### 可选：TokenRhythm 余额显示

tokenrhythm.studio 的管理接口只认浏览器登录会话，`sk_tr_...` API key 无法读取钱包。要在侧边栏显示**实际可用总额 / 累计成本**，请复制会话 Cookie：

1. 登录 `https://tokenrhythm.studio/account/account`
2. 打开 DevTools → Network → 点任意 `/api/...` 请求 → Request Headers
3. 把整个 `Cookie:` 请求头的值复制到 `~/.opencode/tokenrhythm-cookie.txt`

站点会话闲置约 24 小时后过期；过期后侧边栏会显示"Cookie 已过期"提示并保留最后一次数据，更新文件即可恢复。也可以通过 `tokenrhythmCookie` 插件选项传入。

### 可选：StepFun 余额与套餐用量

StepFun 官方提供了支持 API key 的账户余额接口，不需要账户页的浏览器 Cookie：

```
GET https://api.stepfun.com/v1/accounts
Authorization: Bearer <stepfun API key>
```

插件会优先读取 OpenCode 已保存的 `stepfun`、`step` 或 `stepfun-step-plan`
提供商 Key；也可以通过 `stepfunApiKey` 插件选项配置。返回的余额单位为人民币。

**Step Plan 套餐用量**与 API 余额是两套数据，只能从账户页（platform.stepfun.com）
的登录态接口读取——API key 调用会被拒绝（403 `api key not permitted for this
method`），插件会并行请求下面三个接口：

```
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit  # 5 小时 / 每周 / 订阅 Credit 剩余比例与重置时间
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages    # 今日按模型汇总的 Credit 消耗与调用次数
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus      # 套餐名称
```

侧边栏据此显示：套餐名称、最近5小时 / 本周 / Credit用量三个进度条（含重置倒计时）、
今日已消耗 Credits、今日调用次数，以及 API 余额。

要启用套餐用量，请在已登录 `https://platform.stepfun.com/account-overview` 时，
从浏览器某个请求的 Request Headers 复制完整 `Cookie` 值到
`~/.opencode/stepfun-cookie.txt`（Cookie 里的 `Oasis-Token` 即登录态，只复制这
一条的值也可以）。插件每轮读取该文件，仅把 Cookie 用于本次查询，不会把 Cookie
或 API key 写入用量 JSON；会话过期后侧边栏会提示"Cookie 已过期"并保留最后一次
数据，重新复制即可。也可以通过 `stepfunCookie` 插件选项传入 Cookie。

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openaiApiKey` | `string` | — | 用于查询账单用量的 OpenAI API key |
| `anthropicApiKey` | `string` | — | 用于查询用量的 Anthropic API key |
| `deepseekApiKey` | `string` | — | 用于查询 DeepSeek 余额的 API key；未配置时自动读取 `auth.json` |
| `stepfunApiKey` | `string` | — | 用于查询 StepFun 账户余额的 API key；未配置时自动读取 OpenCode 凭证 |
| `stepfunCookie` | `string` | — | 用于查询 Step Plan 套餐用量的账户页会话 Cookie；也可使用 `~/.opencode/stepfun-cookie.txt` |
| `chatGptAccountId` | `string` | — | 可选的 ChatGPT 工作区账号 ID；个人账号无需配置 |
| `tokenrhythmCookie` | `string` | — | TokenRhythm 会话 Cookie（也可用 `~/.opencode/tokenrhythm-cookie.txt` 文件） |
| `usageThresholdPercent` | `number` | `80` | Toast 警告触发的用量百分比 |
| `language`（tui 插件） | `string` | `en` | 侧边栏语言：`en` 或 `zh` |

## 收集的数据

| 事件 | 统计内容 |
|------|----------|
| `session.created` | 会话数 |
| `session.execution.failed` | 错误数 |
| `tool.execute.after` | 各工具调用次数 |
| `filesystem.changed` | 文件修改次数 |
| `session.usage.updated` | 累计费用和 Token 用量 |

配置 key 后还会收集 Provider 数据：费用、token 数、套餐限额、剩余额度。响应速度指标在流式文本开始和助手消息完成时自动采集；输出速度按输出 tokens /（首字到完成的时间）计算。

## 自定义工具

插件注册了 `usage_stats` 工具，可以直接问 AI：

> "查看用量"
> "How much have I used this week?"
> "Show me my OpenAI costs"

工具支持 `period` 参数：`today`、`week`、`month`、`rolling`、`all`。

## 数据文件

```
~/.opencode/oc-plugin-usage-data.json
```

按自然日聚合。配置 API key 后，Provider 数据每分钟更新一次。

## 构建

```bash
npm install
npx tsc
```

## License

MIT
