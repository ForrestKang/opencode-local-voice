#!/bin/bash
set -euo pipefail
VENV_PY="${HOME}/.config/opencode/whisper-venv/bin/python"
CLI="${HOME}/.config/opencode/whisper/voice_cli.py"
if [ ! -x "$VENV_PY" ] || [ ! -f "$CLI" ]; then
  echo "OpenCode Local Voice CLI is not installed. Run linux/install.sh first." >&2
  exit 1
fi
exec "$VENV_PY" "$CLI" "$@"
