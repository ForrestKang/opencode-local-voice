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
function directoryBytes(directory) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += directoryBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch (_) {}
  return total;
}
function removeDuplicateLedgerArchive(directory) {
  const ledger = path.join(directory, "asar-ledger");
  if (!fs.existsSync(ledger)) return 0;
  let freed = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "app.asar.original") {
        // feature-update keeps a SHA-256 verified app.asar.before in the same transaction.
        freed += fs.statSync(full).size;
        fs.unlinkSync(full);
      }
    }
  }
  try { walk(ledger); } catch (_) {}
  return freed;
}
function pruneBackups(backupRoot, options = {}) {
  const root = path.resolve(backupRoot);
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    return { removed: [], kept: [], freedBytes: 0 };
  }
  const realRoot = real(root);
  const keepApplied = Number.isInteger(options.keepApplied) && options.keepApplied >= 1 ? options.keepApplied : 1;
  const keepOriginal = options.keepOriginal !== false;
  const currentAppVersion = typeof options.currentAppVersion === "string" && options.currentAppVersion ? options.currentAppVersion : null;
  const pinned = new Set((options.keepTransactions || []).map(item => real(item)));
  const dryRun = Boolean(options.dryRun);

  const records = [];
  for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("v0.2.1-")) continue;
    const dir = path.join(realRoot, entry.name);
    const manifestPath = path.join(dir, "feature-manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch (_) { continue; }
    if (!manifest || manifest.schema !== 1 || manifest.featureVersion !== "0.2.1") continue;
    const stamp = Date.parse(manifest.appliedAt || manifest.createdAt || "") || fs.statSync(manifestPath).mtimeMs;
    records.push({ dir, realDir: real(dir), manifest, stamp });
  }

  const keepSet = new Set();
  for (const rec of records) {
    if (rec.manifest.state === "prepared" || pinned.has(rec.realDir)) keepSet.add(rec.realDir);
  }

  const groups = new Map();
  for (const rec of records) {
    if (rec.manifest.state !== "applied") continue;
    const appKey = (process.platform === "win32" ? String(rec.manifest.app || "").toLowerCase() : String(rec.manifest.app || "")) + "::" + String(rec.manifest.appVersion || "");
    if (!groups.has(appKey)) groups.set(appKey, []);
    groups.get(appKey).push(rec);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.stamp - a.stamp);
    const appVersion = list[0].manifest.appVersion;
    if (currentAppVersion && appVersion !== currentAppVersion) continue;
    const latestKept = list.slice(0, keepApplied);
    for (const rec of latestKept) keepSet.add(rec.realDir);
    if (keepOriginal && list.length > keepApplied) {
      // Preserve the earliest applied transaction whose source hash differs so stock app.asar remains recoverable.
      const earliest = list[list.length - 1];
      const latestHashes = new Set(latestKept.map(item => item.manifest.sourceAsarSha256));
      if (!latestHashes.has(earliest.manifest.sourceAsarSha256)) keepSet.add(earliest.realDir);
    }
  }

  const removed = [];
  const kept = [];
  let freedBytes = 0;
  for (const rec of records) {
    if (keepSet.has(rec.realDir)) {
      if (!dryRun) freedBytes += removeDuplicateLedgerArchive(rec.dir);
      kept.push(rec.dir);
      continue;
    }
    if (!inside(realRoot, rec.realDir)) continue;
    const bytes = directoryBytes(rec.dir);
    if (!dryRun) fs.rmSync(rec.dir, { recursive: true, force: true });
    freedBytes += bytes;
    removed.push(rec.dir);
  }
  return { removed, kept, freedBytes };
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
  if (args.dryRun) return { state: "dry-run", version: "0.2.1", appVersion: current.version, before: current.hash, after: candidate.hash, files: replacement.map(f => f.name) };
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
    directory = fs.mkdtempSync(path.join(root, "v0.2.1-")); fs.chmodSync(directory, 0o700);
    entries = snapshot(targets(p), path.join(directory, "before"));
    const originalBytes = fs.readFileSync(p.input);
    if (hash(originalBytes) !== current.hash) throw new Error("application archive changed before feature backup");
    patcher.writeAtomic(path.join(directory, "app.asar.before"), originalBytes);
    manifest = { schema: 1, featureVersion: "0.2.1", ...p, appVersion: current.version, sourceAsarSha256: current.hash, patchedAsarSha256: candidate.hash, createdAt: new Date().toISOString(), entries, state: "prepared" };
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
    // Avoid keeping two identical full app.asar copies inside one transaction and roll old backups.
    removeDuplicateLedgerArchive(directory);
    if (args.prune !== false) {
      try {
        pruneBackups(root, {
          keepApplied: 1,
          keepOriginal: true,
          currentAppVersion: current.version,
          keepTransactions: [directory],
        });
      } catch (_) {}
    }
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
  if (manifest.schema !== 1 || manifest.featureVersion !== "0.2.1" || manifest.state !== "applied") throw new Error("feature backup is not an applied 0.2.1 transaction");
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
  if (!["apply", "restore", "prune"].includes(command)) throw new Error("use apply, restore, or prune");
  let result;
  if (command === "apply") result = apply(args);
  else if (command === "restore") result = restore(args);
  else result = pruneBackups(args.backupRoot, {
    currentAppVersion: args.appVersion || null,
    keepApplied: args.keepApplied ? Number(args.keepApplied) : 1,
    dryRun: Boolean(args.dryRun),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (require.main === module) { try { runCli(process.argv.slice(2)); } catch (error) { console.error("[feature-update] " + error.message); process.exitCode = 1; } }
module.exports = { apply, restore, pruneBackups, FILES, SETTINGS };
