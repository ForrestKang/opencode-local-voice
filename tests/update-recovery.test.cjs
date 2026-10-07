"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const recovery = require("../shared/update-recovery.cjs");
const feature = require("../shared/feature-update.cjs");
const maintenancePackage = require("../shared/maintenance-package.cjs");
const { makeAsar, baseFiles } = require("./fixtures/asar.cjs");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

function makePackage(root) {
  const packageRoot = path.join(root, "release");
  const required = new Set([...maintenancePackage.REQUIRED_FILES]);
  for (const relative of required) {
    const source = path.join(__dirname, "..", relative);
    const target = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const manifestLines = [...required].sort().map(relative => sha256(fs.readFileSync(path.join(packageRoot, relative))) + "  " + relative);
  const manifest = Buffer.from(manifestLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(packageRoot, "CONTENTS.sha256"), manifest);
  return { packageRoot, packageManifestSha256: sha256(manifest) };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "oc-recovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const runtime = path.join(root, "runtime");
  const home = path.join(root, "home");
  const maintenanceRoot = path.join(root, "maintenance");
  const backupRoot = path.join(maintenanceRoot, "backups", "0.2.0");
  for (const directory of [app, path.join(app, "resources"), runtime, home, maintenanceRoot, backupRoot]) fs.mkdirSync(directory, { recursive: true });
  const release = makePackage(root);
  const targetAsar = path.join(app, "resources", "app.asar");
  fs.writeFileSync(targetAsar, makeAsar(baseFiles(), options.version || "1.2.3"));
  const executable = path.join(app, "OpenCode.exe"); fs.writeFileSync(executable, "fixture executable");
  const configPath = path.join(maintenanceRoot, "active.json");
  const config = {
    schema: 1, featureVersion: "0.2.0", ...release, node: process.execPath, python: process.execPath,
    pythonw: process.execPath, app, home, runtime, backupRoot, maintenanceRoot,
    shortcutReceipt: path.join(maintenanceRoot, "shortcut-receipt.json"), executable,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const state = { records: [], launches: [], applyCalls: 0, rebinding: 0 };
  const hooks = {
    platform: process.platform,
    applyOptions: { checkClosed() {}, stop() { return { state: "not_running" }; } },
    currentPid: 4242,
    process: {
      list: () => state.records,
      spawn: (...args) => { state.launches.push(args); return { unref() {} }; },
    },
    launch: (exe, args, spawnOptions) => { state.launches.push({ exe, args, spawnOptions }); return { state: "launched", exe, args }; },
    rebind: () => { state.rebinding += 1; },
  };
  return { root, app, runtime, home, maintenanceRoot, backupRoot, release, targetAsar, config, configPath, state, hooks };
}

function updateRequest(f, expectedVersion, currentHash, id = "11111111-1111-4111-8111-111111111111") {
  const directory = path.join(f.maintenanceRoot, "requests", id);
  fs.mkdirSync(directory, { recursive: true });
  const installerPath = path.join(directory, "installer.exe");
  fs.writeFileSync(installerPath, "official installer");
  const request = { schema: 1, id, createdAt: new Date(0).toISOString(), parentPid: 88, app: f.app,
    currentAsarSha256: currentHash, expectedVersion, installerPath, configPath: f.configPath };
  fs.writeFileSync(path.join(directory, "request.json"), JSON.stringify(request, null, 2));
  fs.writeFileSync(path.join(directory, "commit.json"), JSON.stringify({ schema: 1, id, expectedVersion }));
  fs.writeFileSync(path.join(directory, "installer-pids.json"), JSON.stringify({ schema: 1, id, pids: [{ pid: 77, path: installerPath, startedAt: new Date(0).toISOString() }] }));
  return { request, directory, installerPath };
}

test("check mode validates the release allowlist without starting or modifying anything", async t => {
  const f = fixture(t); const beforeConfig = fs.readFileSync(f.configPath); const beforeArchive = fs.readFileSync(f.targetAsar);
  const result = await recovery.run({ configPath: f.configPath, mode: "check" }, f.hooks);
  assert.equal(result.state, "incomplete");
  assert.deepEqual(fs.readFileSync(f.configPath), beforeConfig);
  assert.deepEqual(fs.readFileSync(f.targetAsar), beforeArchive);
  assert.equal(f.state.launches.length, 0);
  assert.equal(fs.existsSync(path.join(f.maintenanceRoot, "recovery.lock")), false);
});

test("ordinary launch creates a patch transaction and forwards raw arguments after verification", async t => {
  const f = fixture(t);
  const result = await recovery.run({ configPath: f.configPath, mode: "launch", args: ["--profile", "demo", "--", "原始值"] }, f.hooks);
  assert.equal(result.state, "launched");
  assert.equal(f.state.launches.length, 1);
  assert.deepEqual(f.state.launches[0].args, ["--profile", "demo", "--", "原始值"]);
  assert.equal(recovery.health(recovery.loadConfig(f.configPath, f.hooks), f.hooks).complete, true);
  assert.equal(fs.existsSync(path.join(f.maintenanceRoot, "recovery-candidates")), false);
});

test("a live OpenCode process blocks hot replacement and does not launch a second window", async t => {
  const f = fixture(t);
  const beforeArchive = fs.readFileSync(f.targetAsar);
  f.state.records = [{ pid: 88, parent: 1, name: "OpenCode.exe", path: f.config.executable, creation: "now" }];
  const notices = [];
  f.hooks.notify = message => notices.push(message);
  const result = await recovery.run({ configPath: f.configPath, mode: "launch", args: ["--new"] }, f.hooks);
  assert.equal(result.state, "app-running-incomplete");
  assert.equal(f.state.launches.length, 0);
  assert.equal(notices.length, 1);
  assert.deepEqual(fs.readFileSync(f.targetAsar), beforeArchive);
});

test("same archive with missing runtime repairs runtime idempotently without a second backup", async t => {
  const f = fixture(t);
  await recovery.run({ configPath: f.configPath, mode: "launch", args: [] }, f.hooks);
  const config = recovery.loadConfig(f.configPath, f.hooks);
  const archiveAfterFirst = fs.readFileSync(f.targetAsar);
  const backupsAfterFirst = fs.readdirSync(f.backupRoot, { recursive: true });
  fs.unlinkSync(path.join(f.runtime, "voice_text.py"));
  const result = await recovery.run({ configPath: f.configPath, mode: "launch", args: [] }, f.hooks);
  assert.equal(result.state, "launched");
  assert.deepEqual(fs.readFileSync(f.targetAsar), archiveAfterFirst);
  assert.equal(fs.existsSync(path.join(f.runtime, "voice_text.py")), true);
  assert.deepEqual(fs.readdirSync(f.backupRoot, { recursive: true }), backupsAfterFirst);
  assert.equal(recovery.health(config, f.hooks).complete, true);
});

test("a stale lock is removed only after its owner is proven dead", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.maintenanceRoot, "recovery.lock"), JSON.stringify({ schema: 1, pid: 999, app: f.app }));
  f.hooks.process.isAlive = pid => pid !== 999;
  const result = await recovery.run({ configPath: f.configPath, mode: "check" }, f.hooks);
  assert.equal(result.state, "incomplete");
  assert.equal(fs.existsSync(path.join(f.maintenanceRoot, "recovery.lock")), true);
  const lock = await recovery.acquireLock(recovery.loadConfig(f.configPath, f.hooks), f.hooks);
  assert.equal(lock.acquired, true);
  recovery.releaseLock(lock, recovery.loadConfig(f.configPath, f.hooks), f.hooks);
});

test("PowerShell maintenance calls rebuild the environment without inherited PSModulePath", async t => {
  const f = fixture(t);
  const config = recovery.loadConfig(f.configPath, f.hooks);
  const calls = [];
  const hooks = {
    fs,
    platform: "win32",
    process: {
      env: { PSModulePath: "pwsh7", Path: "preserved" },
      spawnSync: (exe, args, options) => {
        calls.push({ exe, args, options });
        assert.equal(Object.keys(options.env).some(key => key.toLowerCase() === "psmodulepath"), false);
        assert.equal(options.windowsHide, true);
        return { status: 0, stdout: "[]" };
      },
    },
  };
  assert.deepEqual(await recovery.listProcesses(config, hooks), []);
  await recovery.rebindShortcuts(config, hooks);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.exe === "powershell.exe"), true);
});

test("unknown app layout is rejected before any patch operation", t => {
  const f = fixture(t);
  fs.renameSync(f.targetAsar, path.join(f.app, "app.asar"));
  assert.throws(() => recovery.loadConfig(f.configPath, f.hooks), /app\/resources\/app\.asar/);
});

test("a recovery source failure launches the unchanged official archive", async t => {
  const f = fixture(t);
  const config = recovery.loadConfig(f.configPath, f.hooks);
  const before = fs.readFileSync(f.targetAsar);
  fs.appendFileSync(path.join(config.packageRoot, "shared", "oc-mic.js"), "\n// changed after active manifest capture\n");
  const notices = [];
  f.hooks.notify = message => notices.push(message);
  const result = await recovery.run({ config, mode: "launch", args: ["--official"] }, f.hooks);
  assert.equal(result.state, "launched-official");
  assert.equal(f.state.launches.length, 1);
  assert.deepEqual(f.state.launches[0].args, ["--official"]);
  assert.deepEqual(fs.readFileSync(f.targetAsar), before);
  assert.equal(notices.length, 1);
});

test("update waits for the recorded installer tree, validates the new version, and patches the official archive", async t => {
  const f = fixture(t);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  fs.writeFileSync(f.targetAsar, makeAsar(baseFiles(), "1.2.4"));
  const newOfficial = fs.readFileSync(f.targetAsar);
  const handoff = updateRequest(f, "1.2.4", oldHash);
  let processReads = 0;
  f.hooks.process.list = () => {
    processReads += 1;
    return processReads < 2 ? [{ pid: 77, parent: 1, name: "installer.exe", path: handoff.installerPath, creation: "now" }] : [];
  };
  let now = 0;
  f.hooks.clock = { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  const result = await recovery.run({ configPath: f.configPath, mode: "update", request: path.join(handoff.directory, "request.json"), args: ["--updated"] }, f.hooks);
  assert.equal(result.state, "updated");
  assert.equal(f.state.rebinding, 1);
  assert.equal(f.state.launches.length, 1);
  assert.deepEqual(f.state.launches[0].args, ["--updated"]);
  assert.notDeepEqual(fs.readFileSync(f.targetAsar), newOfficial);
  assert.equal(recovery.health(recovery.loadConfig(f.configPath, f.hooks), f.hooks).complete, true);
  const ready = JSON.parse(fs.readFileSync(path.join(handoff.directory, "ready.json"), "utf8"));
  assert.deepEqual(ready, { state: "ready", id: handoff.request.id, ownerPid: f.hooks.currentPid });
});

test("update keeps a child in the installer gate after its recorded parent exits", async t => {
  const f = fixture(t);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  fs.writeFileSync(f.targetAsar, makeAsar(baseFiles(), "1.2.4"));
  const handoff = updateRequest(f, "1.2.4", oldHash);
  const childPath = path.join(handoff.directory, "installer-child.exe");
  fs.writeFileSync(childPath, "child");
  let reads = 0;
  let latestRecords = [];
  f.hooks.process.list = () => {
    reads += 1;
    if (reads === 1) latestRecords = [
      { pid: 77, parent: 1, name: "installer.exe", path: handoff.installerPath, creation: "root" },
      { pid: 78, parent: 77, name: "installer-child.exe", path: childPath, creation: "child" },
    ];
    else if (reads < 20) latestRecords = [{ pid: 78, parent: 77, name: "installer-child.exe", path: childPath, creation: "child" }];
    else latestRecords = [];
    return latestRecords;
  };
  const realApply = feature.apply;
  f.hooks.apply = (payload, applyOptions) => {
    assert.equal(latestRecords.some(record => record.pid === 78), false, "archive replacement must wait for a child whose installer root exited");
    return realApply(payload, applyOptions);
  };
  let now = 0;
  f.hooks.clock = { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  const result = await recovery.run({ configPath: f.configPath, mode: "update", request: path.join(handoff.directory, "request.json") }, f.hooks);
  assert.equal(result.state, "updated");
  assert.ok(reads >= 20, "the remembered child must remain in the gate across process snapshots");
});

test("a cancellation that arrives after archive apply prevents rebind and launch", async t => {
  const f = fixture(t);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  fs.writeFileSync(f.targetAsar, makeAsar(baseFiles(), "1.2.4"));
  const handoff = updateRequest(f, "1.2.4", oldHash);
  f.hooks.process.list = () => [];
  const realApply = feature.apply;
  f.hooks.apply = (payload, applyOptions) => {
    fs.writeFileSync(path.join(handoff.directory, "cancel.json"), JSON.stringify({ schema: 1, id: handoff.request.id, state: "cancelled" }));
    return realApply(payload, applyOptions);
  };
  let now = 0;
  f.hooks.clock = { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  const result = await recovery.run({ configPath: f.configPath, mode: "update", request: path.join(handoff.directory, "request.json"), args: ["--after-cancel"] }, f.hooks);
  assert.equal(result.state, "cancelled");
  assert.equal(f.state.rebinding, 0);
  assert.equal(f.state.launches.length, 0);
});

test("an update recovery failure starts the unchanged new official package", async t => {
  const f = fixture(t);
  const config = recovery.loadConfig(f.configPath, f.hooks);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  fs.writeFileSync(f.targetAsar, makeAsar(baseFiles(), "1.2.4"));
  const official = fs.readFileSync(f.targetAsar);
  const handoff = updateRequest(f, "1.2.4", oldHash);
  f.hooks.process.list = () => [];
  f.hooks.notify = () => {};
  fs.appendFileSync(path.join(config.packageRoot, "shared", "oc-mic.js"), "\n// changed after active manifest capture\n");
  const result = await recovery.run({ config, mode: "update", request: path.join(handoff.directory, "request.json"), args: ["--official"] }, f.hooks);
  assert.equal(result.state, "launched-official");
  assert.equal(f.state.launches.length, 1);
  assert.deepEqual(f.state.launches[0].args, ["--official"]);
  assert.deepEqual(fs.readFileSync(f.targetAsar), official);
  assert.equal(f.state.rebinding, 0);
});

test("update timeout with no installer pid evidence writes cancel and leaves the official bytes untouched", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.targetAsar);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  const handoff = updateRequest(f, "1.2.3", oldHash);
  let now = 0;
  f.hooks.clock = { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  const result = await recovery.run({ configPath: f.configPath, mode: "update", request: path.join(handoff.directory, "request.json"), timeoutMs: 500 }, f.hooks);
  assert.equal(result.state, "timeout");
  assert.deepEqual(fs.readFileSync(f.targetAsar), before);
  assert.equal(fs.existsSync(path.join(handoff.directory, "cancel.json")), true);
  assert.equal(fs.existsSync(path.join(handoff.directory, "ready.json")), true);
  assert.equal(f.state.rebinding, 0);
});

test("a malformed updated archive writes error, removes ready, and never restores the old archive", async t => {
  const f = fixture(t);
  const oldHash = sha256(fs.readFileSync(f.targetAsar));
  const badOfficial = Buffer.from("official package bytes");
  fs.writeFileSync(f.targetAsar, badOfficial);
  const handoff = updateRequest(f, "1.2.4", oldHash);
  let now = 0;
  f.hooks.clock = { now: () => now, sleep: ms => { now += ms; return Promise.resolve(); } };
  await assert.rejects(() => recovery.run({ configPath: f.configPath, mode: "update", request: path.join(handoff.directory, "request.json") }, f.hooks), /updated app|ASAR|archive/i);
  assert.deepEqual(fs.readFileSync(f.targetAsar), badOfficial);
  assert.equal(fs.existsSync(path.join(handoff.directory, "ready.json")), false);
  const error = JSON.parse(fs.readFileSync(path.join(handoff.directory, "error.json"), "utf8"));
  assert.deepEqual({ state: error.state, id: error.id, ownerPid: error.ownerPid }, { state: "error", id: handoff.request.id, ownerPid: f.hooks.currentPid });
});
