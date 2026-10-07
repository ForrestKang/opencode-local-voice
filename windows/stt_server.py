"""Windows thin launcher for the shared OpenCode Local Voice service."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared.voice_server import main


if __name__ == "__main__":
    raise SystemExit(main(["--serve", *sys.argv[1:]]))
