"use strict";
// Upgrade the archive and Python runtime as one recoverable transaction.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const support = require("./install-support.cjs"), patcher = require("./patch-package.cjs");
const FILES = { "voice_server.py": "voice_server.py", "stt_server.py": "voice_server.py", "voice_cli.py": "voice_cli.py", "desktop-bridge.cjs": "desktop-bridge.cjs", "voice_text.py": "voice_text.py", "voice_secrets.py": "voice_secrets.py" };
const SETTINGS = ["config.json", "rewrite_api_key"];
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root, file) { const relative = path.relative(root, file); return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); }
function real(value) { return fs.realpathSync.native(path.resolve(value)); }
function paths(args) {
  const app = real(args.app), runtime = real(args.runtime), home = real(args.home), input = real(args.input);
  if (!inside(app, input)) throw new Error("archive must be inside the application directory");
  for (const directory of [app, runtime, home]) if (!fs.statSync(directory).isDirectory()) throw new Error("target must be a directory");
  if (same(runtime, home) || inside(runtime, home) || inside(home, runtime)) throw new Error("runtime and configuration directories must be separate");
  return { app, runtime, home, input };
}
function checkClosed() {
  if (process.platform !== "win32") return;
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.toLowerCase() === "psmodulepath") delete environment[name];
  const result = cp.spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "$ErrorActionPreference='Stop'; if (Get-Process -Name OpenCode -ErrorAction SilentlyContinue) { exit 9 }"], { windowsHide: true, encoding: "utf8", env: environment, timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error("Close OpenCode before applying or restoring the feature update");
}
function stop(args) {
  const result = cp.spawnSync(args.python, [path.join(__dirname, "install-support.py"), "stop-service", "--voice-home", args.home], { windowsHide: true, encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) throw new Error("Authenticated service shutdown failed: " + (result.stderr || result.error?.message || result.status));
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}
function snapshot(targets, directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return targets.map(({ group, name, target }) => {
    const saved = group + "/" + name;
    if (!fs.existsSync(target)) return { group, name, exists: false };
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("refusing non-file or linked runtime/configuration target: " + target);
    const bytes = fs.readFileSync(target); patcher.writeAtomic(path.join(directory, saved), bytes);
    return { group, name, exists: true, saved, sha256: hash(bytes), mode: stat.mode & 0o777 };
  });
}
function targets(p) { return [...Object.keys(FILES).map(name => ({ group: "runtime", name, target: path.join(p.runtime, name) })), ...SETTINGS.map(name => ({ group: "home", name, target: path.join(p.home, name) }))]; }
function verifySnapshot(entries, directory, p) {
  const expected = targets(p);
  if (!Array.isArray(entries) || entries.length !== expected.length) throw new Error("runtime backup manifest is incomplete");
  for (let i = 0; i < expected.length; i++) {
    const entry = entries[i], target = expected[i];
    if (entry.group !== target.group || entry.name !== target.name || typeof entry.exists !== "boolean") throw new Error("runtime backup target mismatch");
    if (entry.exists && (entry.saved !== entry.group + "/" + entry.name || !/^[0-9a-f]{64}$/.test(entry.sha256 || "") || hash(fs.readFileSync(path.join(directory, entry.saved))) !== entry.sha256)) throw new Error("runtime backup is corrupt");
  }
}
function recover(entries, directory, p, options = {}) {
  verifySnapshot(entries, directory, p);
  for (const entry of entries) {
    if (options.runtimeOnly && entry.group !== "runtime") continue;
    const target = path.join(p[entry.group], entry.name);
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())) throw new Error("recovery target is not a regular file");
    if (entry.exists) {
      patcher.writeAtomic(target, fs.readFileSync(path.join(directory, entry.saved)));
      fs.chmodSync(target, entry.mode);
    } else if (fs.existsSync(target)) fs.unlinkSync(target); // Explicit known file only; never remove directories.
  }
}
function save(directory, manifest) { patcher.writeAtomic(path.join(directory, "feature-manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n")); }
function discardIncomplete(directory, error, phase) {
  if (!directory) throw new Error(error.message + "; feature " + phase + " failed; no files were deployed");
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (cleanup) { throw new Error(error.message + "; incomplete feature backup cleanup failed: " + cleanup.message + "; backup: " + directory); }
  throw new Error(error.message + "; feature " + phase + " failed; no files were deployed and the incomplete transaction was removed");
}
function apply(args, hooks = {}) {
  if (args.platform && args.platform !== "windows") throw new Error("feature transaction supports Windows; macOS requires its full signed-bundle workflow");
  const p = paths(args), root = support.validateBackupRoot({ backupRoot: args.backupRoot, app: p.app, input: p.input, targets: [p.app, p.runtime, p.home] });
  const current = support.inspectAsarFile(p.input), candidate = support.inspectAsarFile(args.patched);
  if (args.expectedSourceHash != null && (!/^[0-9a-f]{64}$/.test(args.expectedSourceHash) || args.expectedSourceHash !== current.hash)) throw new Error("application archive changed since candidate generation");
  if (current.version !== candidate.version || current.hash === candidate.hash) throw new Error("candidate must change the same application version");
  const source = real(args.source || __dirname), replacement = Object.entries(FILES).map(([name, src]) => ({ name, data: fs.readFileSync(path.join(source, src)) }));
  if (args.dryRun) return { state: "dry-run", version: "0.2.0", appVersion: current.version, before: current.hash, after: candidate.hash, files: replacement.map(f => f.name) };
  (hooks.checkClosed || checkClosed)();
  if (!fs.existsSync(args.python)) throw new Error("existing Python environment is required");
  if (process.platform === "win32" && /^python(?:\d+(?:\.\d+)*)?\.exe$/i.test(path.basename(args.python)) && !fs.existsSync(path.join(path.dirname(args.python), path.basename(args.python).replace(/^python/i, "pythonw")))) throw new Error("matching windowless Python interpreter is required");
  // Snapshot only after shutdown, so an in-flight config save cannot race the backup.
  (hooks.stop || stop)({ ...args, ...p });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let directory;
  let entries;
  let manifest;
  try {
    directory = fs.mkdtempSync(path.join(root, "v0.2.0-")); fs.chmodSync(directory, 0o700);
    entries = snapshot(targets(p), path.join(directory, "before"));
    const originalBytes = fs.readFileSync(p.input);
    if (hash(originalBytes) !== current.hash) throw new Error("application archive changed before feature backup");
    patcher.writeAtomic(path.join(directory, "app.asar.before"), originalBytes);
    manifest = { schema: 1, featureVersion: "0.2.0", ...p, appVersion: current.version, sourceAsarSha256: current.hash, patchedAsarSha256: candidate.hash, createdAt: new Date().toISOString(), entries, state: "prepared" };
    save(directory, manifest);
  } catch (error) {
    discardIncomplete(directory, error, "backup preparation");
  }
  try {
    (hooks.checkClosed || checkClosed)();
    if (support.inspectAsarFile(p.input).hash !== current.hash) throw new Error("application archive changed before deployment");
    for (const entry of replacement) { patcher.writeAtomic(path.join(p.runtime, entry.name), entry.data); hooks.afterFile?.(entry.name); }
    support.applyAsar({ platform: "windows", app: p.app, input: p.input, patched: args.patched, backupRoot: path.join(directory, "asar-ledger"), expectedSourceHash: current.hash, beforeCommit() {
      (hooks.checkClosed || checkClosed)();
    } });
    manifest.state = "applied"; manifest.appliedAt = new Date().toISOString(); save(directory, manifest);
  } catch (error) {
    try {
      const actualHash = support.inspectAsarFile(p.input).hash;
      if (actualHash === candidate.hash) support.atomicReplaceFile(path.join(directory, "app.asar.before"), p.input, { beforeCommit(_staged, destination) {
        if (support.inspectAsarFile(destination).hash !== candidate.hash) throw new Error("application archive changed during feature rollback");
      } });
      // Apply does not write user settings. Only undo the runtime files we
      // changed, and never replace a concurrent official update with an old ASAR.
      recover(entries, path.join(directory, "before"), p, { runtimeOnly: true });
      manifest.state = "apply-failed"; save(directory, manifest);
    } catch (rollback) { throw new Error(error.message + "; rollback failed: " + rollback.message + "; backup: " + directory); }
    throw error;
  }
  return { state: manifest.state, transaction: directory, sourceAsarSha256: current.hash, patchedAsarSha256: candidate.hash };
}
function restore(args, hooks = {}) {
  const p = paths(args), directory = support.validateTransactionPath(args.transaction), manifest = JSON.parse(fs.readFileSync(path.join(directory, "feature-manifest.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.featureVersion !== "0.2.0" || manifest.state !== "applied") throw new Error("feature backup is not an applied 0.2.0 transaction");
  for (const key of Object.keys(p)) if (!same(p[key], manifest[key])) throw new Error("feature backup target path mismatch");
  const current = support.inspectAsarFile(p.input);
  if (current.version !== manifest.appVersion || current.hash !== manifest.patchedAsarSha256) throw new Error("current app version/hash differs from the feature backup");
  const original = path.join(directory, "app.asar.before");
  if (hash(fs.readFileSync(original)) !== manifest.sourceAsarSha256) throw new Error("original archive backup is corrupt");
  verifySnapshot(manifest.entries, path.join(directory, "before"), p);
  if (args.dryRun) return { state: "dry-run", transaction: directory, restoring: manifest.sourceAsarSha256 };
  (hooks.checkClosed || checkClosed)(); (hooks.stop || stop)({ ...args, ...p });
  let afterDirectory;
  let after;
  try {
    afterDirectory = fs.mkdtempSync(path.join(directory, "before-restore-"));
    after = snapshot(targets(p), afterDirectory); patcher.writeAtomic(path.join(afterDirectory, "app.asar"), fs.readFileSync(p.input));
    patcher.writeAtomic(path.join(afterDirectory, "snapshot.json"), Buffer.from(JSON.stringify(after, null, 2)));
  } catch (error) {
    discardIncomplete(afterDirectory, error, "restore preparation");
  }
  try {
    recover(manifest.entries, path.join(directory, "before"), p);
    hooks.afterRestoreRuntime?.(); support.atomicReplaceFile(original, p.input, { beforeCommit(_staged, destination) {
      (hooks.checkClosed || checkClosed)();
      if (support.inspectAsarFile(destination).hash !== current.hash) throw new Error("application archive changed during feature restore");
    } });
    manifest.state = "restored"; manifest.restoredAt = new Date().toISOString(); manifest.postUpdateSnapshot = path.basename(afterDirectory); save(directory, manifest);
  } catch (error) {
    try {
      recover(after, afterDirectory, p);
      if (support.inspectAsarFile(p.input).hash === manifest.sourceAsarSha256) support.atomicReplaceFile(path.join(afterDirectory, "app.asar"), p.input, { beforeCommit(_staged, destination) {
        if (support.inspectAsarFile(destination).hash !== manifest.sourceAsarSha256) throw new Error("application archive changed during restore rollback");
      } });
    }
    catch (rollback) { throw new Error(error.message + "; rollback failed: " + rollback.message + "; backup: " + directory); }
    throw error;
  }
  return { state: "restored", transaction: directory, preservedNewSettings: afterDirectory, sourceAsarSha256: manifest.sourceAsarSha256 };
}
function runCli(argv) {
  const command = argv.shift(), args = {};
  while (argv.length) { const key = argv.shift(); if (!/^--[a-z-]+$/.test(key)) throw new Error("invalid argument"); const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase()); if (Object.hasOwn(args, name)) throw new Error("duplicate argument"); args[name] = name === "dryRun" ? true : argv.shift(); }
  if (!["apply", "restore"].includes(command)) throw new Error("use apply or restore");
  const result = command === "apply" ? apply(args) : restore(args);
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (require.main === module) { try { runCli(process.argv.slice(2)); } catch (error) { console.error("[feature-update] " + error.message); process.exitCode = 1; } }
module.exports = { apply, restore, FILES, SETTINGS };
