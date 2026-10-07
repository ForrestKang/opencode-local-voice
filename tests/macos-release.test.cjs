"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const realNode = process.execPath;

function resolveBash() {
  if (process.platform !== "win32") return { path: null, reason: "macOS release simulation requires Windows Git Bash; non-Windows execution is skipped." };
  const configured = process.env.OC_VOICE_TEST_BASH;
  if (configured) {
    return fs.existsSync(configured)
      ? { path: path.resolve(configured), source: "OC_VOICE_TEST_BASH" }
      : { path: null, reason: "OC_VOICE_TEST_BASH does not exist: " + configured };
  }
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter(Boolean);
  const found = candidates.find(filename => fs.existsSync(filename));
  return found
    ? { path: found, source: "Windows Git Bash" }
    : { path: null, reason: "Git Bash dependency is missing; install Git for Windows or set OC_VOICE_TEST_BASH to bash.exe." };
}

function probePython(command) {
  const result = spawnSync(command, ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const lines = String(result.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const executable = lines[lines.length - 1];
  return executable && fs.existsSync(executable) ? path.resolve(executable) : null;
}

function resolvePython() {
  if (process.platform !== "win32") return { path: null, reason: "macOS release simulation requires Windows Git Bash; non-Windows execution is skipped." };
  const configured = process.env.OC_VOICE_TEST_PYTHON;
  if (configured) {
    const executable = probePython(configured);
    return executable
      ? { path: executable, source: "OC_VOICE_TEST_PYTHON" }
      : { path: null, reason: "OC_VOICE_TEST_PYTHON could not run or did not report an existing sys.executable: " + configured };
  }
  for (const command of ["python", "python3"]) {
    const executable = probePython(command);
    if (executable) return { path: executable, source: command };
  }
  return { path: null, reason: "Python dependency is missing; tried python and python3. Set OC_VOICE_TEST_PYTHON to a working interpreter." };
}

const bashResolution = resolveBash();
const pythonResolution = resolvePython();
const bashExe = bashResolution.path;
const realPython = pythonResolution.path;
const simulationSkipReason = process.platform !== "win32"
  ? "macOS release simulation requires Windows Git Bash; non-Windows execution is skipped."
  : (bashResolution.reason || pythonResolution.reason || null);
const simulationTestOptions = simulationSkipReason ? { skip: simulationSkipReason } : {};
const simulationTestNames = [
  "macOS install dry-run selects arm64 and x86_64 without mutation",
  "macOS apply dry-run and running-app refusal leave the fixture untouched",
  "macOS apply and restore preserve a full bundle and restore --dry-run is read-only",
  "macOS signature, fuse, and backup-copy failures never replace the app",
  "macOS swap and manifest-commit failures roll back to the prior bundle",
  "macOS restore refuses a corrupt backup and a cross-version app",
];
const { makeAsar, baseFiles } = require("./fixtures/asar.cjs");
const support = require("../shared/install-support.cjs");

const evidence = {
  status: simulationSkipReason ? "SKIPPED" : "PASS",
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, realMacKernel: false,
    bash: bashExe, bashSource: bashResolution.source || null,
    python: realPython, pythonSource: pythonResolution.source || null },
  bash: bashExe,
  substitutes: ["uname", "pgrep", "ditto", "codesign", "npx @electron/fuses", "PlistBuddy", "stat", "node", "python3"],
  scriptCopyDifferences: [
    "Git Bash test copies normalize CRLF shell sources to LF.",
    "The test copy of apply-oc-mic.sh replaces /usr/libexec/PlistBuddy with its fixture-only PlistBuddy substitute.",
  ],
  tests: [],
  limits: [
    "The run uses a Windows Git Bash process and command substitutes; it does not prove macOS kernel behavior.",
    "It does not prove Gatekeeper, xattrs, ACLs, Metal, real code signatures, or real macOS permissions.",
    "The ASAR patch and manifest logic are exercised with the repository fixture archive; no model is downloaded and no user config is touched.",
  ],
  skipReason: simulationSkipReason,
  skippedTests: simulationSkipReason ? simulationTestNames : [],
};

function posixPath(filename) {
  const absolute = path.resolve(filename).replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//.test(absolute)) throw new Error("fixture path must be on a Windows drive: " + absolute);
  return "/" + absolute[0].toLowerCase() + absolute.slice(2);
}

function writeExecutable(filename, source) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source.replaceAll("\r\n", "\n"), { encoding: "utf8", mode: 0o755 });
  try { fs.chmodSync(filename, 0o755); } catch (_) {}
}

function sha256File(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function snapshotTree(root) {
  const entries = [];
  function walk(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const entryPath = relative ? relative + "/" + name : name;
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: "directory" });
        walk(filename, entryPath);
      } else if (stat.isFile()) {
        entries.push({ path: entryPath, type: "file", sha256: sha256File(filename), bytes: stat.size });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: entryPath, type: "symlink", target: fs.readlinkSync(filename) });
      } else {
        throw new Error("unsupported fixture entry: " + filename);
      }
    }
  }
  walk(root, "");
  return JSON.stringify(entries);
}

function shellScript(lines) { return lines.join("\n") + "\n"; }

function writeFakeCommands(harness) {
  const logLine = 'if [ -n "${FAKE_LOG:-}" ]; then printf \'%s\\n\' "$*" >> "$FAKE_LOG"; fi';
  writeExecutable(path.join(harness.fakeBin, "uname"), shellScript([
    "#!/bin/bash",
    logLine,
    'printf \'%s\\n\' "${FAKE_UNAME_M:-arm64}"',
  ]));
  writeExecutable(path.join(harness.fakeBin, "pgrep"), shellScript([
    "#!/bin/bash",
    logLine,
    'if [ "${FAKE_OPEN_CODE_RUNNING:-0}" = "1" ] && [ "${1:-}" = "-x" ] && [ "${2:-}" = "OpenCode" ]; then exit 0; fi',
    "exit 1",
  ]));
  writeExecutable(path.join(harness.fakeBin, "stat"), shellScript([
    "#!/bin/bash",
    logLine,
    'if [ "${1:-}" = "-f" ]; then printf \'644\\n\'; exit 0; fi',
    'exec /usr/bin/stat "$@"',
  ]));
  writeExecutable(path.join(harness.fakeBin, "ditto"), shellScript([
    "#!/bin/bash",
    logLine,
    'if [ "${FAKE_DITTO_FAIL:-}" = "1" ]; then exit 37; fi',
    'args=("$@"); count=${#args[@]}; source=${args[$((count - 2))]}; destination=${args[$((count - 1))]}',
    'exec /usr/bin/cp -a -- "$source" "$destination"',
  ]));
  writeExecutable(path.join(harness.fakeBin, "codesign"), shellScript([
    "#!/bin/bash",
    logLine,
    'if [ "${FAKE_CODESIGN_FAIL:-}" = "1" ]; then exit 31; fi',
    "exit 0",
  ]));
  writeExecutable(path.join(harness.fakeBin, "npx"), shellScript([
    "#!/bin/bash",
    logLine,
    'operation=""; app=""; previous=""',
    'for argument in "$@"; do',
    '  if [ "$argument" = "read" ] || [ "$argument" = "write" ]; then operation="$argument"; fi',
    '  if [ "$previous" = "--app" ]; then app="$argument"; fi',
    '  previous="$argument"',
    "done",
    'if [ "${FAKE_NPX_FAIL:-}" = "$operation" ]; then exit 29; fi',
    'state="$app/Contents/fake-fuse-state"',
    'if [ "$operation" = "read" ]; then',
    '  value="Enabled"; [ -f "$state" ] && value=$(/usr/bin/cat "$state")',
    '  printf \'EnableEmbeddedAsarIntegrityValidation: %s\\n\' "$value"; exit 0',
    "fi",
    'if [ "$operation" = "write" ]; then printf \'Disabled\\n\' > "$state"; exit 0; fi',
    "exit 28",
  ]));
  writeExecutable(path.join(harness.fakeBin, "mv"), shellScript([
    "#!/bin/bash",
    logLine,
    'source="${1:-}"',
    'if [ "${FAKE_MV_FAIL_STAGE:-}" = "1" ] && [[ "$source" == *".oc-voice-stage."* ]]; then exit 43; fi',
    'if [ "${FAKE_MV_FAIL_RESTORE:-}" = "1" ] && [[ "$source" == *".oc-voice-restore."* ]]; then exit 44; fi',
    'exec /usr/bin/mv "$@"',
  ]));
  writeExecutable(path.join(harness.fakeBin, "node"), shellScript([
    "#!/bin/bash",
    logLine,
    'if [[ "${1:-}" == *"/install-support.cjs" ]] && [ "${2:-}" = "set-bundle-state" ]; then',
    '  requested=""; previous=""',
    '  for argument in "$@"; do if [ "$previous" = "--state" ]; then requested="$argument"; fi; previous="$argument"; done',
    '  if [ -n "${FAKE_NODE_FAIL_STATE:-}" ] && [ "${FAKE_NODE_FAIL_STATE}" = "$requested" ]; then exit 45; fi',
    "fi",
    'exec "${REAL_NODE_POSIX}" "$@"',
  ]));
  writeExecutable(path.join(harness.fakeBin, "python3"), shellScript([
    "#!/bin/bash",
    'exec "${REAL_PYTHON_POSIX}" "$@"',
  ]));
  writeExecutable(harness.fakePlistBuddy, shellScript([
    "#!/bin/bash",
    logLine,
    'command="${2:-}"; plist="${3:-}"',
    'if [[ "$command" == Print* ]]; then /usr/bin/grep -q \'^NSMicrophoneUsageDescription=\' "$plist" || exit 1; /usr/bin/grep \'^NSMicrophoneUsageDescription=\' "$plist"; exit 0; fi',
    'if [[ "$command" == Add* ]]; then if ! /usr/bin/grep -q \'^NSMicrophoneUsageDescription=\' "$plist"; then printf \'NSMicrophoneUsageDescription=OpenCode uses the microphone for local voice input.\\n\' >> "$plist"; fi; exit 0; fi',
    "exit 2",
  ]));
  const chmod = spawnSync(bashExe, ["-c", "chmod +x " + posixPath(harness.fakeBin) + "/*"], { encoding: "utf8" });
  if (chmod.status !== 0) throw new Error("could not mark fixture command substitutes executable: " + (chmod.stderr || ""));
}

function makeHarness(label) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "oc-macos-release-" + label + "-"));
  const repo = path.join(base, "repo");
  const app = path.join(base, "OpenCode.app");
  const home = path.join(base, "home");
  const backupRoot = path.join(base, "backups");
  const fakeBin = path.join(base, "fake-bin");
  const fakePlistBuddy = path.join(fakeBin, "PlistBuddy");
  const temp = path.join(base, "tmp");
  fs.mkdirSync(path.join(repo, "macos"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.cpSync(path.join(projectRoot, "shared"), path.join(repo, "shared"), { recursive: true });
  for (const name of ["install.sh", "apply-oc-mic.sh", "restore-oc-mic.sh", "patch-oc-mic.js"]) {
    let source = fs.readFileSync(path.join(projectRoot, "macos", name), "utf8").replaceAll("\r\n", "\n");
    if (name === "apply-oc-mic.sh") source = source.replaceAll("/usr/libexec/PlistBuddy", posixPath(fakePlistBuddy));
    const target = path.join(repo, "macos", name);
    fs.writeFileSync(target, source, { encoding: "utf8", mode: name.endsWith(".sh") ? 0o755 : 0o644 });
    if (name.endsWith(".sh")) {
      try { fs.chmodSync(target, 0o755); } catch (_) {}
    }
  }
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "CFBundleName=OpenCode\n");
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "OpenCode"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  fs.writeFileSync(path.join(app, "Contents", "Resources", "extra.dat"), Buffer.from("fixture-extra\n"));
  fs.mkdirSync(path.join(app, "Contents", "Resources", "nested"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "nested", "config.txt"), "fixture-config\n");
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), makeAsar(baseFiles()));
  fs.writeFileSync(path.join(app, "Contents", "fake-fuse-state"), "Enabled\n");
  const harness = { base, repo, app, home, backupRoot, fakeBin, fakePlistBuddy, temp };
  writeFakeCommands(harness);
  harness.originalTree = snapshotTree(app);
  harness.originalAsar = sha256File(path.join(app, "Contents", "Resources", "app.asar"));
  return harness;
}

function runScript(harness, name, args = [], overrides = {}) {
  const basePath = [posixPath(harness.fakeBin), "/usr/bin", "/usr/bin/core_perl", "/bin", "/mingw64/bin", posixPath(path.dirname(realNode)), "/c/Windows/System32"].join(":");
  const env = {
    ...process.env,
    HOME: posixPath(harness.home),
    TMPDIR: posixPath(harness.temp),
    PATH: basePath,
    Path: basePath,
    REAL_NODE_POSIX: posixPath(realNode),
    REAL_PYTHON_POSIX: posixPath(realPython),
    FAKE_LOG: posixPath(path.join(harness.base, "fake-commands.log")),
    OPENCODE_APP_PATH: posixPath(harness.app),
    ...overrides,
  };
  const scriptPath = posixPath(path.join(harness.repo, "macos", name));
  const result = spawnSync(bashExe, ["-c", "PATH=\"$1\"; export PATH; shift; exec bash \"$@\"", "oc-voice-test", basePath, scriptPath, ...args], {
    cwd: harness.repo,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ...result, output: (result.stdout || "") + (result.stderr || "") };
}

function scriptArgs(harness, extra = []) {
  return ["--app", posixPath(harness.app), "--backup-root", posixPath(harness.backupRoot), ...extra];
}

function record(name, result, details = {}) {
  evidence.tests.push({ name, status: "PASS", expectedRefusal: result.status !== 0, exitCode: result.status, ...details });
}

function cleanup(harness) {
  fs.rmSync(harness.base, { recursive: true, force: true });
}

test("macOS install dry-run selects arm64 and x86_64 without mutation", simulationTestOptions, () => {
  const harness = makeHarness("arch");
  try {
    for (const [architecture, expected] of [["arm64", "large-v3-turbo"], ["x86_64", "medium"]]) {
      const beforeTree = snapshotTree(harness.app);
      const beforeHash = sha256File(path.join(harness.app, "Contents", "Resources", "app.asar"));
      const result = runScript(harness, "install.sh", ["--app", posixPath(harness.app), "--dry-run"], { FAKE_UNAME_M: architecture });
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, new RegExp("automatic model: " + expected + " \\(architecture " + architecture));
      assert.equal(snapshotTree(harness.app), beforeTree, architecture + " dry-run changed the app bundle");
      assert.equal(sha256File(path.join(harness.app, "Contents", "Resources", "app.asar")), beforeHash);
      assert.equal(fs.existsSync(path.join(harness.home, ".config")), false, architecture + " dry-run touched HOME");
      record("install-" + architecture + "-dry-run", result, { selection: expected });
    }
  } finally { cleanup(harness); }
});

test("macOS apply dry-run and running-app refusal leave the fixture untouched", simulationTestOptions, () => {
  const harness = makeHarness("preflight");
  try {
    const dryRun = runScript(harness, "apply-oc-mic.sh", scriptArgs(harness, ["--dry-run"]));
    assert.equal(dryRun.status, 0, dryRun.output);
    assert.match(dryRun.output, /dry run complete/);
    assert.equal(snapshotTree(harness.app), harness.originalTree);
    assert.equal(sha256File(path.join(harness.app, "Contents", "Resources", "app.asar")), harness.originalAsar);
    const running = runScript(harness, "apply-oc-mic.sh", scriptArgs(harness), { FAKE_OPEN_CODE_RUNNING: "1" });
    assert.notEqual(running.status, 0);
    assert.match(running.output, /OpenCode is running/);
    assert.equal(snapshotTree(harness.app), harness.originalTree);
    assert.equal(fs.existsSync(harness.backupRoot), false, "running-app refusal created a backup");
    record("apply-dry-run", dryRun);
    record("apply-running-refusal", running);
  } finally { cleanup(harness); }
});

test("macOS apply and restore preserve a full bundle and restore --dry-run is read-only", simulationTestOptions, () => {
  const harness = makeHarness("lifecycle");
  try {
    const applied = runScript(harness, "apply-oc-mic.sh", scriptArgs(harness));
    assert.equal(applied.status, 0, applied.output);
    assert.match(applied.output, /complete/);
    assert.notEqual(snapshotTree(harness.app), harness.originalTree);
    assert.match(fs.readFileSync(path.join(harness.app, "Contents", "Info.plist"), "utf8"), /NSMicrophoneUsageDescription=/);
    assert.equal(fs.readFileSync(path.join(harness.app, "Contents", "fake-fuse-state"), "utf8").trim(), "Disabled");
    const manifests = support.listManifests(harness.backupRoot, "macos");
    assert.equal(manifests.length, 1);
    const manifestFile = manifests[0].filename;
    const manifestBeforeDryRun = fs.readFileSync(manifestFile);
    const manifest = manifests[0].manifest;
    assert.equal(manifest.state, "applied");
    const originalBundle = path.resolve(path.dirname(manifestFile), manifest.originalBundle);
    assert.equal(snapshotTree(originalBundle), harness.originalTree, "full-bundle backup is not byte-identical");
    assert.equal(manifest.originalBundleTreeSha256, support.bundleTreeDigest(originalBundle).sha256);

    const patchedTree = snapshotTree(harness.app);
    const dryRun = runScript(harness, "restore-oc-mic.sh", scriptArgs(harness, ["--dry-run"]));
    assert.equal(dryRun.status, 0, dryRun.output);
    assert.match(dryRun.output, /dry run verified/);
    assert.equal(snapshotTree(harness.app), patchedTree);
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBeforeDryRun, "restore --dry-run changed manifest");

    const restored = runScript(harness, "restore-oc-mic.sh", scriptArgs(harness));
    assert.equal(restored.status, 0, restored.output);
    assert.match(restored.output, /complete/);
    assert.equal(snapshotTree(harness.app), harness.originalTree, "restored bundle is not byte-identical");
    assert.equal(sha256File(path.join(harness.app, "Contents", "Resources", "app.asar")), harness.originalAsar);
    assert.doesNotMatch(fs.readFileSync(path.join(harness.app, "Contents", "Info.plist"), "utf8"), /NSMicrophoneUsageDescription=/);
    assert.equal(fs.readFileSync(path.join(harness.app, "Contents", "fake-fuse-state"), "utf8").trim(), "Enabled");
    assert.equal(support.listManifests(harness.backupRoot, "macos")[0].manifest.state, "restored");
    record("apply-full-bundle", applied, { manifestState: "applied", fullBundleBackupByteIdentical: true });
    record("restore-dry-run", dryRun, { appTreeUnchanged: true, manifestUnchanged: true });
    record("restore-full-bundle", restored, { fullBundleRestoreByteIdentical: true, manifestState: "restored" });
  } finally { cleanup(harness); }
});

test("macOS signature, fuse, and backup-copy failures never replace the app", simulationTestOptions, () => {
  const failures = [
    ["ditto", { FAKE_DITTO_FAIL: "1" }],
    ["fuse-read", { FAKE_NPX_FAIL: "read" }],
    ["fuse-write", { FAKE_NPX_FAIL: "write" }],
    ["codesign", { FAKE_CODESIGN_FAIL: "1" }],
  ];
  for (const [name, overrides] of failures) {
    const harness = makeHarness("failure-" + name);
    try {
      const result = runScript(harness, "apply-oc-mic.sh", scriptArgs(harness), overrides);
      assert.notEqual(result.status, 0, name + " unexpectedly succeeded");
      assert.equal(snapshotTree(harness.app), harness.originalTree, name + " replaced the app after failure");
      assert.equal(sha256File(path.join(harness.app, "Contents", "Resources", "app.asar")), harness.originalAsar);
      record("apply-failure-" + name, result, { appUnchanged: true });
    } finally { cleanup(harness); }
  }
});

test("macOS swap and manifest-commit failures roll back to the prior bundle", simulationTestOptions, () => {
  const swapHarness = makeHarness("swap-failure");
  try {
    const result = runScript(swapHarness, "apply-oc-mic.sh", scriptArgs(swapHarness), { FAKE_MV_FAIL_STAGE: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /bundle swap failed/);
    assert.equal(snapshotTree(swapHarness.app), swapHarness.originalTree);
    record("apply-swap-failure-rollback", result, { appUnchanged: true });
  } finally { cleanup(swapHarness); }

  const applyCommitHarness = makeHarness("apply-commit-failure");
  try {
    const result = runScript(applyCommitHarness, "apply-oc-mic.sh", scriptArgs(applyCommitHarness), { FAKE_NODE_FAIL_STATE: "applied" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /manifest commit failed/);
    assert.equal(snapshotTree(applyCommitHarness.app), applyCommitHarness.originalTree);
    record("apply-commit-failure-rollback", result, { appUnchanged: true });
  } finally { cleanup(applyCommitHarness); }

  const restoreSwapHarness = makeHarness("restore-swap-failure");
  try {
    const applied = runScript(restoreSwapHarness, "apply-oc-mic.sh", scriptArgs(restoreSwapHarness));
    assert.equal(applied.status, 0, applied.output);
    const patchedTree = snapshotTree(restoreSwapHarness.app);
    const result = runScript(restoreSwapHarness, "restore-oc-mic.sh", scriptArgs(restoreSwapHarness), { FAKE_MV_FAIL_RESTORE: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /bundle restore swap failed/);
    assert.equal(snapshotTree(restoreSwapHarness.app), patchedTree);
    record("restore-swap-failure-rollback", result, { appUnchanged: true });
  } finally { cleanup(restoreSwapHarness); }

  const restoreCommitHarness = makeHarness("restore-commit-failure");
  try {
    const applied = runScript(restoreCommitHarness, "apply-oc-mic.sh", scriptArgs(restoreCommitHarness));
    assert.equal(applied.status, 0, applied.output);
    const patchedTree = snapshotTree(restoreCommitHarness.app);
    const result = runScript(restoreCommitHarness, "restore-oc-mic.sh", scriptArgs(restoreCommitHarness), { FAKE_NODE_FAIL_STATE: "restored" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /manifest commit failed/);
    assert.equal(snapshotTree(restoreCommitHarness.app), patchedTree);
    record("restore-commit-failure-rollback", result, { appUnchanged: true });
  } finally { cleanup(restoreCommitHarness); }
});

test("macOS restore refuses a corrupt backup and a cross-version app", simulationTestOptions, () => {
  const harness = makeHarness("integrity");
  try {
    const applied = runScript(harness, "apply-oc-mic.sh", scriptArgs(harness));
    assert.equal(applied.status, 0, applied.output);
    const patchedTree = snapshotTree(harness.app);
    const manifestEntry = support.listManifests(harness.backupRoot, "macos")[0];
    const originalBundle = path.resolve(path.dirname(manifestEntry.filename), manifestEntry.manifest.originalBundle);
    fs.appendFileSync(path.join(originalBundle, "Contents", "Info.plist"), "corruption\n");
    const corrupt = runScript(harness, "restore-oc-mic.sh", scriptArgs(harness, ["--dry-run"]));
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.output, /backup tree|corrupt|match/);
    assert.equal(snapshotTree(harness.app), patchedTree, "corrupt-backup refusal changed the app");
    assert.equal(support.listManifests(harness.backupRoot, "macos")[0].manifest.state, "applied");
    const upgraded = makeAsar(baseFiles(), "9.9.9");
    fs.writeFileSync(path.join(harness.app, "Contents", "Resources", "app.asar"), upgraded);
    const upgradedTree = snapshotTree(harness.app);
    const crossVersion = runScript(harness, "restore-oc-mic.sh", scriptArgs(harness, ["--dry-run"]));
    assert.notEqual(crossVersion.status, 0);
    assert.match(crossVersion.output, /cross-version|version|match/);
    assert.equal(snapshotTree(harness.app), upgradedTree, "cross-version refusal changed the app");
    record("restore-corrupt-backup-refusal", corrupt, { appUnchanged: true });
    record("restore-cross-version-refusal", crossVersion, { appUnchanged: true });
  } finally { cleanup(harness); }
});

test.after(() => {
  evidence.summary = {
    checkCount: evidence.tests.length,
    passCount: evidence.tests.filter(item => item.status === "PASS").length,
    expectedRefusalCount: evidence.tests.filter(item => item.expectedRefusal).length,
    skippedCount: simulationSkipReason ? simulationTestNames.length : 0,
  };
  const output = path.join(projectRoot, "test-results", "macos-release-simulation.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
});
