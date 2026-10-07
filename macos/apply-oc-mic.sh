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
    -h|--help) echo "usage: ./apply-oc-mic.sh [--app App.app] [--input app.asar] [--output candidate.asar] [--dry-run]"; exit 0 ;;
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
PLIST="$APP/Contents/Info.plist"
[ -d "$RES" ] && [ -f "$PLIST" ] || { echo "unknown macOS app bundle layout; refusing to patch." >&2; exit 1; }
if [ -z "$INPUT" ]; then INPUT="$RES/app.asar"; fi
INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
[ -f "$INPUT" ] || { echo "app.asar not found: $INPUT" >&2; exit 1; }
if [ "$DRY_RUN" -eq 0 ] && [ "$INPUT" != "$RES/app.asar" ]; then
  echo "for bundle apply, --input must be this app's Contents/Resources/app.asar." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
command -v ditto >/dev/null 2>&1 || { echo "ditto is required for a full-fidelity bundle backup." >&2; exit 1; }
command -v codesign >/dev/null 2>&1 || { echo "codesign is required; refusing an unsigned patch." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to inspect the bundle manifest." >&2; exit 1; }

STAGE=""
OLD_BUNDLE=""
PATCHED_ASAR=""
cleanup() {
  if [ -n "$OLD_BUNDLE" ] && [ -d "$OLD_BUNDLE" ] && [ ! -e "$APP" ]; then mv "$OLD_BUNDLE" "$APP" || true; fi
  if [ -n "$STAGE" ] && [ "$DRY_RUN" -eq 0 ]; then rm -rf "$STAGE"; fi
}
trap cleanup EXIT HUP INT TERM

if [ "$DRY_RUN" -eq 0 ] && pgrep -x "OpenCode" >/dev/null 2>&1; then
  echo "OpenCode is running. Close it manually before applying; this script never terminates it." >&2
  exit 1
fi

if [ -n "$OUTPUT" ]; then
  PATCHED_ASAR="$OUTPUT"
else
  if [ "$DRY_RUN" -eq 1 ]; then
    STAGE="$(mktemp -d "${TMPDIR:-/tmp}/oc-voice-dry-run.XXXXXX")"
  else
    STAGE="$(mktemp -d "$(dirname "$APP")/.oc-voice-stage.XXXXXX")"
  fi
  PATCHED_ASAR="$STAGE/app.asar.patched"
fi

echo "[patch] generating and validating isolated app.asar candidate ..."
node "$HERE/patch-oc-mic.js" --app "$APP" --input "$INPUT" --output "$PATCHED_ASAR"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "[patch] dry run complete: $PATCHED_ASAR (no app files changed)"
  exit 0
fi

if [ -n "$OUTPUT" ]; then
  STAGE="$(mktemp -d "$(dirname "$APP")/.oc-voice-stage.XXXXXX")"
fi
CANDIDATE="$STAGE/$(basename "$APP")"
ditto --rsrc --extattr --acl "$APP" "$CANDIDATE"
[ -d "$CANDIDATE" ] || { echo "full app candidate copy failed." >&2; exit 1; }
CANDIDATE_ASAR="$CANDIDATE/Contents/Resources/app.asar"
ORIGINAL_HASH="$(shasum -a 256 "$INPUT" | awk '{print $1}')"
ASAR_MODE="$(stat -f '%Lp' "$INPUT")"
cp "$PATCHED_ASAR" "$CANDIDATE_ASAR"
chmod "$ASAR_MODE" "$CANDIDATE_ASAR"
PATCHED_HASH="$(shasum -a 256 "$CANDIDATE_ASAR" | awk '{print $1}')"
[ -n "$PATCHED_HASH" ] && [ "$PATCHED_HASH" != "$ORIGINAL_HASH" ] || { echo "candidate ASAR hash verification failed." >&2; exit 1; }

CANDIDATE_PLIST="$CANDIDATE/Contents/Info.plist"
if ! /usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$CANDIDATE_PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string OpenCode uses the microphone for local voice input.' "$CANDIDATE_PLIST"
fi

read_integrity_fuse() {
  local bundle="$1" output value
  output="$(npx --yes @electron/fuses@2.1.3 read --app "$bundle")" || return 1
  value="$(printf '%s\n' "$output" | awk -F': ' '/^EnableEmbeddedAsarIntegrityValidation: (Enabled|Disabled)$/ {print $2}')"
  [ "$value" = "Enabled" ] || [ "$value" = "Disabled" ] || return 1
  printf '%s' "$value"
}
FUSE_BEFORE="$(read_integrity_fuse "$APP")" || { echo "pinned @electron/fuses@2.1.3 could not read the app fuse; refusing to continue." >&2; exit 1; }
if [ "$FUSE_BEFORE" = "Enabled" ]; then
  echo "[patch] embedded ASAR integrity validation is enabled; changing only the candidate bundle."
  npx --yes @electron/fuses@2.1.3 write --app "$CANDIDATE" EnableEmbeddedAsarIntegrityValidation=off
fi
FUSE_AFTER="$(read_integrity_fuse "$CANDIDATE")" || { echo "pinned @electron/fuses@2.1.3 could not verify the candidate fuse; refusing to continue." >&2; exit 1; }
if [ "$FUSE_BEFORE" = "Enabled" ] && [ "$FUSE_AFTER" != "Disabled" ]; then
  echo "candidate embedded ASAR integrity fuse did not turn off." >&2; exit 1
fi

codesign --force --deep --sign - "$CANDIDATE"
codesign --verify --deep --strict --verbose=2 "$CANDIDATE"

SUPPORT="$ROOT/shared/install-support.cjs"
LAYOUT="$(node "$SUPPORT" bundle-backup-path --app "$APP" --input "$INPUT" --backup-root "$BACKUP_ROOT")"
MANIFEST_DIR="$(printf '%s' "$LAYOUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["directory"])')"
ORIGINAL_BUNDLE="$(printf '%s' "$LAYOUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["originalBundle"])')"
mkdir -p "$(dirname "$ORIGINAL_BUNDLE")"
if [ -e "$ORIGINAL_BUNDLE" ]; then
  BACKUP_HASH="$(shasum -a 256 "$ORIGINAL_BUNDLE/Contents/Resources/app.asar" 2>/dev/null | awk '{print $1}')"
  [ "$BACKUP_HASH" = "$ORIGINAL_HASH" ] || { echo "existing full-bundle backup is corrupt or bound to another archive." >&2; exit 1; }
else
  ditto --rsrc --extattr --acl "$APP" "$ORIGINAL_BUNDLE"
fi

node "$SUPPORT" prepare-bundle --app "$APP" --candidate "$CANDIDATE" --input "$INPUT" --patched "$CANDIDATE_ASAR" \
  --original-bundle "$ORIGINAL_BUNDLE" --backup-root "$BACKUP_ROOT" --fuse-before "$FUSE_BEFORE" --fuse-after "$FUSE_AFTER"

OLD_BUNDLE="$(dirname "$APP")/.$(basename "$APP").oc-voice-old.$$"
[ ! -e "$OLD_BUNDLE" ] || { echo "swap path already exists: $OLD_BUNDLE" >&2; exit 1; }
mv "$APP" "$OLD_BUNDLE"
if ! mv "$CANDIDATE" "$APP"; then
  mv "$OLD_BUNDLE" "$APP"
  OLD_BUNDLE=""
  echo "bundle swap failed; original app was put back." >&2
  exit 1
fi
if ! node "$SUPPORT" set-bundle-state --app "$APP" --input "$RES/app.asar" --backup-root "$BACKUP_ROOT" --state applied; then
  mv "$APP" "$CANDIDATE"
  mv "$OLD_BUNDLE" "$APP"
  OLD_BUNDLE=""
  node "$SUPPORT" set-bundle-state --app "$APP" --input "$RES/app.asar" --backup-root "$BACKUP_ROOT" --state apply-failed >/dev/null 2>&1 || true
  echo "manifest commit failed; original app was restored." >&2
  exit 1
fi
rm -rf "$OLD_BUNDLE"
OLD_BUNDLE=""
echo "[patch] complete. Original signed bundle and fuse state are saved under $MANIFEST_DIR. Reopen OpenCode manually."
