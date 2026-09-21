#!/usr/bin/env bash

# One-click installer for the OpenCode V2 plugin.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SERVER_ENTRY="$SCRIPT_DIR/src/index.ts"
readonly TUI_ENTRY="$SCRIPT_DIR/src/tui.tsx"
readonly LOCAL_SERVER_ENTRY="$SCRIPT_DIR/index.ts"
readonly LOCAL_TUI_ENTRY="$SCRIPT_DIR/tui.tsx"

LANGUAGE="en"
CONFIG_DIR=""
SKIP_DEPS=0
DRY_RUN=0
UNINSTALL=0
FORCE=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install oc-plugin-usage globally for the current user.

Options:
  --language <en|zh>  Sidebar language (default: en)
  --config-dir <dir>  OpenCode config directory
  --skip-deps         Do not run npm/bun install
  --dry-run           Show actions without changing files
  --uninstall         Remove this plugin from OpenCode configuration
  --force             Skip the OpenCode version check
  --force-legacy      Alias for --force (deprecated)
  -h, --help          Show this help

Examples:
  ./install.sh
  ./install.sh --language zh
  ./install.sh --uninstall
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[oc-plugin-usage] %s\n' "$*"
}

while (($# > 0)); do
  case "$1" in
    --language)
      (($# >= 2)) || die "--language requires en or zh"
      LANGUAGE="$2"
      shift 2
      ;;
    --language=*)
      LANGUAGE="${1#*=}"
      shift
      ;;
    --config-dir)
      (($# >= 2)) || die "--config-dir requires a directory"
      CONFIG_DIR="$2"
      shift 2
      ;;
    --config-dir=*)
      CONFIG_DIR="${1#*=}"
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --force|--force-legacy)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (use --help for usage)"
      ;;
  esac
done

case "$LANGUAGE" in
  en|zh) ;;
  *) die "--language must be en or zh" ;;
esac

[[ -f "$SERVER_ENTRY" ]] || die "Missing plugin entrypoint: $SERVER_ENTRY"
[[ -f "$TUI_ENTRY" ]] || die "Missing TUI entrypoint: $TUI_ENTRY"
[[ -f "$LOCAL_SERVER_ENTRY" ]] || die "Missing local plugin wrapper: $LOCAL_SERVER_ENTRY"
[[ -f "$LOCAL_TUI_ENTRY" ]] || die "Missing local TUI wrapper: $LOCAL_TUI_ENTRY"
command -v python3 >/dev/null 2>&1 || die "python3 is required to merge OpenCode JSON configuration"

if [[ -z "$CONFIG_DIR" ]]; then
  xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  if [[ -f "$xdg_config_home/opencode/opencode.json" || \
        -f "$xdg_config_home/opencode/opencode.jsonc" ]]; then
    CONFIG_DIR="$xdg_config_home/opencode"
  elif [[ -f "$HOME/.opencode/opencode.json" || \
          -f "$HOME/.opencode/opencode.jsonc" ]]; then
    CONFIG_DIR="$HOME/.opencode"
  else
    CONFIG_DIR="$xdg_config_home/opencode"
  fi
fi

CONFIG_DIR="$(python3 - "$CONFIG_DIR" <<'PY'
import os
import sys
print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
)"

if command -v opencode >/dev/null 2>&1 && ((FORCE == 0)); then
  opencode_version="$(opencode --version 2>/dev/null || true)"
  opencode_major="$(printf '%s\n' "$opencode_version" | sed -nE 's/[^0-9]*([0-9]+).*/\1/p')"
  if [[ "$opencode_major" =~ ^[0-9]+$ ]] && ((opencode_major < 2)); then
    die "OpenCode V2 is required; detected: ${opencode_version:-unknown}"
  fi
fi

SERVER_CONFIG="$CONFIG_DIR/opencode.json"
if [[ -f "$CONFIG_DIR/opencode.jsonc" && ! -f "$CONFIG_DIR/opencode.json" ]]; then
  SERVER_CONFIG="$CONFIG_DIR/opencode.jsonc"
fi
LEGACY_TUI_CONFIG="$CONFIG_DIR/tui.json"
CLI_CONFIG="$CONFIG_DIR/cli.json"

if ((DRY_RUN)); then
  info "config directory: $CONFIG_DIR"
  info "plugin package: $SCRIPT_DIR"
  if ((UNINSTALL)); then
    info "would remove the plugin from $SERVER_CONFIG and legacy CLI configs"
  else
    info "would register the V2 plugin with language=$LANGUAGE"
  fi
  exit 0
fi

mkdir -p "$CONFIG_DIR"

backup_config() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
  local suffix=1
  while [[ -e "$backup" ]]; do
    backup="${file}.bak.$(date +%Y%m%d%H%M%S).$suffix"
    ((suffix += 1))
  done
  cp -p -- "$file" "$backup"
  info "backed up $file -> $backup"
}

merge_config() {
  local action="$1"
  local file="$2"
  local key="$3"
  local target="$4"
  local options_json="${5:-}"

  [[ -f "$file" ]] && backup_config "$file"

  python3 - "$action" "$file" "$key" "$target" "$options_json" <<'PY'
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

action, filename, key, target, options_json = sys.argv[1:]
path = Path(filename)


def strip_jsonc(source: str) -> str:
    result = []
    i = 0
    in_string = False
    escaped = False
    while i < len(source):
        char = source[i]
        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            result.append(char)
            i += 1
        elif char == '/' and i + 1 < len(source) and source[i + 1] == '/':
            i += 2
            while i < len(source) and source[i] not in "\r\n":
                i += 1
        elif char == '/' and i + 1 < len(source) and source[i + 1] == '*':
            i += 2
            while i + 1 < len(source) and source[i:i + 2] != "*/":
                i += 1
            i = min(len(source), i + 2)
        else:
            result.append(char)
            i += 1
    return re.sub(r',\s*([}\]])', r'\1', ''.join(result))


def load() -> dict:
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        if key == "plugins" and path.name.startswith("opencode."):
            return {"$schema": "https://opencode.ai/config.json"}
        return {}
    try:
        value = json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"cannot parse {path}: {exc}")
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object")
    return value


def entry_path(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value and isinstance(value[0], str):
        return value[0]
    if isinstance(value, dict) and isinstance(value.get("package"), str):
        return value["package"]
    return None


def same_path(value) -> bool:
    candidate = entry_path(value)
    if candidate is None:
        return False
    if candidate.startswith("file://"):
        candidate = candidate[7:]
    if candidate == target:
        return True
    return os.path.realpath(os.path.expanduser(candidate)) == os.path.realpath(target)


def desired_entry():
    if not options_json:
        return target
    return {"package": target, "options": json.loads(options_json)}


data = load()
entries = data.get(key, [])
if isinstance(entries, str):
    entries = [entries]
if not isinstance(entries, list):
    raise SystemExit(f"{path}: {key!r} must be an array or string")

changed = False
if action == "install":
    found = False
    for index, value in enumerate(entries):
        if not same_path(value):
            continue
        found = True
        if options_json:
            options = json.loads(options_json)
            if isinstance(value, dict):
                replacement = dict(value)
                old_options = replacement.get("options")
                replacement["options"] = {**old_options, **options} if isinstance(old_options, dict) else options
            else:
                replacement = {"package": target, "options": options}
            if replacement != value:
                entries[index] = replacement
                changed = True
        break
    if not found:
        entries.append(desired_entry())
        changed = True
elif action == "uninstall":
    filtered = [value for value in entries if not same_path(value)]
    changed = filtered != entries
    entries = filtered
else:
    raise SystemExit(f"unsupported action: {action}")

if changed:
    data[key] = entries
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

print("changed" if changed else "unchanged")
PY
}

if ((UNINSTALL)); then
  merge_config uninstall "$SERVER_CONFIG" plugins "$SCRIPT_DIR"
  merge_config uninstall "$SERVER_CONFIG" plugin "$SERVER_ENTRY"
  merge_config uninstall "$LEGACY_TUI_CONFIG" plugin "$TUI_ENTRY"
  merge_config uninstall "$LEGACY_TUI_CONFIG" plugin "$LOCAL_TUI_ENTRY"
  merge_config uninstall "$CLI_CONFIG" plugins "$SCRIPT_DIR"
  merge_config uninstall "$CLI_CONFIG" plugins "$TUI_ENTRY"
  merge_config uninstall "$CLI_CONFIG" plugins "$LOCAL_TUI_ENTRY"
  info "plugin removed from OpenCode configuration"
  info "usage data was kept at $HOME/.opencode/oc-plugin-usage-data.json"
  exit 0
fi

# Dependency check must not rely on the node_modules directory alone: a
# node_modules left over from the V1 layout has no V2 @opencode/plugin, so the
# installer would skip npm install and OpenCode would fail with
#   failed to load plugin ... Cannot find package '@opencode/plugin'
REQUIRED_MODULES=(
  "@opencode/plugin"
  "@opentui/core"
  "@opentui/solid"
  "solid-js"
)

missing_modules() {
  local module
  for module in "${REQUIRED_MODULES[@]}"; do
    [[ -f "$SCRIPT_DIR/node_modules/$module/package.json" ]] || printf '%s ' "$module"
  done
}

install_dependencies() {
  if command -v npm >/dev/null 2>&1; then
    info "installing JavaScript dependencies"
    (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund)
  elif command -v bun >/dev/null 2>&1; then
    info "installing JavaScript dependencies with Bun"
    (cd "$SCRIPT_DIR" && bun install)
  else
    die "npm or bun is required (or rerun with --skip-deps if OpenCode provides the dependencies)"
  fi
}

if ((SKIP_DEPS == 0)); then
  missing="$(missing_modules)"
  if [[ -n "$missing" ]]; then
    if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
      info "node_modules is incomplete, missing: ${missing% }"
    fi
    install_dependencies
    missing="$(missing_modules)"
    if [[ -n "$missing" ]]; then
      die "dependencies are still missing after install: ${missing% } (try: cd $SCRIPT_DIR && npm install)"
    fi
  fi
fi

# OpenCode V2 loads the ./tui export of a configured server plugin
# automatically, so the legacy per-file registrations (opencode.json "plugin",
# tui.json, cli.json) must be removed — leaving them behind loads the sidebar
# twice, once as a server plugin and once as a CLI plugin.
merge_config uninstall "$SERVER_CONFIG" plugin "$SERVER_ENTRY"
merge_config uninstall "$LEGACY_TUI_CONFIG" plugin "$TUI_ENTRY"
merge_config uninstall "$LEGACY_TUI_CONFIG" plugin "$LOCAL_TUI_ENTRY"
merge_config uninstall "$CLI_CONFIG" plugins "$SCRIPT_DIR"
merge_config uninstall "$CLI_CONFIG" plugins "$TUI_ENTRY"
merge_config uninstall "$CLI_CONFIG" plugins "$LOCAL_TUI_ENTRY"
merge_config install "$SERVER_CONFIG" plugins "$SCRIPT_DIR" "{\"language\":\"$LANGUAGE\"}"

info "OpenCode V2 installation complete"
info "config: $SERVER_CONFIG"
info "restart the shared service to load the plugin: opencode service restart"
