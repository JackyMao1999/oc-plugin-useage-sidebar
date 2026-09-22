# oc-plugin-usage

**English** | [中文](./README.zh-CN.md)

AI model usage monitoring plugin for [opencode](https://opencode.ai). Tracks session, tool, and file activity, with optional API provider quota monitoring.

## Features

- **Follows the active model** — the sidebar shows exactly one provider: the one in use. Picking a model in `/models` switches it immediately: OpenCode only persists the choice on the next prompt, so the plugin follows `~/.local/state/opencode/model.json` to switch right away
- **Session cache hit rate** — live `cache read / (input + read)` for the current session (Hit rate, Input, Read, Write)
- **Response speed** — tracks time to first token (TTFT) and output throughput (Tokens/s); the sidebar shows current-session averages, while `usage_stats` shows persisted totals
- **Resettable token counter** — the sidebar's token count is accumulated by the plugin; press `Ctrl+Y` (or run "Reset token usage" from the command palette) to zero the current provider's count, after which it accumulates again from zero
- **Session status panel (cross-window)** — a framed list of every session with a status symbol: `?` needs input (permission/form), `↻` retrying, `●` working, `○` idle (the current session is marked with `›`; idle subagent sessions are hidden and idle sessions older than 30 minutes drop off). The list, running state, and pending-input counts all come from the background service that every window shares, so **a window opened later still sees sessions that started earlier, even in other directories**; it refreshes every 5s and immediately on related events. Click the header to collapse, or turn the whole panel off with `sessionsPanel: false`
- **Cross-session toasts** — when a session in another OpenCode window finishes a task, asks for permission, or needs a choice, the current window shows a toast (the toast title is the session name; events are broadcast by the shared service, so sessions in other directories notify too). The session you are already watching is not re-announced; disable with `sessionToasts: false`
- **Go plan usage** — official API percent windows (rolling 5h / weekly / monthly) with reset countdown
- **ChatGPT usage** — reads `wham/usage` and `wham/usage/credit-usage-events` from the ChatGPT backend for plan type, rate-limit windows (5h / weekly / monthly, picked from `limit_window_seconds` so whichever windows the account has are labelled correctly), remaining Credits, and the same 7-day Codex/Work Credits totals shown by Codex Cloud Analytics. Works with the standard OpenAI OAuth login — no API key needed; the plugin reads the credential from OpenCode V2's credential store and never refreshes the one-time OpenAI refresh token itself
- **TokenRhythm account** — when the active provider is `tokenrhythm`, shows the actual available balance (实际可用总额) and cumulative cost (累计成本) from tokenrhythm.studio — the same numbers as the account page. Requires a browser session cookie (see below)
- **DeepSeek balance** — when the active provider is `deepseek`, shows total, recharged, and granted balance from the DeepSeek balance API
- **StepFun balance and Step Plan usage** — when the active provider is `stepfun` or `stepfun-step-plan`, shows the balance from StepFun's account API; with an account-page session configured, also shows the plan name, 5-hour / weekly / Credit usage windows, today's Credits and call counts
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

### 3. Restart the OpenCode service

Plugins load when the shared background service starts, so quitting the TUI is
not enough — the service keeps running and holds the previous plugin state.
Quit every opencode client, then run:

```bash
opencode service restart
```

Reopen `opencode` and the right sidebar will show
**Usage → Session Cache → Providers**.

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
      "stepfunApiKey": "sk-...",
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

### StepFun balance and plan usage (optional)

StepFun exposes the current account balance through an API-key authenticated endpoint, so no browser cookie is needed:

```
GET https://api.stepfun.com/v1/accounts
Authorization: Bearer <StepFun API key>
```

The plugin first looks for a saved `stepfun`, `step`, or `stepfun-step-plan`
provider key in OpenCode. You can also pass `stepfunApiKey`; values are
displayed in CNY.

**Step Plan usage** is separate from the API balance and can only be read from
the account page's login-session endpoints — StepFun rejects API keys for them
(403 `api key not permitted for this method`). The plugin calls these three in
parallel:

```
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit  # 5-hour / weekly / subscription Credit left rates + reset times
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages    # today's Credit consumption and call counts per model
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus      # plan name
```

The sidebar then shows the plan name, 5-hour / weekly / Credit usage bars (with
reset countdowns), today's Credits, today's calls, and the API balance.

To enable plan usage, copy the whole `Cookie` request header from a request made
while logged in at `https://platform.stepfun.com/account-overview` into
`~/.opencode/stepfun-cookie.txt` (the `Oasis-Token` cookie is the login
session; pasting just that one value also works). The plugin reads the cookie on
each poll, uses it only for these requests, and never writes it or the API key
to the usage JSON. When the session expires the sidebar shows a "cookie expired"
hint and keeps the last values until you update the file. You can alternatively
pass the cookie as `stepfunCookie`.

## Shortcuts and sounds

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Set the usage alert threshold (also in the command palette: "Set usage alert threshold") |
| `Ctrl+Y` | Reset the active provider's token count (also in the command palette: "Reset token usage") |

The reset only affects the accumulated token counter shown in the sidebar (the same
number as `Tokens` in `usage_stats`); costs, balances, and plan windows are untouched.
The TUI writes a `tokensResetAt` marker that the server-side plugin applies, so the
"keep the larger number" merge used for the shared data file can't restore the old value.

### Sound when input is needed / a turn finishes

These are played by OpenCode's built-in attention plugin (`permission.asked` → permission
sound; session done → done, subagents → subagent_done). They are **off by default**; enable
them in `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "attention": {
    "sound": true,
    "volume": 0.5
  }
}
```

- `sound: true` plays sounds; add `notifications: true` to also show system notifications
- `sounds` overrides individual events: `{ "permission": "/path/to/x.wav", "done": "/path/to/y.wav" }`
- Restart the TUI after changing `cli.json` (the TUI process reads it at startup)

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `openaiApiKey` | `string` | — | OpenAI API key for billing usage queries |
| `anthropicApiKey` | `string` | — | Anthropic API key for usage queries |
| `deepseekApiKey` | `string` | — | DeepSeek API key for balance queries; falls back to `auth.json` |
| `stepfunApiKey` | `string` | — | StepFun API key for account balance queries; falls back to the OpenCode credential store |
| `stepfunCookie` | `string` | — | StepFun account-page session cookie for Step Plan usage; alternatively use `~/.opencode/stepfun-cookie.txt` |
| `chatGptAccountId` | `string` | — | Optional ChatGPT workspace account ID; omit for a personal account |
| `tokenrhythmCookie` | `string` | — | TokenRhythm session cookie (alternative to `~/.opencode/tokenrhythm-cookie.txt`) |
| `usageThresholdPercent` | `number` | `80` | Percentage at which toast warning fires |
| `sessionsPanel` | `boolean` | `true` | Show the "Sessions" status panel in the sidebar (the header also collapses on click) |
| `sessionToasts` | `boolean` | `true` | Toast when another session finishes, asks for permission, or needs input |
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
