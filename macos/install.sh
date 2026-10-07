#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODEL="auto"
PYPI="https://pypi.tuna.tsinghua.edu.cn/simple"
APPLY=1
DRY_RUN=0
SKIP_DEPS=0
SKIP_MODEL=0
APP="${OPENCODE_APP_PATH:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) [ "$#" -ge 2 ] || { echo "--model requires a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --pypi) [ "$#" -ge 2 ] || { echo "--pypi requires a URL" >&2; exit 2; }; PYPI="$2"; shift 2 ;;
    --app) [ "$#" -ge 2 ] || { echo "--app requires an app path" >&2; exit 2; }; APP="$2"; shift 2 ;;
    --no-apply) APPLY=0; shift ;;
    --dry-run) DRY_RUN=1; APPLY=0; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    -h|--help) echo "usage: ./install.sh [--model auto|large-v3-turbo|medium|small] [--pypi URL] [--app OpenCode.app] [--skip-deps] [--skip-model] [--no-apply|--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODEL" in auto|large-v3-turbo|medium|small) ;; *) echo "invalid model preset: $MODEL" >&2; exit 2 ;; esac

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then BACKEND="mlx"; DEVICE="auto"; else BACKEND="faster-whisper"; DEVICE="cpu"; fi
if [ "$MODEL" = "auto" ]; then
  if [ "$ARCH" = "arm64" ]; then MODEL="large-v3-turbo"; else MODEL="medium"; fi
  echo "[install] automatic model: $MODEL (architecture $ARCH, backend $BACKEND)"
fi
if [ "$BACKEND" = "mlx" ]; then
  case "$MODEL" in
    large-v3-turbo) REPO="mlx-community/whisper-large-v3-turbo" ;;
    medium) REPO="mlx-community/whisper-medium-mlx" ;;
    small) REPO="mlx-community/whisper-small-mlx" ;;
  esac
else
  case "$MODEL" in
    large-v3-turbo) REPO="deepdml/faster-whisper-large-v3-turbo-ct2" ;;
    medium) REPO="Systran/faster-whisper-medium" ;;
    small) REPO="Systran/faster-whisper-small" ;;
  esac
fi

NEEDS_DESKTOP=0
if [ "$APPLY" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then NEEDS_DESKTOP=1; fi
if [ "$NEEDS_DESKTOP" -eq 1 ]; then
  if [ -z "$APP" ]; then
    for candidate in "/Applications/OpenCode.app" "$HOME/Applications/OpenCode.app"; do
      if [ -d "$candidate" ]; then APP="$candidate"; break; fi
    done
  fi
  [ -n "$APP" ] && [ -d "$APP" ] || { echo "OpenCode.app not found; pass --app or set OPENCODE_APP_PATH." >&2; exit 1; }
  APP="$(cd "$APP" && pwd -P)"
  ASAR="$APP/Contents/Resources/app.asar"
  [ -f "$ASAR" ] || { echo "OpenCode.app has no Contents/Resources/app.asar; refusing an unknown layout." >&2; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "Node.js is required." >&2; exit 1; }
fi

if [ "$DRY_RUN" -eq 1 ]; then
  DRY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oc-voice-dry-run.XXXXXX")"
  node "$HERE/patch-oc-mic.js" --app "$APP" --input "$ASAR" --output "$DRY_DIR/app.asar.patched"
  echo "[install] dry run complete: $DRY_DIR/app.asar.patched. No service, model, config, or app files were changed."
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "Python 3.10 or newer is required." >&2; exit 1; }
PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || { echo "Python 3.10 or newer is required; found $PY_VERSION." >&2; exit 1; }

BASE="$HOME/.config/opencode"
VOICE_HOME="${OPENCODE_VOICE_HOME:-$BASE/local-voice}"
VENV="$BASE/whisper-venv"
VENV_PY="$VENV/bin/python"
WHISPER="$BASE/whisper"
MODEL_PATH="$VOICE_HOME/models/$BACKEND-$MODEL"
HELPER="$ROOT/shared/install-support.py"
REQUIREMENTS="$ROOT/requirements.txt"

echo "[install] checking and stopping only an authenticated idle local voice service before dependency changes ..."
python3 "$HELPER" stop-service --voice-home "$VOICE_HOME"

if [ "$SKIP_DEPS" -eq 0 ]; then
  if [ ! -x "$VENV_PY" ]; then
    echo "[install] creating isolated Python environment: $VENV"
    python3 -m venv "$VENV"
  fi
  echo "[install] installing pinned runtime requirements ..."
  if ! "$VENV_PY" -m pip install -q --disable-pip-version-check -i "$PYPI" -r "$REQUIREMENTS"; then
    echo "[install] package mirror failed; retrying with official PyPI ..." >&2
    "$VENV_PY" -m pip install -q --disable-pip-version-check -r "$REQUIREMENTS"
  fi
elif [ ! -x "$VENV_PY" ]; then
  echo "--skip-deps was set, but the existing voice virtual environment is missing: $VENV_PY" >&2
  exit 1
fi

if [ -d "$MODEL_PATH" ] && "$VENV_PY" "$HELPER" validate-model --backend "$BACKEND" --model-path "$MODEL_PATH"; then
  echo "[install] verified existing local model: $MODEL_PATH"
else
  if [ "$SKIP_MODEL" -eq 1 ]; then echo "--skip-model was set, but the local model is missing or incomplete: $MODEL_PATH" >&2; exit 1; fi
  echo "[install] downloading local $BACKEND model $REPO ..."
  "$VENV_PY" "$HELPER" download-model --backend "$BACKEND" --repo "$REPO" --model-path "$MODEL_PATH"
fi

echo "[install] persisting backend, device, and model path in local-voice/config.json ..."
"$VENV_PY" "$HELPER" configure --backend "$BACKEND" --device "$DEVICE" --model-path "$MODEL_PATH" --voice-home "$VOICE_HOME"

"$VENV_PY" "$HELPER" deploy --destination "$WHISPER"
for name in stt_server.py voice_server.py voice_cli.py desktop-bridge.cjs; do
  [ -f "$WHISPER/$name" ] || { echo "voice runtime deployment is missing $name" >&2; exit 1; }
done

if [ "$APPLY" -eq 1 ]; then
  bash "$HERE/apply-oc-mic.sh" --app "$APP"
else
  if [ -n "$APP" ]; then echo "[install] runtime installed; desktop patch was not applied. Run bash ./apply-oc-mic.sh --app \"$APP\" after closing OpenCode."
  else echo "[install] runtime installed without requiring the desktop app. Run bash ./apply-oc-mic.sh --app OpenCode.app after closing OpenCode if you use the desktop client."; fi
fi
