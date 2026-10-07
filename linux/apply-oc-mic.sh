#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="${OPENCODE_APP_PATH:-}"
INPUT=""
OUTPUT=""
BACKUP_ROOT="${HOME}/.config/opencode/local-voice/backups"
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || { echo "--app requires a path" >&2; exit 2; }; APP="$2"; shift 2 ;;
    --input) [ "$#" -ge 2 ] || { echo "--input requires a path" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --output) [ "$#" -ge 2 ] || { echo "--output requires a path" >&2; exit 2; }; OUTPUT="$2"; shift 2 ;;
    --backup-root) [ "$#" -ge 2 ] || { echo "--backup-root requires a path" >&2; exit 2; }; BACKUP_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) echo "usage: ./apply-oc-mic.sh --app APP_DIR [--input app.asar] [--output candidate.asar] [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP" ] && [ -d "$APP" ] || { echo "pass --app with the OpenCode application directory." >&2; exit 1; }
APP="$(cd "$APP" && pwd)"
INPUT="${INPUT:-}"
if [ -z "$INPUT" ]; then
  for candidate in "$APP/resources/app.asar" "$APP/app.asar" "$APP/usr/lib/opencode/resources/app.asar"; do
    if [ -f "$candidate" ]; then INPUT="$candidate"; break; fi
  done
fi
[ -n "$INPUT" ] && [ -f "$INPUT" ] || { echo "app.asar not found under --app; pass --input explicitly." >&2; exit 1; }
INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }

if [ "$DRY_RUN" -eq 0 ]; then
  command -v pgrep >/dev/null 2>&1 || { echo "pgrep is required to verify OpenCode is closed; refusing to apply." >&2; exit 1; }
  if pgrep -x "OpenCode" >/dev/null 2>&1 || pgrep -x "opencode" >/dev/null 2>&1; then
    echo "OpenCode is running. Close it manually; this script never terminates it." >&2
    exit 1
  fi
fi

GENERATED=0
if [ -z "$OUTPUT" ]; then OUTPUT="$(mktemp "${TMPDIR:-/tmp}/oc-voice-patched.XXXXXX")"; rm -f "$OUTPUT"; GENERATED=1; fi
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
node "$HERE/patch-oc-mic.js" --app "$APP" --input "$INPUT" --output "$OUTPUT"
if [ "$DRY_RUN" -eq 1 ]; then echo "[patch] dry run complete: $OUTPUT (no app files changed)"; exit 0; fi
SUPPORT="$ROOT/shared/install-support.cjs"
node "$SUPPORT" apply-asar --platform linux --app "$APP" --input "$INPUT" --patched "$OUTPUT" --backup-root "$BACKUP_ROOT"
if [ "$GENERATED" -eq 1 ]; then rm -f "$OUTPUT"; fi
echo "[patch] complete. Version/hash-bound backup saved under $BACKUP_ROOT. Reopen OpenCode manually."
