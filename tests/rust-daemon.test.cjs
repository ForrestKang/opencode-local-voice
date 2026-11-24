"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const bridge = require("../shared/desktop-bridge.cjs");

const DAEMON_BIN = path.resolve(
  __dirname,
  "../rust/oc-voice-daemon/target/release",
  process.platform === "win32" ? "oc-voice-daemon.exe" : "oc-voice-daemon",
);

function makeSilentWav16k(durationSec = 0.25) {
  const samples = Math.floor(16000 * durationSec);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

test("Rust single-binary daemon integrates end-to-end with desktop-bridge without Python", { skip: !fs.existsSync(DAEMON_BIN) }, async t => {
  const scratchBase = path.dirname(DAEMON_BIN);
  const root = fs.mkdtempSync(path.join(scratchBase, "oc-rust-daemon-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const voiceHome = path.join(root, "local-voice");
  fs.mkdirSync(voiceHome, { recursive: true });

  // Start a local mock OpenAI-compatible STT + AI rewrite upstream
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      upstreamRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", size: raw.length });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/audio/transcriptions") {
        res.end(JSON.stringify({
          text: "请帮我检查一下OpenCode的Python接口如果有报错就先看日志然后再修改配置文件",
          language: "zh",
        }));
        return;
      }
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "whisper-large-v3-turbo" }, { id: "gpt-4o-mini-transcribe" }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown route" }));
    });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;

  const daemonPort = await findFreePort();
  fs.writeFileSync(path.join(voiceHome, "config.json"), JSON.stringify({
    backend: "openai-compatible",
    port: daemonPort,
    language: "auto",
    punctuation_mode: "zh",
    space_mode: "smart",
    text_mode: "clean",
    stt_base_url: upstreamBase,
    stt_model: "whisper-large-v3-turbo",
  }, null, 2));

  // Pre-seed token or let daemon create it on first boot — wait: desktop-bridge reads token when probing,
  // so test that daemon creates token cleanly on boot when absent or uses existing token.
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(path.join(voiceHome, "token"), token + "\n");

  const client = bridge.createClient({
    voiceHome,
    daemon: DAEMON_BIN,
    // Intentionally pass nonexistent python path to prove ZERO Python dependency!
    python: path.join(root, "no-python-here.exe"),
    server: path.join(root, "no-server-here.py"),
    startupTimeout: 8000,
    jobTimeout: 15000,
  });

  t.after(() => {
    spawnSync(DAEMON_BIN, ["stop-service", "--voice-home", voiceHome], { windowsHide: true, timeout: 5000 });
  });

  // 1) Cold start + HMAC identity handshake
  const health = await client.ensure();
  assert.equal(health.service, "opencode-local-voice");
  assert.equal(health.protocol, 1);
  assert.equal(health.runtime, "rust");

  // 2) Status + config + write-only secret storage (DPAPI on Windows)
  const status = await client.status();
  assert.equal(status.runtime, "rust");
  assert.equal(status.backend, "openai-compatible");

  const patched = await client.saveConfig({ stt_api_key: "sk-rust-test-secret-12345" });
  assert.equal(patched.stt_api_key_set, true);
  assert.equal(patched.stt_api_key, undefined);
  const savedKeyRaw = fs.readFileSync(path.join(voiceHome, "stt_api_key"), "utf8");
  if (process.platform === "win32") {
    assert.ok(savedKeyRaw.startsWith("DPAPI1:"), "Windows secret must be DPAPI encrypted");
    assert.ok(!savedKeyRaw.includes("sk-rust-test-secret-12345"));
  }

  // 3) Remote model listing via Rust daemon
  const modelsRes = await client.listSttModels({ stt_base_url: upstreamBase });
  assert.equal(modelsRes.ok, true);
  assert.deepEqual(modelsRes.models, ["whisper-large-v3-turbo", "gpt-4o-mini-transcribe"]);

  // 4) Local Chinese punctuation & auto-segmentation preview
  const preview = await client.previewText(
    "我记得设置里面有标点符号优化 但是之前试过 没法自动断句 能不能帮我看看",
    { text_mode: "clean", punctuation_mode: "zh", space_mode: "smart", language: "zh" },
  );
  assert.equal(preview.text, "我记得设置里面有标点符号优化，但是之前试过，没法自动断句，能不能帮我看看？");

  // 5) Full end-to-end WAV transcription + Chinese auto-segmentation + Authorization header forwarding
  const states = [];
  const job = await client.transcribe(makeSilentWav16k(0.25), "audio/wav", crypto.randomUUID(), p => {
    if (p && p.state) states.push(p.state);
  });
  assert.equal(job.text, "请帮我检查一下 OpenCode 的 Python 接口，如果有报错就先看日志，然后再修改配置文件。");
  assert.equal(job.processing_warning, null);
  assert.ok(upstreamRequests.some(r => r.url === "/v1/audio/transcriptions" && r.auth === "Bearer sk-rust-test-secret-12345"));

  // 6) Zero-Python CLI health & stop-service
  const cliHealth = spawnSync(DAEMON_BIN, ["health", "--voice-home", voiceHome], { encoding: "utf8", windowsHide: true });
  assert.equal(cliHealth.status, 0);
  assert.equal(JSON.parse(cliHealth.stdout).runtime, "rust");

  const cliStop = spawnSync(DAEMON_BIN, ["stop-service", "--voice-home", voiceHome], { encoding: "utf8", windowsHide: true });
  assert.equal(cliStop.status, 0);
  assert.equal(JSON.parse(cliStop.stdout).service.state, "stopped");
});
