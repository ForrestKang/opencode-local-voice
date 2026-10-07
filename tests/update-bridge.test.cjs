"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const bridge = require("../shared/update-bridge.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-update-bridge-"));
  const packageRoot = path.join(root, "package");
  const app = path.join(root, "OpenCode");
  const home = path.join(root, "voice-home");
  const runtime = path.join(root, "runtime");
  const maintenanceRoot = path.join(root, "maintenance");
  for (const directory of [packageRoot, app, home, runtime, maintenanceRoot, path.join(packageRoot, "shared"), path.join(app, "resources")]) fs.mkdirSync(directory, { recursive: true });
  const helper = Buffer.from("module.exports = {};\n");
  fs.writeFileSync(path.join(packageRoot, "shared", "update-recovery.cjs"), helper);
  const manifest = Buffer.from(crypto.createHash("sha256").update(helper).digest("hex") + "  shared/update-recovery.cjs\n");
  fs.writeFileSync(path.join(packageRoot, "CONTENTS.sha256"), manifest);
  fs.writeFileSync(path.join(app, "OpenCode.exe"), "fixture exe\n");
  fs.writeFileSync(path.join(app, "resources", "app.asar"), "fixture asar\n");
  const installerPath = path.join(root, "OpenCode-setup.exe");
  fs.writeFileSync(installerPath, "fixture installer\n");
  const active = {
    schema: 1,
    featureVersion: "0.2.0",
    packageRoot,
    packageManifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"),
    node: process.execPath,
    python: process.execPath,
    pythonw: process.execPath,
    app,
    home,
    runtime,
    backupRoot: path.join(maintenanceRoot, "backups"),
    maintenanceRoot,
    shortcutReceipt: path.join(maintenanceRoot, "shortcut-receipt.json"),
  };
  const configPath = path.join(maintenanceRoot, "active.json");
  fs.writeFileSync(configPath, JSON.stringify(active));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, active, configPath, installerPath, electron: { app: { getPath: () => home } } };
}

function spawnFixture(f, options = {}) {
  const calls = [], children = [];
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const child = new EventEmitter();
    child.pid = options.pid || 7000 + children.length;
    child.unref = () => { child.unrefCalled = true; };
    child.kill = () => { child.killed = true; };
    children.push(child);
    if (args.includes("--mode")) {
      const requestPath = args[args.indexOf("--request") + 1];
      if (options.ready !== false) {
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        fs.writeFileSync(path.join(path.dirname(requestPath), "ready.json"), JSON.stringify({ state: "ready", id: request.id, ownerPid: child.pid }));
      }
    }
    return child;
  };
  return { spawn, calls, children };
}

function readRequest(f, token) {
  return JSON.parse(fs.readFileSync(path.join(token.requestDirectory, "request.json"), "utf8"));
}

test("prepare starts the detached helper and writes a version-bound request before the caller stops sidecars", async t => {
  const f = fixture(t), fake = spawnFixture(f), events = [];
  const token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, {
    config: f.active, configPath: f.configPath, spawn: (...args) => { events.push("spawn"); return fake.spawn(...args); },
  });
  events.push("stop");
  const request = readRequest(f, token);
  assert.deepEqual(events, ["spawn", "stop"]);
  assert.equal(request.expectedVersion, "1.18.34");
  assert.equal(request.app, f.active.app);
  assert.deepEqual(fake.calls[0].args.slice(1), ["--config", f.configPath, "--mode", "update", "--request", path.join(token.requestDirectory, "request.json")]);
  assert.equal(fake.calls[0].spawnOptions.detached, true);
  assert.equal(fake.calls[0].spawnOptions.windowsHide, true);
  bridge.cancel(token);
});

test("commit records official installer PIDs, calls quitAndInstall(false,false), and holds autorun false", async t => {
  const f = fixture(t), fake = spawnFixture(f), token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: fake.spawn });
  bridge.commit(token);
  const originalSpawnLog = function (command) { this.originalCalls ||= []; this.originalCalls.push(command); return Promise.resolve(true); };
  const updater = {
    autoRunAppAfterInstall: true,
    spawnLog: originalSpawnLog,
    quitAndInstall(silent, forceRun) {
      assert.equal(silent, false); assert.equal(forceRun, false); this.quitAndInstallCalled = true;
      this.spawnLog(f.installerPath, ["/S"], undefined, "ignore");
      this.spawnLog(f.installerPath, ["/S", "/D=second"], undefined, "ignore");
    },
  };
  bridge.quitAndInstall(updater);
  const pidFile = JSON.parse(fs.readFileSync(path.join(token.requestDirectory, "installer-pids.json"), "utf8"));
  assert.deepEqual(pidFile.pids.map(item => item.pid), [7001, 7002]);
  assert.ok(pidFile.pids.every(item => item.path === f.installerPath));
  assert.equal(updater.autoRunAppAfterInstall, false);
  assert.notEqual(updater.spawnLog, originalSpawnLog);
});

test("cancel writes the marker and kills the helper; duplicate prepare is refused", async t => {
  const f = fixture(t), fake = spawnFixture(f), token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: fake.spawn });
  await assert.rejects(bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: fake.spawn }), /already active/);
  assert.equal(bridge.cancel(token), true);
  assert.equal(fake.children[0].killed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(token.requestDirectory, "cancel.json"), "utf8")).id, token.request.id);
});

test("ready failure is reported before stop and leaves a cancel marker", async t => {
  const f = fixture(t), fake = spawnFixture(f, { ready: false }), dialogs = [];
  await assert.rejects(bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, {
    config: f.active, configPath: f.configPath, spawn: fake.spawn, readyTimeoutMs: 2, readyPollMs: 1, sleep: async () => {},
    dialog: { showErrorBox: (_title, message) => dialogs.push(message) },
  }), /ready\.json/);
  assert.equal(dialogs.length, 1);
  const requests = fs.readdirSync(path.join(f.active.maintenanceRoot, "requests"));
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(path.join(f.active.maintenanceRoot, "requests", requests[0], "cancel.json")), true);
});

test("missing physical ASAR shows one Chinese preparation notice and a repaired application can retry", async t => {
  const f = fixture(t), fake = spawnFixture(f), dialogs = [];
  const asar = path.join(f.active.app, "resources", "app.asar"), bytes = fs.readFileSync(asar);
  fs.unlinkSync(asar);
  const options = { config: f.active, configPath: f.configPath, spawn: fake.spawn,
    dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }) } };
  await assert.rejects(bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, options), error => {
    assert.match(error.message, /current app\.asar is missing/);
    assert.equal(error.ocVoiceUpdateNotified, true);
    return true;
  });
  assert.equal(fake.calls.length, 0);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, "OpenCode 更新准备失败");
  assert.match(dialogs[0].message, /本次更新尚未开始/);
  assert.match(dialogs[0].message, /未找到当前 OpenCode 的应用文件/);
  assert.doesNotMatch(dialogs[0].message, /update recovery|current app\.asar is missing/);
  fs.writeFileSync(asar, bytes);
  const token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, options);
  assert.equal(fake.calls.length, 1);
  assert.equal(dialogs.length, 1);
  bridge.cancel(token);
});

test("failed error presentation preserves the diagnostic rejection without the notified marker", async t => {
  const f = fixture(t), fake = spawnFixture(f);
  fs.unlinkSync(path.join(f.active.app, "resources", "app.asar"));
  await assert.rejects(bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, {
    config: f.active, configPath: f.configPath, spawn: fake.spawn,
    dialog: { showErrorBox() { throw new Error("dialog unavailable"); } },
  }), error => {
    assert.match(error.message, /current app\.asar is missing/);
    assert.equal(error.ocVoiceUpdateNotified, undefined);
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test("unknown installer command is delegated to the official fallback but refuses an untracked handoff and restores hooks", async t => {
  const f = fixture(t), fake = spawnFixture(f), token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: fake.spawn });
  bridge.commit(token);
  const originalSpawnLog = function () { return Promise.resolve(true); };
  const updater = { autoRunAppAfterInstall: true, spawnLog: originalSpawnLog, quitAndInstall() { this.spawnLog(path.join(f.root, "unknown.exe"), [], undefined, "ignore"); this.quitAndInstallCalled = true; } };
  assert.throws(() => bridge.quitAndInstall(updater), /safely identified/);
  assert.equal(updater.spawnLog, originalSpawnLog);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(fs.existsSync(path.join(token.requestDirectory, "cancel.json")), true);
});

test("administrator-required updates are refused during preflight", async t => {
  const f = fixture(t), fake = spawnFixture(f), active = { ...f.active, requiresAdministrator: true }, dialogs = [];
  await assert.rejects(bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: active, configPath: f.configPath, spawn: fake.spawn, dialog: { showErrorBox: (_title, message) => dialogs.push(message) } }), /administrator elevation/);
  assert.equal(fake.calls.length, 0);
  assert.equal(dialogs.length, 1);
});

test("an installer PID that appears after the official call is recorded without cancelling the handoff", async t => {
  const f = fixture(t), helper = spawnFixture(f), token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: helper.spawn });
  bridge.commit(token);
  const originalSpawnLog = () => Promise.resolve(true);
  const installerChild = new EventEmitter(); installerChild.unref = () => {};
  const spawn = (command, args) => {
    if (args.includes("--mode")) return helper.spawn(command, args, {});
    setImmediate(() => { installerChild.pid = 8123; });
    return installerChild;
  };
  const updater = { autoRunAppAfterInstall: true, spawnLog: originalSpawnLog, quitAndInstall() { this.quitAndInstallCalled = true; this.spawnLog(f.installerPath, ["/S"], undefined, "ignore"); } };
  // The bridge uses the injected process factory for both helper and installer.
  token.options.spawn = spawn;
  bridge.quitAndInstall(updater);
  await new Promise(resolve => setTimeout(resolve, 20));
  const pidFile = JSON.parse(fs.readFileSync(path.join(token.requestDirectory, "installer-pids.json"), "utf8"));
  assert.deepEqual(pidFile.pids.map(item => item.pid), [8123]);
});

test("an EACCES-style known spawn error may be followed by a second tracked fallback", async t => {
  const f = fixture(t), helper = spawnFixture(f), token = await bridge.prepare("1.18.34", { installerPath: f.installerPath }, f.electron, { config: f.active, configPath: f.configPath, spawn: helper.spawn });
  bridge.commit(token);
  let installerCalls = 0;
  const first = new EventEmitter(); first.unref = () => {};
  const second = new EventEmitter(); second.pid = 8456; second.unref = () => {};
  const spawn = (command, args) => {
    if (args.includes("--mode")) return helper.spawn(command, args, {});
    installerCalls++;
    if (installerCalls === 1) { setImmediate(() => first.emit("error", Object.assign(new Error("EACCES"), { code: "EACCES" }))); return first; }
    return second;
  };
  token.options.spawn = spawn;
  const updater = { autoRunAppAfterInstall: true, spawnLog: () => Promise.resolve(true), quitAndInstall() { this.quitAndInstallCalled = true; this.spawnLog(f.installerPath, ["/S"], undefined, "ignore"); setImmediate(() => this.spawnLog(f.installerPath, ["/S", "/fallback"], undefined, "ignore")); } };
  bridge.quitAndInstall(updater);
  await new Promise(resolve => setTimeout(resolve, 25));
  const pidFile = JSON.parse(fs.readFileSync(path.join(token.requestDirectory, "installer-pids.json"), "utf8"));
  assert.deepEqual(pidFile.pids.map(item => item.pid), [8456]);
});
