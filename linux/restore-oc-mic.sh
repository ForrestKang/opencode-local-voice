#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="${OPENCODE_APP_PATH:-}"
INPUT=""
BACKUP_ROOT="${HOME}/.config/opencode/local-voice/backups"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || { echo "--app requires a path" >&2; exit 2; }; APP="$2"; shift 2 ;;
    --input) [ "$#" -ge 2 ] || { echo "--input requires a path" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --backup-root) [ "$#" -ge 2 ] || { echo "--backup-root requires a path" >&2; exit 2; }; BACKUP_ROOT="$2"; shift 2 ;;
    -h|--help) echo "usage: ./restore-oc-mic.sh --app APP_DIR [--input app.asar] [--backup-root DIR]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP" ] && [ -d "$APP" ] || { echo "pass --app with the OpenCode application directory." >&2; exit 1; }
APP="$(cd "$APP" && pwd)"
if [ -z "$INPUT" ]; then
  for candidate in "$APP/resources/app.asar" "$APP/app.asar" "$APP/usr/lib/opencode/resources/app.asar"; do
    if [ -f "$candidate" ]; then INPUT="$candidate"; break; fi
  done
fi
[ -n "$INPUT" ] && [ -f "$INPUT" ] || { echo "app.asar not found under --app; pass --input explicitly." >&2; exit 1; }
INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
command -v pgrep >/dev/null 2>&1 || { echo "pgrep is required to verify OpenCode is closed; refusing to restore." >&2; exit 1; }
if pgrep -x "OpenCode" >/dev/null 2>&1 || pgrep -x "opencode" >/dev/null 2>&1; then
  echo "OpenCode is running. Close it manually; this script never terminates it." >&2
  exit 1
fi
node "$ROOT/shared/install-support.cjs" restore-asar --platform linux --app "$APP" --input "$INPUT" --backup-root "$BACKUP_ROOT"
echo "[restore] complete. Reopen OpenCode manually."
