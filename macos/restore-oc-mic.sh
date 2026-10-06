#!/bin/bash
# OpenCode Voice — macOS: restore the original OpenCode desktop app
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

BAK="$(pwd)/backup"
RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$BAK/app.asar.original" ] && [ ! -f "$BAK/app.asar.bak" ]; then
  echo "No backup found in $BAK - cannot restore."
  exit 1
fi

osascript -e 'quit app "OpenCode"' >/dev/null 2>&1 || true
pkill -f "OpenCode.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 2

if [ -f "$BAK/app.asar.original" ]; then
  cp "$BAK/app.asar.original" "$RES/app.asar"
else
  cp "$BAK/app.asar.bak" "$RES/app.asar"
fi

if [ -f "$BAK/Info.plist.original" ]; then
  cp "$BAK/Info.plist.original" "$PLIST"
fi

xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP"
open "$APP"
echo "Restored the original app and restarted OpenCode."
