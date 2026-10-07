"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Windows IPv4 and IPv6 TCP table offsets identify the intended listening port", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const code = String.raw`
import importlib.util, pathlib, socket, struct, sys
spec = importlib.util.spec_from_file_location("tcp_table_fixture", pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
port = 47832
v4 = bytearray(4 + 24)
struct.pack_into("<I", v4, 0, 1)
struct.pack_into("<I", v4, 4, 2)
struct.pack_into("<I", v4, 12, socket.htons(port))
assert module._tcp_listener_table_has_port(bytes(v4), port, 24, 0, 8)
assert not module._tcp_listener_table_has_port(bytes(v4), port + 1, 24, 0, 8)
v6 = bytearray(4 + 56)
struct.pack_into("<I", v6, 0, 1)
struct.pack_into("<I", v6, 4 + 48, 2)
struct.pack_into("<I", v6, 4 + 20, socket.htons(port))
assert module._tcp_listener_table_has_port(bytes(v6), port, 56, 48, 20)
assert not module._tcp_listener_table_has_port(bytes(v6), port + 1, 56, 48, 20)
print("IPv4/IPv6 fixture offsets passed")
`;
  const result = spawnSync(python, ["-c", code, helper], { encoding: "utf8", windowsHide: true });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("model fallback pins each endpoint explicitly and config setup works with an isolated server import", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const code = String.raw`
import argparse, importlib.util, json, os, pathlib, socket, sys, tempfile, types
helper = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("installer_helper_fixture", helper)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
server = installer.load_voice_server()
mirror = "https://mirror.fixture.invalid"
official = "https://official.fixture.invalid"
calls = []
def snapshot_download(repo_id, local_dir, endpoint=None):
    calls.append(endpoint)
    assert os.environ.get("HF_HUB_DISABLE_XET") == "1"
    assert os.environ.get("HF_HUB_ENABLE_HF_TRANSFER") == "0"
    assert os.environ.get("HF_HUB_DISABLE_PROGRESS_BARS") == "1"
    if endpoint == mirror:
        raise RuntimeError("mirror unavailable in fixture")
    path = pathlib.Path(local_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text("{}", encoding="utf-8")
    (path / "model.bin").write_bytes(b"m" * (1024 * 1024 + 1))
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
sys.modules["huggingface_hub"] = types.SimpleNamespace(snapshot_download=snapshot_download)
with tempfile.TemporaryDirectory(prefix="oc-voice-installer-fixture-") as directory:
    root = pathlib.Path(directory)
    model_path = root / "model"
    downloaded = installer.download(argparse.Namespace(repo="fixture/model", model_path=str(model_path),
        backend="faster-whisper", endpoint=mirror, fallback_endpoint=official))
    assert calls == [mirror, official], calls
    voice_home = root / "voice-home"
    store = server.ConfigStore(voice_home)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    store.update({"port": free_port})
    configured = installer.configure(argparse.Namespace(voice_home=str(voice_home),
        model_path=str(model_path), backend="faster-whisper", device="cpu"))
    assert sys.modules.get("opencode_local_voice_server") is not None
    assert configured["config"]["model_path"] == str(model_path.resolve())
    assert "token" not in configured["config"]
    assert (root / "voice-home" / "token").is_file()
    print(json.dumps({"calls": calls, "downloaded": downloaded["path"],
        "configured": configured["config"]["model_path"], "server_module_registered": True}))
`;
  const result = spawnSync(python, ["-c", code, helper], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(output.calls, ["https://mirror.fixture.invalid", "https://official.fixture.invalid"]);
  assert.equal(output.server_module_registered, true);
});

test("service preflight previews first-run defaults without creating persistent config or credentials", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const code = String.raw`
import importlib.util, json, os, pathlib, socket, sys, tempfile
spec = importlib.util.spec_from_file_location("first_run_fixture", pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="oc-voice-first-run-") as directory:
    home = pathlib.Path(directory) / "new-voice-home"
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    old = os.environ.get("OPENCODE_STT_LOCAL_PORT")
    os.environ["OPENCODE_STT_LOCAL_PORT"] = str(port)
    try:
        result = module.stop_service(__import__("argparse").Namespace(voice_home=str(home)))
    finally:
        if old is None: os.environ.pop("OPENCODE_STT_LOCAL_PORT", None)
        else: os.environ["OPENCODE_STT_LOCAL_PORT"] = old
    assert result["service"]["state"] == "not_running"
    assert not home.exists(), "read-only preflight created persistent credentials/config"
    print(json.dumps({"state": result["service"]["state"], "persistent_files_created": False}))
`;
  const result = spawnSync(python, ["-c", code, helper], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    state: "not_running", persistent_files_created: false
  });
});

test("shared deploy publishes all runtime modules and the deployed CLI prints help offline", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const source = path.resolve(__dirname, "../shared");
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-cli-deploy-"));
  try {
    const deployCode = String.raw`
import argparse, importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("deploy_fixture", pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.deploy(argparse.Namespace(destination=sys.argv[2]))))
`;
    const deployed = spawnSync(python, ["-c", deployCode, helper, target], { encoding: "utf8", windowsHide: true });
    assert.equal(deployed.error, undefined, deployed.error && deployed.error.message);
    assert.equal(deployed.status, 0, deployed.stderr || deployed.stdout);
    const manifest = JSON.parse(deployed.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(manifest.files.map(entry => path.basename(entry.path)).sort(),
      ["desktop-bridge.cjs", "stt_server.py", "voice_cli.py", "voice_secrets.py", "voice_server.py", "voice_text.py"]);
    for (const name of ["voice_cli.py", "voice_server.py", "desktop-bridge.cjs", "voice_text.py", "voice_secrets.py"]) {
      assert.equal(fs.readFileSync(path.join(source, name), "utf8"), fs.readFileSync(path.join(target, name), "utf8"));
    }
    const cli = spawnSync(python, [path.join(target, "voice_cli.py"), "--help"], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.error, undefined, cli.error && cli.error.message);
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /--file AUDIO/);
    assert.match(cli.stdout, /--serve/);
    assert.ok(fs.existsSync(path.join(target, "stt_server.py")));
    assert.ok(fs.existsSync(path.join(target, "desktop-bridge.cjs")));
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

test("configure proves an idle legacy 0.3.5 service before sending its token and waits for its port to close", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const code = String.raw`
import argparse, importlib.util, json, pathlib, socket, sys, tempfile, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("shutdown_fixture", pathlib.Path(sys.argv[1]))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
voice = installer.load_voice_server()
observed = {"authorization": None, "body": None}
released = threading.Event()
installer._port_is_released = lambda port: released.is_set()
with tempfile.TemporaryDirectory(prefix="oc-voice-shutdown-fixture-") as directory:
    root = pathlib.Path(directory)
    model = root / "model"
    model.mkdir()
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.bin").write_bytes(b"m" * (1024 * 1024 + 1))
    (model / "tokenizer.json").write_text("{}", encoding="utf-8")
    home = root / "voice-home"
    store = voice.ConfigStore(home)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    store.update({"port": port})
    old_config = (home / "config.json").read_bytes()
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args): pass
        def respond(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
        def do_GET(self):
            challenge = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)["challenge"][0]
            self.respond(200, {"service": voice.SERVICE_NAME, "protocol": voice.PROTOCOL,
                "version": "0.3.5", "proof": voice.hmac_proof(store.token, challenge)})
        def do_POST(self):
            observed["authorization"] = self.headers.get("Authorization")
            observed["body"] = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.respond(202, {"status": "shutting_down"})
            def close_server():
                time.sleep(0.05)
                self.server.shutdown()
                self.server.server_close()
                released.set()
            threading.Thread(target=close_server, daemon=True).start()
    service = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    service_thread = threading.Thread(target=service.serve_forever, daemon=True)
    service_thread.start()
    stopped = installer.stop_service(argparse.Namespace(voice_home=str(home)))
    assert stopped["service"]["state"] == "stopped"
    assert (home / "config.json").read_bytes() == old_config, "preflight changed the stored config"
    result = installer.configure(argparse.Namespace(voice_home=str(home), model_path=str(model),
        backend="faster-whisper", device="cpu"))
    service_thread.join(timeout=2)
    assert not service_thread.is_alive(), "fixture service did not stop"
    assert observed["authorization"] == "Bearer " + store.token
    assert observed["body"] == b""
    assert result["service"]["state"] == "not_running"
    assert result["config"]["model_path"] == str(model.resolve())
    assert (home / "config.json").read_bytes() != old_config
    print(json.dumps({"state": result["service"]["state"], "preflight_stopped": stopped["service"]["state"] == "stopped",
        "auth_sent_after_proof": True,
        "zero_body": observed["body"] == b"", "config_written_after_close": True}))
`;
  const result = spawnSync(python, ["-c", code, helper], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    state: "not_running", preflight_stopped: true, auth_sent_after_proof: true, zero_body: true, config_written_after_close: true
  });
});

test("configure fails closed on foreign and busy local listeners without changing configuration", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const helper = path.resolve(__dirname, "../shared/install-support.py");
  const code = String.raw`
import argparse, importlib.util, json, pathlib, socket, sys, tempfile, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("refusal_fixture", pathlib.Path(sys.argv[1]))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
voice = installer.load_voice_server()
def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
def fixture(mode, home, model):
    store = voice.ConfigStore(home)
    port = free_port()
    store.update({"port": port})
    before = (home / "config.json").read_bytes()
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def respond(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            challenge = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)["challenge"][0]
            proof = "0" * 64 if mode == "foreign" else voice.hmac_proof(store.token, challenge)
            self.respond(200, {"service": voice.SERVICE_NAME, "protocol": voice.PROTOCOL,
                "version": voice.VERSION, "proof": proof})
        def do_POST(self):
            seen.append(self.headers.get("Authorization"))
            self.respond(409, {"error": "service is busy", "code": "conflict"})
    service = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    try:
        try:
            installer.configure(argparse.Namespace(voice_home=str(home), model_path=str(model),
                backend="faster-whisper", device="cpu"))
            raise AssertionError("configure unexpectedly accepted " + mode + " service")
        except RuntimeError as error:
            assert mode in str(error) or "local port" in str(error), str(error)
        assert (home / "config.json").read_bytes() == before, mode + " modified config"
        if mode == "foreign": assert seen == [], "token was sent to foreign service"
        else: assert seen == ["Bearer " + store.token], seen
    finally:
        service.shutdown()
        service.server_close()
        thread.join(timeout=2)
with tempfile.TemporaryDirectory(prefix="oc-voice-refusal-fixture-") as directory:
    root = pathlib.Path(directory)
    model = root / "model"
    model.mkdir()
    (model / "config.json").write_text("{}", encoding="utf-8")
    (model / "model.bin").write_bytes(b"m" * (1024 * 1024 + 1))
    (model / "tokenizer.json").write_text("{}", encoding="utf-8")
    fixture("foreign", root / "foreign-home", model)
    fixture("busy", root / "busy-home", model)
    print(json.dumps({"foreign_no_token": True, "busy_config_unchanged": True}))
`;
  const result = spawnSync(python, ["-c", code, helper], { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
    foreign_no_token: true, busy_config_unchanged: true
  });
});
