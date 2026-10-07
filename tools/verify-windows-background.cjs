"use strict";
// Run with a real installed venv interpreter and server. Uses an isolated
// config/port, loads no speech model and records no microphone audio.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const os = require("node:os"), net = require("node:net"), http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { createClient } = require("../shared/desktop-bridge.cjs");

async function main() {
  assert.equal(process.platform, "win32");
  const [python, server, reportFile] = process.argv.slice(2);
  assert.ok(python && server && reportFile, "Usage: node tools/verify-windows-background.cjs PYTHON SERVER REPORT");
  assert.ok(fs.existsSync(python) && fs.existsSync(server));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-no-console-"));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, idle_seconds: 60 }));
  const terminalPids = () => {
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='WindowsTerminal.exe'\").ProcessId | ConvertTo-Json -Compress"], { windowsHide: true, encoding: "utf8" }).trim();
    return result ? [].concat(JSON.parse(result)) : [];
  };
  const before = terminalPids();
  const launcher = path.join(home, "launch.cjs");
  fs.writeFileSync(launcher, `const { createClient } = require(${JSON.stringify(require.resolve("../shared/desktop-bridge.cjs"))});
    createClient({python:${JSON.stringify(python)},server:${JSON.stringify(path.resolve(__dirname, "../tests/fixtures/voice_console_probe.py"))},voiceHome:${JSON.stringify(home)}})
      .status().then(status=>console.log(JSON.stringify(status))).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    const parent = spawn(process.execPath, [launcher], { windowsHide: true,
      env: { ...process.env, OPENCODE_VOICE_TEST_SERVER: path.resolve(server) }, stdio: ["ignore", "pipe", "pipe"] });
    const output = []; parent.stdout.on("data", bytes => output.push(bytes)); parent.stderr.on("data", bytes => output.push(bytes));
    const exit = await new Promise((resolve, reject) => { parent.on("error", reject); parent.on("exit", resolve); });
    assert.equal(exit, 0, Buffer.concat(output).toString());
    const probe = JSON.parse(fs.readFileSync(path.join(home, "console-probe.json"), "utf8"));
    assert.equal(probe.consoleWindow, 0, "The real Python service allocated a console");
    const otherClient = createClient({ voiceHome: home, spawn: () => { throw new Error("Shared service died with its parent"); } });
    const afterParentExit = await otherClient.status();
    const after = terminalPids();
    assert.deepEqual(after.filter(pid => !before.includes(pid)), [], "Startup created a Windows Terminal process");
    const report = { passed: true, checkedAt: new Date().toISOString(), python, server,
      probe, launcherExitCode: exit, serviceUsableAfterParentExit: true,
      terminalPidsBefore: before, terminalPidsAfter: after,
      modelState: afterParentExit.model_state, realMicrophone: false };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally {
    if (fs.existsSync(path.join(home, "token"))) {
      const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
      await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/shutdown",
          headers: { Authorization: "Bearer " + token }, timeout: 2000 }, response => {
          response.resume(); response.on("end", () => response.statusCode === 202 ? resolve() : reject(new Error("Isolated service shutdown failed: " + response.statusCode)));
        }); req.on("error", error => error.code === "ECONNREFUSED" ? resolve() : reject(error)); req.on("timeout", () => req.destroy(new Error("shutdown timeout"))); req.end();
      });
      for (let i = 0; i < 50; i++) {
        const closed = await new Promise(resolve => { const socket = net.connect(port, "127.0.0.1"); socket.once("error", () => resolve(true)); socket.once("connect", () => { socket.destroy(); resolve(false); }); });
        if (closed) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
