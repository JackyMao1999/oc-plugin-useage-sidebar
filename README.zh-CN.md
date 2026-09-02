# oc-plugin-usage

[English](./README.md) | **中文**

为 [opencode](https://opencode.ai) 开发的 AI 模型用量监控插件。在右侧侧边栏显示当前会话的**缓存命中率**和 **OpenCode Go 套餐用量**，也可选监控 OpenAI/Anthropic 的配额。

## 功能

- **会话缓存命中率** — 实时统计当前会话的 `cache read / (input + read)`，显示 Hit rate、Input、Read、Write
- **Go 套餐用量** — 通过官方 API 显示 Rolling 5h / Weekly / Monthly 的已用百分比 + 重置倒计时（超过 24 小时自动显示为天）
- **Provider 配额（可选）** — 连接 OpenAI/Anthropic 计费 API，显示真实费用和限额
- **AI 可调用** — `usage_stats` 工具可让模型在收到询问时报告用量
- **Toast 提醒** — 接近限额时弹出警告（默认阈值 80%）
- **JSON 持久化** — 数据保存在 `~/.opencode/oc-plugin-usage-data.json`

## 安装

### 1. 克隆 / 复制插件

```bash
git clone git@github.com:JackyMao1999/oc-plugin-useage.git
# 或把文件夹复制到任意位置，例如 ~/.opencode/plugins/oc-plugin-usage
```

安装依赖（本地开发 / 编译时需要）：

```bash
cd oc-plugin-usage
npm install
npx tsc   # 可选，只有修改源码后才需要
```

### 2. 注册 Server 插件（opencode.json）

**重要：** 必须使用 `src/index.ts` 的**绝对路径**。不要写裸名 `"oc-plugin-usage"` —— 那会解析成 npm 上的无关同名包，而不是本插件。

全局配置（`~/.config/opencode/opencode.json` 或 `~/.opencode/opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/oc-plugin-usage/src/index.ts"]
}
```

### 3. 注册侧边栏（TUI）插件（tui.json）

创建 `~/.config/opencode/tui.json`（或 `~/.opencode/tui.json`）：

```json
{
  "plugin": ["/path/to/oc-plugin-usage/src/tui.tsx"]
}
```

可选：用元组形式把侧边栏语言设为中文：

```json
{
  "plugin": [["/path/to/oc-plugin-usage/src/tui.tsx", { "language": "zh" }]]
}
```

`language` 支持 `"en"`（默认）和 `"zh"`（中文）。

### 4. 重启 opencode

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
  "plugin": [["/path/to/oc-plugin-usage/src/index.ts", {
    "openaiApiKey": "sk-...",
    "anthropicApiKey": "sk-ant-...",
    "usageThresholdPercent": 80
  }]]
}
```

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openaiApiKey` | `string` | — | 用于查询账单用量的 OpenAI API key |
| `anthropicApiKey` | `string` | — | 用于查询用量的 Anthropic API key |
| `usageThresholdPercent` | `number` | `80` | Toast 警告触发的用量百分比 |
| `language`（tui 插件） | `string` | `en` | 侧边栏语言：`en` 或 `zh` |

## 收集的数据

| 事件 | 统计内容 |
|------|----------|
| `session.created` | 会话数 |
| `session.error` | 错误数 |
| `tool.execute.after` | 各工具调用次数 |
| `file.edited` | 文件修改次数 |

配置 key 后还会收集 Provider 数据：费用、token 数、套餐限额、剩余额度。

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

按自然日聚合。配置 API key 后，Provider 数据每 5 分钟更新一次。

## 构建

```bash
npm install
npx tsc
```

## License

MIT