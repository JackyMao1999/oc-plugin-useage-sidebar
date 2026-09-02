# oc-plugin-usage

AI model usage monitoring plugin for [opencode](https://opencode.ai). Tracks session, tool, and file activity, with optional API provider quota monitoring.

## Features

- **Usage tracking** — monitors sessions, tool calls, file edits, and errors
- **Period aggregation** — stats by today, week, month, or rolling 30 days
- **Provider quota** — optionally connects to OpenAI/Anthropic billing APIs for real cost and limit data
- **AI callable** — the `usage_stats` tool lets the model report usage when asked
- **Toast alerts** — warns at configurable threshold (default 80%) when approaching a provider limit
- **JSON persistence** — data stored at `~/.opencode/oc-plugin-usage-data.json`

## Install

### Via opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/oc-plugin-usage/src/index.ts"]
}
```

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

### Auto-discovery (project-level)

```bash
# Copy compiled plugin to project's plugin directory
cp dist/index.js /path/to/your/project/.opencode/plugins/usage-plugin.js
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | `string` | — | OpenAI API key for billing usage queries |
| `anthropicApiKey` | `string` | — | Anthropic API key for usage queries |
| `usageThresholdPercent` | `number` | `80` | Percentage at which toast warning fires |

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
