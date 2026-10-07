#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="${OPENCODE_APP_PATH:-}"
INPUT=""
BACKUP_ROOT="${HOME}/.config/opencode/local-voice/backups"
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || { echo "--app requires a path" >&2; exit 2; }; APP="$2"; shift 2 ;;
    --input) [ "$#" -ge 2 ] || { echo "--input requires a path" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --backup-root) [ "$#" -ge 2 ] || { echo "--backup-root requires a path" >&2; exit 2; }; BACKUP_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) echo "usage: ./restore-oc-mic.sh [--app OpenCode.app] [--input app.asar] [--backup-root DIR] [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$APP" ]; then
  for candidate in "/Applications/OpenCode.app" "$HOME/Applications/OpenCode.app"; do
    if [ -d "$candidate" ]; then APP="$candidate"; break; fi
  done
fi
[ -n "$APP" ] && [ -d "$APP" ] || { echo "OpenCode.app not found; pass --app or set OPENCODE_APP_PATH." >&2; exit 1; }
APP="$(cd "$APP" && pwd -P)"
[[ "$APP" == *.app ]] || { echo "--app must identify a .app bundle." >&2; exit 1; }
RES="$APP/Contents/Resources"
[ -f "$RES/app.asar" ] || { echo "unknown or incomplete app bundle; refusing to restore." >&2; exit 1; }
if [ -z "$INPUT" ]; then INPUT="$RES/app.asar"; fi
INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
[ "$INPUT" = "$RES/app.asar" ] || { echo "--input must be this app's Contents/Resources/app.asar." >&2; exit 1; }
command -v ditto >/dev/null 2>&1 || { echo "ditto is required for full-bundle restore." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to inspect the manifest." >&2; exit 1; }
if pgrep -x "OpenCode" >/dev/null 2>&1; then
  echo "OpenCode is running. Close it manually before restore; this script never terminates it." >&2
  exit 1
fi

SUPPORT="$ROOT/shared/install-support.cjs"
MATCH="$(node "$SUPPORT" find-bundle-backup --app "$APP" --input "$INPUT" --backup-root "$BACKUP_ROOT")" || exit $?
ORIGINAL_BUNDLE="$(printf '%s' "$MATCH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["originalBundle"])')"
MANIFEST_FILE="$(printf '%s' "$MATCH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifestFile"])')"
SOURCE_HASH="$(printf '%s' "$MATCH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest"]["sourceAsarSha256"])')"
ORIGINAL_TREE_HASH="$(printf '%s' "$MATCH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["manifest"]["originalBundleTreeSha256"])')"
[ -d "$ORIGINAL_BUNDLE" ] || { echo "verified original full bundle is missing: $ORIGINAL_BUNDLE" >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[restore] dry run verified the matching versioned full-bundle backup; no app, manifest, or config files were changed."
  echo "[restore] source ASAR SHA256: $SOURCE_HASH"
  echo "[restore] original bundle: $ORIGINAL_BUNDLE"
  exit 0
fi

STAGE="$(mktemp -d "$(dirname "$APP")/.oc-voice-restore.XXXXXX")"
OLD_BUNDLE=""
cleanup() {
  if [ -n "$OLD_BUNDLE" ] && [ -d "$OLD_BUNDLE" ] && [ ! -e "$APP" ]; then mv "$OLD_BUNDLE" "$APP" || true; fi
  rm -rf "$STAGE"
}
trap cleanup EXIT HUP INT TERM
RESTORE_CANDIDATE="$STAGE/$(basename "$APP")"
ditto --rsrc --extattr --acl "$ORIGINAL_BUNDLE" "$RESTORE_CANDIDATE"
RESTORED_HASH="$(shasum -a 256 "$RESTORE_CANDIDATE/Contents/Resources/app.asar" | awk '{print $1}')"
[ "$RESTORED_HASH" = "$SOURCE_HASH" ] || { echo "restored candidate does not match the original ASAR hash in its manifest." >&2; exit 1; }
node "$SUPPORT" verify-bundle --bundle "$RESTORE_CANDIDATE" --digest "$ORIGINAL_TREE_HASH"

OLD_BUNDLE="$(dirname "$APP")/.$(basename "$APP").oc-voice-patched.$$"
[ ! -e "$OLD_BUNDLE" ] || { echo "swap path already exists: $OLD_BUNDLE" >&2; exit 1; }
mv "$APP" "$OLD_BUNDLE"
if ! mv "$RESTORE_CANDIDATE" "$APP"; then
  mv "$OLD_BUNDLE" "$APP"
  OLD_BUNDLE=""
  echo "bundle restore swap failed; patched app was put back." >&2
  exit 1
fi
if ! node "$SUPPORT" set-bundle-state --app "$APP" --input "$RES/app.asar" --backup-root "$BACKUP_ROOT" --state restored; then
  mv "$APP" "$RESTORE_CANDIDATE"
  mv "$OLD_BUNDLE" "$APP"
  OLD_BUNDLE=""
  node "$SUPPORT" set-bundle-state --app "$APP" --input "$RES/app.asar" --backup-root "$BACKUP_ROOT" --state restore-failed >/dev/null 2>&1 || true
  echo "manifest commit failed; the patched app was restored." >&2
  exit 1
fi
rm -rf "$OLD_BUNDLE"
OLD_BUNDLE=""
echo "[restore] complete. Original full signed app bundle restored from $ORIGINAL_BUNDLE. Reopen OpenCode manually."
