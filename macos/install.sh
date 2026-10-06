#!/bin/bash
# OpenCode Voice — macOS: one-click setup (deps + model + patch)
set -euo pipefail
cd "$(dirname "$0")"

MODEL="large-v3-turbo"
PYPI="https://pypi.tuna.tsinghua.edu.cn/simple"
APPLY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --model)    MODEL="$2"; shift 2 ;;
    --pypi)     PYPI="$2"; shift 2 ;;
    --no-apply) APPLY=0; shift ;;
    -h|--help)
      echo "usage: ./install.sh [--model large-v3-turbo|medium|small] [--pypi <index-url>] [--no-apply]"
      exit 0 ;;
    *) echo "unknown argument: $1"; exit 1 ;;
  esac
done

BASE="$HOME/.config/opencode"
VENV="$BASE/whisper-venv"
WHISPER="$BASE/whisper"
MODELDIR="$BASE/whisper-models/$MODEL"

case "$MODEL" in
  large-v3-turbo) REPO="deepdml/faster-whisper-large-v3-turbo-ct2" ;;
  medium)         REPO="Systran/faster-whisper-medium" ;;
  small)          REPO="Systran/faster-whisper-small" ;;
  *) echo "model must be one of: large-v3-turbo | medium | small"; exit 1 ;;
esac

echo "[install] checking prerequisites ..."
command -v python3 >/dev/null 2>&1 || { echo "python3 not found (install Python 3.10+)."; exit 1; }
command -v node    >/dev/null 2>&1 || { echo "node not found (brew install node)."; exit 1; }

if [ ! -x "$VENV/bin/python" ]; then
  echo "[install] creating virtualenv: $VENV"
  python3 -m venv "$VENV"
fi

echo "[install] installing faster-whisper ..."
"$VENV/bin/python" -m pip install -q --disable-pip-version-check -i "$PYPI" faster-whisper

if [ ! -f "$MODELDIR/model.bin" ]; then
  echo "[install] downloading model $MODEL (via hf-mirror, large file, be patient) ..."
  mkdir -p "$MODELDIR"
  HF_ENDPOINT="https://hf-mirror.com" \
  HF_HUB_DISABLE_XET=1 \
  HF_HUB_ENABLE_HF_TRANSFER=0 \
  HF_HUB_DISABLE_PROGRESS_BARS=1 \
    "$VENV/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('$REPO', local_dir=r'$MODELDIR')"
else
  echo "[install] model already present: $MODELDIR"
fi

if [ "$MODEL" != "large-v3-turbo" ]; then
  echo "[install] note: add this to ~/.zshrc so the service finds the model:"
  echo "          export OPENCODE_WHISPER_MODEL_DIR=\"$MODELDIR\""
fi

echo "[install] deploying recognition service ..."
mkdir -p "$WHISPER"
cp stt_server.py "$WHISPER/stt_server.py"

if [ "$APPLY" = "1" ]; then
  chmod +x apply-oc-mic.sh restore-oc-mic.sh 2>/dev/null || true
  ./apply-oc-mic.sh
else
  echo "[install] done (patch not applied). Run ./apply-oc-mic.sh to apply it."
fi
