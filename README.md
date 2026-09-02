# oc-plugin-usage

**English** | [中文](./README.zh-CN.md)

AI model usage monitoring plugin for [opencode](https://opencode.ai). Tracks session, tool, and file activity, with optional API provider quota monitoring.

## Features

- **Usage tracking** — monitors sessions, tool calls, file edits, and errors
- **Period aggregation** — stats by today, week, month, or rolling 30 days
- **Provider quota** — optionally connects to OpenAI/Anthropic billing APIs for real cost and limit data
- **AI callable** — the `usage_stats` tool lets the model report usage when asked
- **Toast alerts** — warns at configurable threshold (default 80%) when approaching a provider limit
- **JSON persistence** — data stored at `~/.opencode/oc-plugin-usage-data.json`

## Install

### 1. Clone / copy the plugin

```bash
git clone git@github.com:JackyMao1999/oc-plugin-useage.git
# or copy the folder anywhere, e.g. ~/.opencode/plugins/oc-plugin-usage
```

Install dependencies (for local development / `tsc`):

```bash
cd oc-plugin-usage
npm install
npx tsc   # optional, only if you edit the source
```

### 2. Register the server plugin (opencode.json)

**Important:** use the absolute path to `src/index.ts`. Do **NOT** use the bare
name `"oc-plugin-usage"` — that resolves to an unrelated npm package, not this
plugin.

Global config (`~/.config/opencode/opencode.json`, or `~/.opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/oc-plugin-usage/src/index.ts"]
}
```

### 3. Register the sidebar (TUI) plugin (tui.json)

Create `~/.config/opencode/tui.json` (or `~/.opencode/tui.json`):

```json
{
  "plugin": ["/path/to/oc-plugin-usage/src/tui.tsx"]
}
```

Optional: set the sidebar language to Chinese with the tuple form:

```json
{
  "plugin": [["/path/to/oc-plugin-usage/src/tui.tsx", { "language": "zh" }]]
}
```

`language` accepts `"en"` (default) or `"zh"`.

### 4. Restart opencode

Plugins load only at startup. Quit and run `opencode` again — the right sidebar
will show **Usage → Session Cache → Providers**.

### Workspace / Go plan

No workspace configuration is needed. The sidebar fetches your Go plan usage
from the official API:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <opencode-go key>
```

The `opencode-go` API key is read automatically from
`~/.local/share/opencode/auth.json`, so any user who has logged in with an
OpenCode Go plan works out of the box. The web dashboard equivalent is
`https://opencode.ai/workspace/<your-workspace-id>/go`, but the plugin does not
require the workspace ID or a browser cookie.

### With provider API keys (optional)

```json
{
  "plugin": [["/path/to/oc-plugin-usage/src/index.ts", {
    "openaiApiKey": "sk-...",
    "anthropicApiKey": "sk-ant-...",
    "usageThresholdPercent": 80
  }]]
}
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | `string` | — | OpenAI API key for billing usage queries |
| `anthropicApiKey` | `string` | — | Anthropic API key for usage queries |
| `usageThresholdPercent` | `number` | `80` | Percentage at which toast warning fires |
| `language` (tui plugin) | `string` | `en` | Sidebar language: `en` or `zh` |

## Data collected

| Event | Tracks |
|-------|--------|
| `session.created` | session count |
| `session.error` | error count |
| `tool.execute.after` | tool call frequency (per tool name) |
| `file.edited` | file modification count |

Provider data (when configured): cost, token count, plan limit, remaining quota.

## Custom tool

The plugin registers a `usage_stats` tool. Ask the AI:

> "查看用量"
> "How much have I used this week?"
> "Show me my OpenAI costs"

The tool accepts a `period` parameter: `today`, `week`, `month`, `rolling`, or `all`.

## Data file

```
~/.opencode/oc-plugin-usage-data.json
```

Aggregated by calendar day. Provider data updated every 5 minutes when API keys are configured.

## Build

```bash
npm install
npx tsc
```

## License

MIT
