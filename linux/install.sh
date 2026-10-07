#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODEL="auto"
PYPI="https://pypi.tuna.tsinghua.edu.cn/simple"
APP="${OPENCODE_APP_PATH:-}"
INPUT=""
APPLY=0
DRY_RUN=0
SKIP_DEPS=0
SKIP_MODEL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) [ "$#" -ge 2 ] || { echo "--model requires a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --pypi) [ "$#" -ge 2 ] || { echo "--pypi requires a URL" >&2; exit 2; }; PYPI="$2"; shift 2 ;;
    --app) [ "$#" -ge 2 ] || { echo "--app requires an application directory" >&2; exit 2; }; APP="$2"; shift 2 ;;
    --input) [ "$#" -ge 2 ] || { echo "--input requires an app.asar path" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --no-apply) APPLY=0; shift ;;
    --dry-run) DRY_RUN=1; APPLY=0; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    -h|--help) echo "usage: ./install.sh [--model auto|large-v3-turbo|medium|small] [--pypi URL] [--app APP_DIR] [--input app.asar] [--apply|--no-apply|--dry-run] [--skip-deps] [--skip-model]"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODEL" in auto|large-v3-turbo|medium|small) ;; *) echo "invalid model preset: $MODEL" >&2; exit 2 ;; esac

if [ "$MODEL" = "auto" ]; then
  CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 4)"
  if [ "$CORES" -ge 8 ]; then MODEL="medium"; else MODEL="small"; fi
  echo "[install] automatic model: $MODEL ($CORES logical cores)"
fi
case "$MODEL" in
  large-v3-turbo) REPO="deepdml/faster-whisper-large-v3-turbo-ct2" ;;
  medium) REPO="Systran/faster-whisper-medium" ;;
  small) REPO="Systran/faster-whisper-small" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  [ -n "$APP" ] && [ -d "$APP" ] || { echo "--dry-run requires --app with the application directory." >&2; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "Node.js is required for patch candidate generation." >&2; exit 1; }
  DRY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oc-voice-dry-run.XXXXXX")"
  if [ -n "$INPUT" ]; then
    node "$HERE/patch-oc-mic.js" --app "$APP" --input "$INPUT" --output "$DRY_DIR/app.asar.patched"
  else
    node "$HERE/patch-oc-mic.js" --app "$APP" --output "$DRY_DIR/app.asar.patched"
  fi
  echo "[install] dry run complete: $DRY_DIR/app.asar.patched. No dependencies, model, config, service, or app files were changed."
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { echo "Python 3.10 or newer is required." >&2; exit 1; }
PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || { echo "Python 3.10 or newer is required; found $PY_VERSION." >&2; exit 1; }
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  echo "[install] NVIDIA GPU detected. For CUDA inference, install system CUDA 12 and cuDNN 9 compatible with CTranslate2; otherwise the service will use its CPU fallback."
fi
BASE="$HOME/.config/opencode"
VOICE_HOME="${OPENCODE_VOICE_HOME:-$BASE/local-voice}"
VENV="$BASE/whisper-venv"
VENV_PY="$VENV/bin/python"
WHISPER="$BASE/whisper"
MODEL_PATH="$VOICE_HOME/models/faster-whisper-$MODEL"
HELPER="$ROOT/shared/install-support.py"
echo "[install] checking and stopping only an authenticated idle local voice service before dependency changes ..."
python3 "$HELPER" stop-service --voice-home "$VOICE_HOME"
if [ "$SKIP_DEPS" -eq 0 ]; then
  if [ ! -x "$VENV_PY" ]; then
    echo "[install] creating isolated Python environment: $VENV"
    python3 -m venv "$VENV"
  fi
  echo "[install] installing pinned runtime requirements ..."
  if ! "$VENV_PY" -m pip install -q --disable-pip-version-check -i "$PYPI" -r "$ROOT/requirements.txt"; then
    echo "[install] package mirror failed; retrying with official PyPI ..." >&2
    "$VENV_PY" -m pip install -q --disable-pip-version-check -r "$ROOT/requirements.txt"
  fi
elif [ ! -x "$VENV_PY" ]; then
  echo "--skip-deps was set, but the existing voice virtual environment is missing: $VENV_PY" >&2
  exit 1
fi

if [ -d "$MODEL_PATH" ] && "$VENV_PY" "$HELPER" validate-model --backend faster-whisper --model-path "$MODEL_PATH"; then
  echo "[install] verified existing local model: $MODEL_PATH"
else
  if [ "$SKIP_MODEL" -eq 1 ]; then echo "--skip-model was set, but the local model is missing or incomplete: $MODEL_PATH" >&2; exit 1; fi
  echo "[install] downloading local faster-whisper model $REPO ..."
  "$VENV_PY" "$HELPER" download-model --backend faster-whisper --repo "$REPO" --model-path "$MODEL_PATH"
fi

"$VENV_PY" "$HELPER" configure --backend faster-whisper --device auto --model-path "$MODEL_PATH" --voice-home "$VOICE_HOME"
"$VENV_PY" "$HELPER" deploy --destination "$WHISPER"
for name in stt_server.py voice_server.py voice_cli.py desktop-bridge.cjs; do
  [ -f "$WHISPER/$name" ] || { echo "voice runtime deployment is missing $name" >&2; exit 1; }
done

if [ "$APPLY" -eq 1 ]; then
  [ -n "$APP" ] && [ -d "$APP" ] || { echo "--apply requires --app or OPENCODE_APP_PATH." >&2; exit 1; }
  if [ -n "$INPUT" ]; then bash "$HERE/apply-oc-mic.sh" --app "$APP" --input "$INPUT"; else bash "$HERE/apply-oc-mic.sh" --app "$APP"; fi
else
  echo "[install] runtime and CLI installed. Run bash $HERE/voice-cli.sh --file AUDIO or --record --mic NAME."
  echo "[install] to add the desktop patch, run bash $HERE/apply-oc-mic.sh --app APP_DIR after closing OpenCode."
fi
