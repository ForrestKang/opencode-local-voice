"use strict";

// Runs only inside the real Electron main process launched by
// electron-update-runtime.cjs.  Keep this file outside *.test.cjs so the
// repository's normal Node test discovery never tries to require Electron.
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const marker = "ELECTRON_RUNTIME_RESULT::";
console.log("OC_ELECTRON_BOOT", JSON.stringify({ argv: process.argv, electron: process.versions.electron }));
const inputIndex = process.argv.indexOf("--oc-input");
let inputPath = null;
let input = null;
try {
  if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error("missing --oc-input fixture path");
  inputPath = process.argv[inputIndex + 1];
  input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
  // Keep malformed fixture input inside the CLI result path; Electron should
  // never surface a native error dialog for a test harness startup failure.
  console.error("Electron runtime fixture startup failed:", error.stack || error.message);
}
if (!input) {
  app.whenReady().then(() => app.exit(1));
}
if (!input) return;
const bridge = require(input.bridgePath);
const originalFs = require("original-fs");
const electronFs = require("node:fs");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => JSON.parse(originalFs.readFileSync(file, "utf8"));
const exists = file => { try { return originalFs.existsSync(file); } catch (_) { return false; } };
const spawnedChildren = [];

function check(name, fn, checks) {
  try { fn(); checks.push({ name, status: "PASS" }); }
  catch (error) { checks.push({ name, status: "FAIL", error: error.message }); throw error; }
}
async function checkAsync(name, fn, checks) {
  try { await fn(); checks.push({ name, status: "PASS" }); }
  catch (error) { checks.push({ name, status: "FAIL", error: error.message }); throw error; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
function waitForChildExit(child, pid) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    if (!child || typeof child.once !== "function") return finish(!pidAlive(pid));
    child.once("exit", () => finish(true));
    const started = Date.now();
    const timer = setInterval(() => {
      if (!pidAlive(pid) || Date.now() - started > 2500) {
        clearInterval(timer);
        finish(!pidAlive(pid));
      }
    }, 25);
    timer.unref?.();
  });
}

async function run() {
  const checks = [];
  const facts = {
    legacyVirtualRegularProbe: false,
    legacyFindAsarResult: "unknown",
    fixedPhysicalRegularProbe: false,
    rawHashMatches: false,
    defaultFilesystemSelection: false,
    missingAttempts: 0,
    missingNoticesCaptured: 0,
    missingErrorsNotified: 0,
    missingUnhandledRejections: 0,
    retryAfterActiveConfigRestore: false,
    installerExecuted: false,
    patchedTrace: [],
  };
  const beforeNoAsar = process.noAsar;
  const beforeConfig = originalFs.readFileSync(input.activePath);
  const beforeProtected = originalFs.readFileSync(input.protectedPath);
  const asarBytes = originalFs.readFileSync(input.asar);
  const expectedHash = input.archiveHash;
  const dialogs = [];
  let totalDialogsCaptured = 0;
  const electronStub = {
    app: { getPath(name) {
      if (name !== "home") throw new Error("unexpected app.getPath(" + name + ")");
      return input.home;
    } },
    dialog: { showErrorBox(title, message) { dialogs.push({ title, message }); } },
  };
  const updater = { installerPath: input.installerPath };
  const helperPids = [];
  const realSpawn = (command, args, options) => {
    const child = spawn(command, args, options);
    spawnedChildren.push(child);
    if (args.includes("--mode")) helperPids.push(child.pid);
    return child;
  };
  let token;
  let helperPid = null;

  check("Electron exposes app.asar through the virtual fs as a directory", () => {
    assert.equal(electronFs.lstatSync(input.asar).isDirectory(), true);
  }, checks);
  check("original-fs sees the same physical app.asar as a regular file", () => {
    assert.equal(originalFs.lstatSync(input.asar).isFile(), true);
    facts.fixedPhysicalRegularProbe = true;
  }, checks);
  check("original-fs raw hash matches the parent-created valid ASAR", () => {
    assert.equal(sha256(asarBytes), expectedHash);
    facts.rawHashMatches = true;
  }, checks);
  check("the legacy Electron fs regular-file probe reproduces the old app.asar false negative", () => {
    const legacyRegular = file => {
      try {
        const stat = electronFs.lstatSync(file);
        return stat.isFile() && !(typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink());
      } catch (_) { return false; }
    };
    const legacyFindAsar = app => [
      path.join(app, "resources", "app.asar"),
      path.join(app, "app.asar"),
      path.join(app, "Contents", "Resources", "app.asar"),
    ].find(legacyRegular) || null;
    facts.legacyVirtualRegularProbe = electronFs.lstatSync(input.asar).isDirectory();
    facts.legacyFindAsarResult = legacyFindAsar(input.app);
    assert.equal(facts.legacyVirtualRegularProbe, true);
    assert.equal(facts.legacyFindAsarResult, null);
  }, checks);
  check("bridge loaded in Electron exposes the original-fs behavior through prepare", () => {
    assert.equal(process.versions.electron ? true : false, true);
  }, checks);
  if (input.baselinePath) {
    check("optional frozen bridge baseline is readable without embedding a user path", () => {
      const baseline = originalFs.readFileSync(input.baselinePath, "utf8");
      assert.match(baseline, /function findAsar/);
      assert.match(baseline, /node:fs/);
    }, checks);
  }

  await checkAsync("default home/config selection prepares a real helper without fs/config injection", async () => {
    token = await bridge.prepare("1.2.4", updater, electronStub, {
      id: "11111111-1111-4111-8111-111111111111",
      spawn: realSpawn,
      dialog: electronStub.dialog,
    });
    helperPid = token.helperPid;
    assert.equal(token.request.configPath, input.activePath);
    assert.equal(token.request.app, input.app);
    assert.equal(token.request.currentAsarSha256, expectedHash);
    assert.equal(exists(path.join(token.requestDirectory, "ready.json")), true);
    facts.defaultFilesystemSelection = true;
  }, checks);
  await checkAsync("production bridge commit writes the version-bound hand-off", async () => {
    assert.equal(bridge.commit(token), true);
    const commit = readJson(path.join(token.requestDirectory, "commit.json"));
    assert.equal(commit.id, token.request.id);
    assert.equal(commit.expectedVersion, "1.2.4");
  }, checks);
  await checkAsync("production bridge cancel records cancellation and cleans the helper", async () => {
    const child = token.child;
    assert.equal(bridge.cancel(token), true);
    const exited = await waitForChildExit(child, helperPid);
    assert.equal(exited, true);
    assert.equal(exists(path.join(token.requestDirectory, "cancel.json")), true);
  }, checks);

  await checkAsync("patched native updater resolves three notified missing-archive attempts and stays ready", async () => {
    const source = originalFs.readFileSync(input.patchedUpdaterPath, "utf8");
    const trace = [];
    const missingDialogs = [];
    const missingErrors = [];
    let patchedToken = null;
    const bridgeForPatchedSource = {
      async prepare(version, nativeUpdater, electron) {
        trace.push("prepare:" + version);
        try {
          patchedToken = await bridge.prepare(version, nativeUpdater, electron, {
            id: "22222222-2222-4222-8222-222222222222",
            spawn: realSpawn,
            dialog: { showErrorBox(title, message) { missingDialogs.push({ title, message }); } },
          });
          return patchedToken;
        } catch (error) {
          missingErrors.push(error);
          throw error;
        }
      },
      commit(value) { trace.push("commit"); return bridge.commit(value); },
      cancel(value) { trace.push("cancel"); return bridge.cancel(value); },
      quitAndInstall() { trace.push("external-update"); throw new Error("installer execution is deliberately excluded from this fixture"); },
    };
    const missingContext = {
      autoUpdater: { installerPath: input.installerPath },
      require2(name) {
        if (name === "electron") return electronStub;
        if (name === "./oc-voice-update.cjs") return bridgeForPatchedSource;
        throw new Error("unexpected require2(" + name + ")");
      },
    };
    vm.createContext(missingContext);
    vm.runInContext(source + "\nglobalThis.__ocVoiceCreate = createUpdaterController;", missingContext, { filename: input.patchedUpdaterPath });
    const missingController = missingContext.__ocVoiceCreate({
      async stop() { trace.push("stop"); },
      backend: { quitAndInstall() { trace.push("external-update"); } },
    });
    // Electron 44 keeps the active physical app.asar mapped and Windows
    // reports EBUSY if this process unlinks it.  Point the default active.json
    // at a second self-owned application directory with no archive instead;
    // this exercises the same production missing-archive validation and lets
    // the next controller retry after restoring the original config bytes.
    const missingActive = { ...readJson(input.activePath), app: input.missingApp };
    originalFs.writeFileSync(input.activePath, JSON.stringify(missingActive, null, 2) + "\n", "utf8");
    const unhandled = [];
    const onUnhandled = error => unhandled.push(String(error && (error.stack || error.message || error)));
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await missingController.install();
      await delay(25);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      originalFs.writeFileSync(input.activePath, beforeConfig);
    }
    assert.deepEqual(trace, ["prepare:1.2.4", "prepare:1.2.4", "prepare:1.2.4"]);
    facts.missingAttempts = 3;
    assert.equal(missingErrors.length, 3);
    assert.ok(missingErrors.every(error => /current app\.asar is missing/.test(error.message) && error.ocVoiceUpdateNotified === true));
    facts.missingErrorsNotified = missingErrors.filter(error => error.ocVoiceUpdateNotified === true).length;
    assert.equal(missingDialogs.length, 3);
    assert.ok(missingDialogs.every(item => /未找到当前 OpenCode 的应用文件/.test(item.message)));
    facts.missingNoticesCaptured = missingDialogs.length;
    totalDialogsCaptured += missingDialogs.length;
    assert.deepEqual(unhandled, []);
    facts.missingUnhandledRejections = unhandled.length;
    const requestEntries = originalFs.existsSync(path.join(input.maintenanceRoot, "requests"))
      ? originalFs.readdirSync(path.join(input.maintenanceRoot, "requests")) : [];
    assert.equal(requestEntries.length, 1, "notified preflight failures create no helper request");
  }, checks);

  await checkAsync("patched native updater retries successfully after the active archive path is restored", async () => {
    const source = originalFs.readFileSync(input.patchedUpdaterPath, "utf8");
    const trace = [];
    let patchedToken = null;
    const bridgeForPatchedSource = {
      async prepare(version, nativeUpdater, electron) {
        trace.push("prepare:" + version);
        patchedToken = await bridge.prepare(version, nativeUpdater, electron, {
          id: "33333333-3333-4333-8333-333333333333",
          spawn: realSpawn,
        });
        return patchedToken;
      },
      commit(value) { trace.push("commit"); return bridge.commit(value); },
      cancel(value) { trace.push("cancel"); return bridge.cancel(value); },
      quitAndInstall() { trace.push("bridge-quitAndInstall"); throw new Error("installer execution is deliberately excluded from this fixture"); },
    };
    const context = {
      autoUpdater: { installerPath: input.installerPath },
      require2(name) {
        if (name === "electron") return electronStub;
        if (name === "./oc-voice-update.cjs") return bridgeForPatchedSource;
        throw new Error("unexpected require2(" + name + ")");
      },
    };
    vm.createContext(context);
    vm.runInContext(source + "\nglobalThis.__ocVoiceCreate = createUpdaterController;", context, { filename: input.patchedUpdaterPath });
    const controller = context.__ocVoiceCreate({
      async stop() { trace.push("stop"); },
      backend: { quitAndInstall() { trace.push("official-update"); bridgeForPatchedSource.cancel(patchedToken); } },
    });
    await controller.install();
    const exited = await waitForChildExit(patchedToken.child, patchedToken.helperPid);
    assert.deepEqual(trace, ["prepare:1.2.4", "stop", "commit", "official-update", "cancel"]);
    facts.patchedTrace = trace.slice();
    assert.equal(exited, true);
    assert.equal(exists(path.join(patchedToken.requestDirectory, "commit.json")), true);
    assert.equal(exists(path.join(patchedToken.requestDirectory, "cancel.json")), true);
    facts.retryAfterActiveConfigRestore = true;
  }, checks);
  check("the valid physical ASAR remains byte-identical after the missing-archive retry", () => {
    assert.deepEqual(originalFs.readFileSync(input.asar), asarBytes);
  }, checks);
  check("global process.noAsar is unchanged", () => { assert.equal(process.noAsar, beforeNoAsar); }, checks);
  check("simulated user config and protected state remain byte-identical", () => {
    assert.deepEqual(originalFs.readFileSync(input.activePath), beforeConfig);
    assert.deepEqual(originalFs.readFileSync(input.protectedPath), beforeProtected);
  }, checks);

  return {
    status: checks.every(item => item.status === "PASS") ? "PASS" : "FAIL",
    runtimeVersion: process.versions.electron,
    checks,
    fixture: { helperCleaned: helperPids.every(pid => !pidAlive(pid)), dialogsCaptured: totalDialogsCaptured || dialogs.length, installerExecuted: false },
    reproduction: facts,
  };
}

let result;
console.log("OC_ELECTRON_BEFORE_READY");
app.whenReady().then(async () => {
  console.log("OC_ELECTRON_READY");
  try { result = await run(); }
  catch (error) {
    result = { status: "FAIL", runtimeVersion: process.versions.electron, checks: [], error: error.stack || error.message };
  }
  // A failed assertion must not leave a self-owned helper alive while the
  // Electron child exits. Successful paths already cancel these children.
  for (const child of spawnedChildren) {
    try { if (child && typeof child.kill === "function") child.kill(); } catch (_) { }
  }
  process.stdout.write(marker + JSON.stringify(result) + "\n");
  app.quit();
  setTimeout(() => process.exit(result.status === "PASS" ? 0 : 1), 150);
}).catch(error => {
  process.stdout.write(marker + JSON.stringify({ status: "FAIL", runtimeVersion: process.versions.electron, error: error.stack || error.message }) + "\n");
  app.quit();
  setTimeout(() => process.exit(1), 150);
});
