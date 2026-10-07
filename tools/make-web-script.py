#!/usr/bin/env python3
"""Generate a private, origin-scoped Web adapter; never distribute its token."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))
from voice_server import ConfigStore, validate_config
from voice_cli import ensure_server, _read_json_response


def generate(origin, destination, store):
    output = Path(destination).expanduser().resolve()
    if not output.name.endswith(".personal.user.js"):
        raise ValueError("Output must end with .personal.user.js so release packaging excludes it")
    parsed = urlsplit(origin)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("--origin must be an exact HTTP(S) origin, without a path or credentials")
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    config = store.get()
    validate_config({**config, "allowed_origins": [*config["allowed_origins"], origin]})
    ensure_server(store)
    address = f"http://127.0.0.1:{config['port']}"
    status, response = _read_json_response(address + "/v1/config", method="PATCH", token=store.token,
        data=json.dumps({"allowed_origins": sorted(set([*config["allowed_origins"], origin]))}).encode(),
        headers={"Content-Type": "application/json"})
    if status != 200:
        raise RuntimeError(response.get("error", "Could not pair Web origin"))
    connection = json.dumps({"url": address, "token": store.token}, ensure_ascii=True)
    transport = (ROOT / "shared" / "browser-transport.js").read_text(encoding="utf-8")
    renderer = (ROOT / "shared" / "oc-mic.js").read_text(encoding="utf-8")
    header = "// ==UserScript==\n// @name OpenCode Local Voice (private pairing)\n// @version 0.2.0\n// @match " + origin + "/*\n// @grant none\n// @run-at document-idle\n// ==/UserScript==\n"
    script = header + "// PRIVATE: contains a local credential. Do not publish or share.\n;(function(){\nif(location.origin!==" + json.dumps(origin) + ")return;\n" + transport + "\nwindow.ocVoiceTransport=window.createOcVoiceTransport(" + connection + ");\n" + renderer + "\n})();\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
        handle.write(script)
    if os.name != "nt": output.chmod(0o600)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://localhost:4096", help="The exact origin of your OpenCode Web client")
    parser.add_argument("--output", help="Private .personal.user.js output path")
    parser.add_argument("--config", help="Local Voice configuration directory")
    args = parser.parse_args()
    store = ConfigStore(args.config) if args.config else ConfigStore()
    filename = args.output or str(store.home / "opencode-voice.personal.user.js")
    try:
        output = generate(args.origin, filename, store)
        print("Private Web adapter saved to " + str(output))
        print("Import it into your userscript manager. Keep it on this machine; it contains a credential.")
        return 0
    except Exception as error:
        print("Web pairing failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
