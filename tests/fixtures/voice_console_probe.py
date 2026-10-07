"""Instrument an isolated real service process without changing service code."""
import ctypes
import json
import os
from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetConsoleWindow.restype = ctypes.c_void_p
    home = Path(os.environ["OPENCODE_VOICE_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "console-probe.json").write_text(json.dumps({
        "pid": os.getpid(), "python": sys.executable,
        "consoleWindow": kernel32.GetConsoleWindow() or 0,
    }), encoding="utf-8")
    service = os.environ["OPENCODE_VOICE_TEST_SERVER"]
    sys.path.insert(0, str(Path(service).parent))
    runpy.run_path(service, run_name="__main__")
