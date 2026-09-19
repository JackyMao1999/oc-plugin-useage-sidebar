# oc-plugin-usage

**English** | [中文](./README.zh-CN.md)

AI model usage monitoring plugin for [opencode](https://opencode.ai). Tracks session, tool, and file activity, with optional API provider quota monitoring.

## Features

- **Follows the active model** — the sidebar shows exactly one provider: the one in use. Picking a model in `/models` switches it immediately: OpenCode only persists the choice on the next prompt, so the plugin follows `~/.local/state/opencode/model.json` to switch right away
- **Session cache hit rate** — live `cache read / (input + read)` for the current session (Hit rate, Input, Read, Write)
- **Response speed** — tracks time to first token (TTFT) and output throughput (Tokens/s); the sidebar shows current-session averages, while `usage_stats` shows persisted totals
- **Go plan usage** — official API percent windows (rolling 5h / weekly / monthly) with reset countdown
- **ChatGPT usage** — reads `wham/usage` and `wham/usage/credit-usage-events` from the ChatGPT backend for plan type, rate-limit windows (5h / weekly / monthly, picked from `limit_window_seconds` so whichever windows the account has are labelled correctly), remaining Credits, and the same 7-day Codex/Work Credits totals shown by Codex Cloud Analytics. Works with the standard OpenAI OAuth login — no API key needed; the plugin reads the credential from OpenCode V2's credential store and never refreshes the one-time OpenAI refresh token itself
- **TokenRhythm account** — when the active provider is `tokenrhythm`, shows the actual available balance (实际可用总额) and cumulative cost (累计成本) from tokenrhythm.studio — the same numbers as the account page. Requires a browser session cookie (see below)
- **DeepSeek balance** — when the active provider is `deepseek`, shows total, recharged, and granted balance from the DeepSeek balance API
- **Provider quota (optional)** — connects to OpenAI/Anthropic billing APIs for real cost and limit data
- **AI callable** — the `usage_stats` tool lets the model report usage when asked
- **Toast alerts** — warns at configurable threshold (default 80%) when approaching a provider limit
- **JSON persistence** — data stored at `~/.opencode/oc-plugin-usage-data.json`

## Install

### One-command install (recommended)

After cloning the repository, run:

```bash
./install.sh
```

The installer installs dependencies, registers the local package with an
absolute path, backs up existing configuration files before changing them, and
is safe to run repeatedly. OpenCode V2 automatically loads the package's
`./tui` export for the sidebar. Use Chinese labels with:

```bash
./install.sh --language zh
```

To remove the registration later without deleting usage data:

```bash
./install.sh --uninstall
```

Use `./install.sh --help` for `--dry-run`, `--skip-deps`, and custom config
directory options.

> This checkout targets the OpenCode V2 plugin API.

### 1. Clone / copy the plugin

```bash
git clone git@github.com:JackyMao1999/oc-plugin-useage.git
# or copy the folder anywhere, e.g. ~/.opencode/plugins/oc-plugin-usage
```

Install dependencies (the one-command installer does this automatically):

```bash
cd oc-plugin-usage
npm install
npx tsc   # optional typecheck/build
```

### 2. Register the plugin (opencode.json)

Use the absolute path to the cloned package directory. Do **NOT** use the bare
name `"oc-plugin-usage"` unless the package has been published and installed
from npm.

Global config (`~/.config/opencode/opencode.json`, or `~/.opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/oc-plugin-useage-sidebar",
      "options": {
        "language": "en"
      }
    }
  ]
}
```

`language` accepts `"en"` (default) or `"zh"`. The plugin resolves it from
①`options` in `opencode.json` → ②`language` in the plugin's own config file
`~/.opencode/oc-plugin-usage-config.json` → ③`en`; restart opencode after
changing it. `usageThresholdPercent` can be set the same two ways. No separate `tui.json` or
`cli.json` entry is needed: OpenCode V2 loads the package's `./tui` export.

### 3. Restart opencode

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
  "plugins": [{
    "package": "/path/to/oc-plugin-useage-sidebar",
    "options": {
      "openaiApiKey": "sk-...",
      "anthropicApiKey": "sk-ant-...",
      "usageThresholdPercent": 80,
      "language": "en"
    }
  }]
}
```

### TokenRhythm balance (optional)

The tokenrhythm.studio management API only accepts browser login sessions —
the `sk_tr_...` API key cannot read the wallet. To show **实际可用总额 /
累计成本** in the sidebar, copy your session cookie:

1. Log in at `https://tokenrhythm.studio/account/account`
2. Open DevTools → Network → click any `/api/...` request → Request Headers
3. Copy the whole `Cookie:` header value into `~/.opencode/tokenrhythm-cookie.txt`

The site's session expires after ~24h idle; when that happens the sidebar
shows a "cookie expired" hint and keeps the last values until you update the
file. Alternatively pass the cookie via the `tokenrhythmCookie` plugin option.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | `string` | — | OpenAI API key for billing usage queries |
| `anthropicApiKey` | `string` | — | Anthropic API key for usage queries |
| `deepseekApiKey` | `string` | — | DeepSeek API key for balance queries; falls back to `auth.json` |
| `chatGptAccountId` | `string` | — | Optional ChatGPT workspace account ID; omit for a personal account |
| `tokenrhythmCookie` | `string` | — | TokenRhythm session cookie (alternative to `~/.opencode/tokenrhythm-cookie.txt`) |
| `usageThresholdPercent` | `number` | `80` | Percentage at which toast warning fires |
| `language` (tui plugin) | `string` | `en` | Sidebar language: `en` or `zh` |

## Data collected

| Event | Tracks |
|-------|--------|
| `session.created` | session count |
| `session.execution.failed` | error count |
| `tool.execute.after` | tool call frequency (per tool name) |
| `filesystem.changed` | file modification count |
| `session.usage.updated` | cumulative cost and token usage |

Provider data (when configured): cost, token count, plan limit, remaining quota. Response speed is captured from the first streamed text part through assistant completion; throughput is calculated as output tokens divided by the time from first token to completion.

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

Aggregated by calendar day. Provider data is refreshed every minute when API keys are configured.

## Build

```bash
npm install
npx tsc
```

## License

MIT
