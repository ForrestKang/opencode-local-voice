#!/bin/bash
# OpenCode Voice — macOS: apply the mic patch to the OpenCode desktop app
set -euo pipefail
cd "$(dirname "$0")"

APP="${OPENCODE_APP_PATH:-}"
if [ -z "$APP" ]; then
  for c in "/Applications/OpenCode.app" "$HOME/Applications/OpenCode.app"; do
    if [ -d "$c" ]; then APP="$c"; break; fi
  done
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "OpenCode.app not found. Set OPENCODE_APP_PATH=/path/to/OpenCode.app and retry."
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "Node.js not found (brew install node)."; exit 1; }

RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
BAK="$(pwd)/backup"
mkdir -p "$BAK"

echo "[1/6] generating patched app.asar ..."
OPENCODE_APP_PATH="$APP" node patch-oc-mic.js

echo "[2/6] closing OpenCode ..."
osascript -e 'quit app "OpenCode"' >/dev/null 2>&1 || true
pkill -f "OpenCode.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 2

echo "[3/6] checking Electron fuses ..."
if command -v npx >/dev/null 2>&1; then
  if npx --yes @electron/fuses read --app "$APP" 2>/dev/null | grep -q "EnableEmbeddedAsarIntegrityValidation is Enabled"; then
    echo "      embedded asar integrity is enabled -> disabling (required for the patch)"
    npx --yes @electron/fuses write --app "$APP" EnableEmbeddedAsarIntegrityValidation=off
  fi
fi

echo "[4/6] installing patched app.asar ..."
if [ ! -f "$BAK/app.asar.original" ]; then cp "$RES/app.asar" "$BAK/app.asar.original"; fi
cp "$RES/app.asar" "$BAK/app.asar.bak"
cp app.asar.patched "$RES/app.asar"

echo "[5/6] microphone permission entry (Info.plist) ..."
if ! /usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$PLIST" >/dev/null 2>&1; then
  if [ ! -f "$BAK/Info.plist.original" ]; then cp "$PLIST" "$BAK/Info.plist.original"; fi
  /usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string "OpenCode uses the microphone for local voice input."' "$PLIST"
  echo "      added NSMicrophoneUsageDescription"
fi

echo "[6/6] re-signing (ad-hoc) and restarting ..."
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
open "$APP"
echo
echo "Done. A microphone button appears on the prompt toolbar."
echo "First use: allow the microphone when macOS asks."
