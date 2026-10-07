"use strict";

// This is an opt-in runtime check.  It is intentionally not named *.test.cjs:
// the normal test runner does not install or launch Electron.  The parent
// Node process creates only a temporary fixture, launches the real Electron
// main process, and writes one evidence JSON after the fixture is removed.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(repoRoot, "test-results", "electron-runtime");
const evidencePath = path.join(repoRoot, "test-results", "electron-update-runtime.json");
const marker = "ELECTRON_RUNTIME_RESULT::";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const existsFile = file => { try { return fs.statSync(file).isFile(); } catch (_) { return false; } };
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
};

function makeHelperSource() {
  return String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const requestPath = process.argv[process.argv.indexOf("--request") + 1];
if (!requestPath) process.exit(2);
const requestDirectory = path.dirname(requestPath);
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
let stopped = false;
function stop(reason) {
  if (stopped) return;
  stopped = true;
  fs.writeFileSync(path.join(requestDirectory, "helper-exit.json"), JSON.stringify({ id: request.id, reason, pid: process.pid }));
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
fs.writeFileSync(path.join(requestDirectory, "ready.json"), JSON.stringify({ state: "ready", id: request.id, ownerPid: process.pid, ready: true }));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(requestDirectory, "cancel.json"))) stop("cancel-file");
}, 10);
process.on("exit", () => clearInterval(timer));
`;
}

function fixture(root) {
  const { makeAsar, baseFiles, nativeUpdaterFixture } = require("./fixtures/asar.cjs");
  const maintenancePackage = path.join(root, "release");
  const packageRecovery = path.join(maintenancePackage, "shared", "update-recovery.cjs");
  // The bridge itself is production code.  The spawned maintenance helper is
  // deliberately a tiny self-owned Node fixture, installed at the manifest's
  // update-recovery.cjs path so the bridge performs its real child-process and
  // ready/cancel hand-off without executing a real installer or OpenCode.
  const recoverySource = Buffer.from(makeHelperSource(), "utf8");
  fs.mkdirSync(path.dirname(packageRecovery), { recursive: true });
  fs.writeFileSync(packageRecovery, recoverySource);
  const manifest = Buffer.from(sha256(recoverySource) + "  shared/update-recovery.cjs\n", "utf8");
  fs.writeFileSync(path.join(maintenancePackage, "CONTENTS.sha256"), manifest);

  const app = path.join(root, "OpenCode.app");
  const resources = path.join(app, "Contents", "Resources");
  const asar = path.join(resources, "app.asar");
  const executable = path.join(app, "OpenCode.exe");
  const missingApp = path.join(root, "MissingOpenCode.app");
  const missingResources = path.join(missingApp, "Contents", "Resources");
  const missingExecutable = path.join(missingApp, "OpenCode.exe");
  const home = path.join(root, "fixture-home");
  const runtime = path.join(root, "fixture-runtime");
  const maintenanceRoot = path.join(root, "maintenance");
  const backupRoot = path.join(maintenanceRoot, "backups", "0.2.0");
  const installerPath = path.join(root, "OpenCode-setup.exe");
  const helperPath = path.join(root, "maintenance-helper.cjs");
  const activePath = path.join(home, ".config", "opencode", "voice-maintenance", "active.json");
  const protectedPath = path.join(root, "protected-user-state.json");
  const patchedUpdaterPath = path.join(root, "patched-updater.cjs");
  for (const directory of [resources, missingResources, home, runtime, maintenanceRoot, backupRoot]) fs.mkdirSync(directory, { recursive: true });

  const archive = makeAsar(baseFiles(), "1.2.3");
  fs.writeFileSync(asar, archive);
  fs.writeFileSync(executable, "fixture OpenCode executable\n");
  fs.writeFileSync(missingExecutable, "fixture missing-archive executable\n");
  fs.writeFileSync(installerPath, "fixture installer; must never be executed\n");
  fs.writeFileSync(helperPath, recoverySource);
  fs.writeFileSync(protectedPath, "candidate-owned simulated user state\n", "utf8");
  const active = {
    schema: 1,
    featureVersion: "0.2.0",
    packageRoot: maintenancePackage,
    packageManifestSha256: sha256(manifest),
    // Filled by the parent process. Electron's process.execPath is Electron,
    // so the helper uses the real Node executable that launched this harness.
    node: null,
    python: null,
    pythonw: null,
    app,
    home,
    runtime,
    backupRoot,
    maintenanceRoot,
    shortcutReceipt: path.join(maintenanceRoot, "shortcut-receipt.json"),
  };

  const patched = require("../shared/patch-package.cjs").patchUpdaterSource(nativeUpdaterFixture);
  fs.writeFileSync(patchedUpdaterPath, patched, "utf8");
  return {
    root, app, asar, executable, home, runtime, maintenanceRoot, backupRoot,
    installerPath, helperPath, packageRecovery, activePath, protectedPath, patchedUpdaterPath, missingApp,
    archiveHash: sha256(archive), archiveBase64: archive.toString("base64"), active, configBytesBefore: null,
    patchMarkers: {
      installStart: patched.includes("/*oc-voice-update:install:start*/"),
      installPrepare: patched.includes("require2(\"./oc-voice-update.cjs\").prepare"),
      installCommit: patched.includes("require2(\"./oc-voice-update.cjs\").commit"),
      installCancel: patched.includes("require2(\"./oc-voice-update.cjs\").cancel"),
      callBridge: patched.includes("require2(\"./oc-voice-update.cjs\").quitAndInstall"),
    },
  };
}

function findElectron() {
  const exe = path.join(runtimeRoot, "node_modules", "electron", "dist", "electron.exe");
  if (process.platform !== "win32") return { exe, reason: "real Electron.exe runtime check is Windows-only" };
  if (!existsFile(exe)) return { exe, reason: "Electron 44.6.0 binary is missing; run npm install --prefix test-results/electron-runtime --ignore-scripts electron@44.6.0 then node test-results/electron-runtime/node_modules/electron/install.js" };
  return { exe };
}

function launchElectron(inputPath, electronExe) {
  return new Promise((resolve, reject) => {
    // Electron options must precede the main script.  The local host denies
    // Electron's default GPU cache location, so disable only GPU initialization
    // for this self-owned, no-window harness.  --no-sandbox is recorded as a
    // limitation below; it does not alter the product or its update bridge.
    const child = spawn(electronExe, ["--no-sandbox", "--disable-gpu", "--user-data-dir=" + path.join(path.dirname(inputPath), "electron-user-data"), path.join(__dirname, "electron-update-runtime-main.cjs"), "--oc-input", inputPath], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OC_ELECTRON_RUNTIME_FIXTURE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { }
      reject(Object.assign(new Error("Electron runtime harness timed out"), { stdout, stderr }));
    }, 30000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
      let result = null;
      if (lines.length) {
        try { result = JSON.parse(lines.at(-1).slice(marker.length)); } catch (error) { result = { status: "FAIL", error: "Electron result JSON was malformed: " + error.message }; }
      }
      if (!result) result = { status: "FAIL", error: "Electron harness did not emit a result marker" };
      resolve({ code, result, stdout, stderr });
    });
  });
}

async function main() {
  const evidence = {
    schema: 1,
    status: "FAIL",
    runtime: { requested: "44.6.0", executable: null, electronVersion: null, nodeVersion: process.version },
    checks: [],
    limitations: [
      "The Electron main process and app.asar are self-owned fixtures; this is not a test of the current real OpenCode installation or updater service.",
      "The host is Windows, so this proves Electron's ASAR filesystem view and the original-fs bridge selection, not a real macOS kernel, Gatekeeper, xattrs, ACL, Metal, code-signing, or macOS permission boundary.",
      "Electron 44 holds an accessed app.asar open on this Windows host; the three missing-archive retries use a second self-owned app directory with OpenCode.exe but no archive, then restore the exact active.json bytes. The valid archive itself is checked byte-identical.",
      "No BrowserWindow or system dialog is created. The error dialog is a self-owned capture object, and the installer fixture is never executed.",
      "The harness passes --no-sandbox and --disable-gpu so this Windows host can run a no-window Electron main process; this does not prove production sandbox/GPU behavior.",
      "Electron user-data-dir is redirected into the temporary fixture; no actual user Electron profile or OpenCode configuration is used.",
      "The installed Electron dependency is test-only under test-results/electron-runtime and is not part of the release package.",
    ],
  };
  const runtime = findElectron();
  evidence.runtime.executable = runtime.exe;
  if (runtime.reason) {
    const required = process.env.OC_VOICE_REQUIRE_ELECTRON === "1";
    evidence.status = required ? "FAIL" : "SKIPPED";
    evidence.required = required;
    evidence.skipReason = runtime.reason;
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(evidence, null, 2));
    if (required) process.exitCode = 1;
    return;
  }

  // Electron 44 on this locked-down Windows host cannot create directories
  // beneath %TEMP% even through original-fs. Keep the fixture under the
  // candidate's own test-results/electron-* fence instead.
  const fixtureBase = path.join(repoRoot, "test-results", "electron-fixtures");
  fs.mkdirSync(fixtureBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureBase, "run-"));
  let inputPath;
  let fixtureData;
  try {
    fixtureData = fixture(root);
    const nodeExe = process.execPath;
    fixtureData.active.node = nodeExe;
    fixtureData.active.python = nodeExe;
    fixtureData.active.pythonw = nodeExe;
    fixtureData.configBytesBefore = JSON.stringify(fixtureData.active, null, 2) + "\n";
    writeJson(fixtureData.activePath, fixtureData.active);
    inputPath = path.join(root, "electron-input.json");
    const baselineIndex = process.argv.indexOf("--baseline");
    const baselinePath = baselineIndex >= 0 && process.argv[baselineIndex + 1]
      ? path.resolve(process.argv[baselineIndex + 1]) : null;
    writeJson(inputPath, {
      ...fixtureData,
      active: fixtureData.active,
      bridgePath: path.join(repoRoot, "shared", "update-bridge.cjs"),
      nodeExe,
      baselinePath: baselinePath || null,
    });
    const launched = await launchElectron(inputPath, runtime.exe);
    evidence.runtime.electronVersion = launched.result.runtimeVersion || null;
    evidence.child = {
      exitCode: launched.code,
      stdoutTail: launched.stdout.slice(-4000),
      stderrTail: launched.stderr.slice(-4000),
    };
    if (launched.result && Array.isArray(launched.result.checks)) evidence.checks = launched.result.checks;
    evidence.status = launched.result && launched.result.status === "PASS" && launched.code === 0 ? "PASS" : "FAIL";
    evidence.runtime = { ...evidence.runtime, ...(launched.result.runtime || {}) };
    if (launched.result.error) evidence.error = launched.result.error;
    if (launched.result.reproduction) evidence.reproduction = launched.result.reproduction;
    const passCount = evidence.checks.filter(check => check.status === "PASS").length;
    evidence.checkSummary = {
      total: evidence.checks.length,
      pass: passCount,
      fail: evidence.checks.length - passCount,
    };
    evidence.fixture = {
      cleanedUp: false,
      validAsarSha256: fixtureData.archiveHash,
      defaultConfigRelative: path.relative(root, fixtureData.activePath),
      physicalArchiveRelative: path.relative(root, fixtureData.asar),
      protectedStateSha256: sha256(fs.readFileSync(fixtureData.protectedPath)),
      patchMarkers: fixtureData.patchMarkers,
    };
  } catch (error) {
    evidence.error = error.message;
    evidence.child = { stdoutTail: String(error.stdout || "").slice(-4000), stderrTail: String(error.stderr || "").slice(-4000) };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { evidence.cleanupError = error.message; }
    if (evidence.fixture) evidence.fixture.cleanedUp = !fs.existsSync(root);
  }
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== "PASS") process.exitCode = 1;
}

main().catch(error => {
  const evidence = { schema: 1, status: "FAIL", error: error.stack || error.message };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
