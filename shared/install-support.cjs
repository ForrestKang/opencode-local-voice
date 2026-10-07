"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const patchPackage = require("./patch-package.cjs");

const MANIFEST_SCHEMA = 2;

function fail(message) { throw new Error(message); }
function hashFile(filename) { return patchPackage.sha256(fs.readFileSync(filename)); }
function hashFileStreaming(filename) {
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return digest.digest("hex");
}
function bundleTreeDigest(bundlePath) {
  const root = path.resolve(bundlePath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("bundle tree root must be a real directory: " + root);
  const entries = [{ path: ".", type: "directory" }];
  function walk(directory, relative) {
    const names = fs.readdirSync(directory).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      const filename = path.join(directory, name);
      const entryPath = relative ? relative + "/" + name : name;
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) {
        entries.push({ path: entryPath, type: "symlink", target: fs.readlinkSync(filename) });
      } else if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: "directory" });
        walk(filename, entryPath);
      } else if (stat.isFile()) {
        entries.push({ path: entryPath, type: "file", sha256: hashFileStreaming(filename) });
      } else {
        fail("bundle contains an unsupported filesystem entry: " + filename);
      }
    }
  }
  walk(root, "");
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    sha256: crypto.createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex"),
    entries: entries.length,
  };
}
function canonical(filename) {
  const absolute = path.resolve(filename);
  try { return fs.realpathSync.native(absolute); } catch (_) { return absolute; }
}
function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "") || "unknown";
}
function inspectAsarFile(filename) {
  const buffer = fs.readFileSync(filename);
  const metadata = patchPackage.inspectAsarBuffer(buffer);
  return { ...metadata, hash: patchPackage.sha256(buffer) };
}
function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let fd;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); } catch (_) {}
  finally { if (fd != null) fs.closeSync(fd); }
}
function writeAtomic(filename, data, mode = 0o600) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "." + path.basename(filename) + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    fsyncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}
function atomicReplaceFile(source, destination, options = {}) {
  const directory = path.dirname(destination);
  let sourceStat, destinationStat;
  try { sourceStat = fs.lstatSync(source); } catch (_) { fail("replacement source is missing: " + source); }
  try { destinationStat = fs.lstatSync(destination); } catch (_) { fail("replacement target is missing: " + destination); }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail("replacement source must be a regular file: " + source);
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) fail("replacement target must be a regular file: " + destination);
  fs.mkdirSync(directory, { recursive: true });
  const staged = path.join(directory, "." + path.basename(destination) + ".stage-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  try {
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    const sourceMode = fs.statSync(destination).mode & 0o777;
    try { fs.chmodSync(staged, sourceMode); } catch (_) {}
    if (hashFile(staged) !== hashFile(source)) fail("staged replacement hash mismatch");
    if (options.beforeCommit) options.beforeCommit(staged, destination);
    // Same-directory rename is atomic. If the OS refuses replacement (for
    // example, an app still holds the archive open), the original remains.
    fs.renameSync(staged, destination);
    fsyncDirectory(directory);
    if (hashFile(destination) !== hashFile(source)) fail("replacement verification failed");
  } finally {
    try { fs.unlinkSync(staged); } catch (_) {}
  }
}

function appPathKey(appPath) {
  const normalized = canonical(appPath).replace(/\\/g, "/");
  return crypto.createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex");
}
function manifestDirectory(backupRoot, platform, version, sourceHash, appPath) {
  const base = path.join(path.resolve(backupRoot), platform, safeSegment(version), sourceHash);
  return appPath ? path.join(base, appPathKey(appPath)) : base;
}
function manifestFile(directory) { return path.join(directory, "manifest.json"); }
function saveManifest(directory, manifest) {
  fs.mkdirSync(directory, { recursive: true });
  writeAtomic(manifestFile(directory), Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
}
function readManifest(filename) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { fail("backup manifest is unreadable: " + filename + ": " + error.message); }
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || !manifest.platform || !manifest.appVersion ||
      !/^[0-9a-f]{64}$/.test(manifest.sourceAsarSha256 || "") || !/^[0-9a-f]{64}$/.test(manifest.patchedAsarSha256 || "")) {
    fail("backup manifest is incomplete: " + filename);
  }
  return manifest;
}
function listManifests(backupRoot, platform) {
  const root = path.join(path.resolve(backupRoot), platform);
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const version of fs.readdirSync(root, { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    const versionDir = path.join(root, version.name);
    for (const source of fs.readdirSync(versionDir, { withFileTypes: true })) {
      if (!source.isDirectory()) continue;
      const sourceDir = path.join(versionDir, source.name);
      const directManifest = manifestFile(sourceDir);
      if (fs.existsSync(directManifest)) result.push({ filename: directManifest, manifest: readManifest(directManifest) });
      for (const app of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!app.isDirectory()) continue;
        const filename = manifestFile(path.join(sourceDir, app.name));
        if (fs.existsSync(filename)) result.push({ filename, manifest: readManifest(filename) });
      }
    }
  }
  return result;
}
function pathMatches(left, right) {
  const a = canonical(left).replace(/\\/g, "/");
  const b = canonical(right).replace(/\\/g, "/");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function archiveBackupPath(directory) { return path.join(directory, "app.asar.original"); }
function pathInside(root, filename) {
  const relative = path.relative(root, filename);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function rejectLinkedPath(filename, label) {
  let cursor = path.resolve(filename);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      stat = null;
    }
    if (stat?.isSymbolicLink()) fail(label + " must not contain a linked path component: " + cursor);
    if (stat && !stat.isDirectory() && cursor !== path.parse(cursor).root) fail(label + " path component must be a directory: " + cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function validateBackupRoot(args) {
  if (!args || typeof args.backupRoot !== "string" || !args.backupRoot.trim()) fail("backup root is required");
  const app = canonical(args.app);
  const input = path.resolve(args.input);
  const hasExplicitTargets = Array.isArray(args.targets) && args.targets.length;
  const targets = hasExplicitTargets ? args.targets : [app];
  const outsideMessage = hasExplicitTargets ? "backup root must be outside target directories" : "backup root must be outside the application directory";
  const root = path.resolve(args.backupRoot);
  const realRoot = canonical(root);
  if (pathMatches(realRoot, input)) fail("backup root must not be the application archive");
  rejectLinkedPath(root, "backup root");
  for (const target of targets) {
    const resolvedTarget = canonical(target);
    if (pathMatches(realRoot, resolvedTarget) || pathInside(resolvedTarget, realRoot)) fail(outsideMessage);
  }
  return root;
}
function validateTransactionPath(filename) {
  if (typeof filename !== "string" || !filename.trim()) fail("feature transaction path is required");
  const directory = path.resolve(filename);
  rejectLinkedPath(directory, "feature transaction");
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (_) { fail("feature transaction directory is missing: " + directory); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("feature transaction must be a real directory: " + directory);
  return directory;
}

function applyAsar(args) {
  const app = canonical(args.app);
  const input = path.resolve(args.input);
  const patched = path.resolve(args.patched);
  const backupRoot = validateBackupRoot({ backupRoot: args.backupRoot, app, input });
  if (!fs.statSync(app).isDirectory()) fail("application path must be a directory");
  const current = inspectAsarFile(input);
  const candidate = inspectAsarFile(patched);
  if (args.expectedSourceHash != null && (!/^[0-9a-f]{64}$/.test(args.expectedSourceHash) || args.expectedSourceHash !== current.hash)) fail("application archive changed since candidate generation");
  if (current.version !== candidate.version) fail("patched archive version does not match current app; refusing cross-version install");
  if (current.hash === candidate.hash) fail("candidate archive is identical to the current archive");

  const existing = listManifests(backupRoot, args.platform).find(item =>
    pathMatches(item.manifest.appPath, app) && item.manifest.appVersion === current.version &&
    item.manifest.patchedAsarSha256 === current.hash);
  if (existing) fail("application already has this patch; use restore or regenerate from the original archive");
  const directory = manifestDirectory(backupRoot, args.platform, current.version, current.hash, app);
  const backup = archiveBackupPath(directory);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(backup)) {
    if (hashFile(backup) !== current.hash) fail("existing versioned backup does not match the current archive");
  } else {
    const originalBytes = fs.readFileSync(input);
    if (patchPackage.sha256(originalBytes) !== current.hash) fail("application archive changed before backup");
    writeAtomic(backup, originalBytes);
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    platform: args.platform,
    appPath: app,
    appVersion: current.version,
    sourceAsarSha256: current.hash,
    patchedAsarSha256: candidate.hash,
    originalArchive: path.relative(directory, backup),
    createdAt: new Date().toISOString(),
    state: "prepared",
  };
  saveManifest(directory, manifest);
  try {
    atomicReplaceFile(patched, input, { beforeCommit(staged, destination) {
      args.beforeCommit?.(staged, destination);
      if (hashFile(staged) !== candidate.hash) fail("candidate archive changed after validation");
      if (hashFile(destination) !== current.hash) fail("application archive changed before commit");
    } });
    manifest.state = "applied";
    manifest.appliedAt = new Date().toISOString();
    saveManifest(directory, manifest);
  } catch (error) {
    // If replacement reached the commit point before an error surfaced,
    // including if the final manifest commit failed, recover the exact source.
    let failure = error;
    try {
      const actualHash = hashFile(input);
      if (actualHash === candidate.hash) {
        atomicReplaceFile(backup, input, { beforeCommit(_staged, destination) {
          if (hashFile(destination) !== candidate.hash) fail("application archive changed during rollback");
        } });
        if (hashFile(input) !== current.hash) fail("original archive recovery hash mismatch");
      } else if (actualHash !== current.hash) {
        failure = new Error(error.message + "; external archive change retained; refusing cross-update rollback");
      }
    } catch (rollbackError) {
      failure = new Error((error.message || error) + "; rollback failed: " + (rollbackError.message || rollbackError));
    }
    manifest.state = "apply-failed";
    manifest.failure = String(failure.message || failure).slice(0, 500);
    try { saveManifest(directory, manifest); } catch (_) { /* archive rollback takes priority over audit update */ }
    throw failure;
  }
  return { ...manifest, backupDirectory: directory };
}

function matchingRestore(args, current) {
  const manifests = listManifests(args.backupRoot, args.platform);
  const forApp = manifests.filter(item => pathMatches(item.manifest.appPath, args.app));
  const exactVersion = forApp.filter(item => item.manifest.appVersion === current.version);
  const match = exactVersion.find(item => item.manifest.patchedAsarSha256 === current.hash);
  if (match) return match;
  if (forApp.some(item => item.manifest.appVersion !== current.version)) {
    fail("installed app version does not match its backup manifest; refusing cross-version restore");
  }
  if (exactVersion.length > 0) fail("current app.asar hash does not match the patched archive recorded in its manifest");
  fail("no matching backup manifest exists for this app path and version");
}

function restoreAsar(args) {
  const app = canonical(args.app);
  const input = path.resolve(args.input);
  const current = inspectAsarFile(input);
  const matched = matchingRestore({ ...args, app }, current);
  const manifest = matched.manifest;
  const backup = path.resolve(path.dirname(matched.filename), manifest.originalArchive);
  if (!fs.existsSync(backup) || hashFile(backup) !== manifest.sourceAsarSha256) fail("versioned original archive is missing or corrupt");
  const directory = path.dirname(matched.filename);
  const rollback = path.join(path.dirname(input), "." + path.basename(input) + ".rollback-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  writeAtomic(rollback, fs.readFileSync(input));
  if (hashFile(rollback) !== current.hash) {
    try { fs.unlinkSync(rollback); } catch (_) {}
    fail("could not stage the exact patched archive for rollback");
  }
  try {
    atomicReplaceFile(backup, input);
    const restored = inspectAsarFile(input);
    if (restored.version !== manifest.appVersion || restored.hash !== manifest.sourceAsarSha256) fail("restored archive failed manifest verification");
    manifest.state = "restored";
    manifest.restoredAt = new Date().toISOString();
    saveManifest(directory, manifest);
    return { ...manifest, input };
  } catch (error) {
    let failure = error;
    try {
      if (hashFile(input) !== current.hash) {
        atomicReplaceFile(rollback, input);
        if (hashFile(input) !== current.hash) fail("patched archive recovery hash mismatch");
      }
    } catch (rollbackError) {
      failure = new Error((error.message || error) + "; patched archive rollback failed: " + (rollbackError.message || rollbackError));
    }
    manifest.state = "restore-failed";
    manifest.failure = String(failure.message || failure).slice(0, 500);
    try { saveManifest(directory, manifest); } catch (_) { /* keep archive rollback independent of manifest writes */ }
    throw failure;
  } finally {
    try { fs.unlinkSync(rollback); } catch (_) {}
  }
}

function prepareBundleManifest(args) {
  const app = canonical(args.app);
  const candidateApp = canonical(args.candidate);
  const originalAsar = path.resolve(args.input);
  const candidateAsar = path.resolve(args.patched);
  const originalBundle = path.resolve(args.originalBundle);
  const current = inspectAsarFile(originalAsar);
  const patched = inspectAsarFile(candidateAsar);
  const saved = path.join(originalBundle, "Contents", "Resources", "app.asar");
  const staged = path.join(candidateApp, "Contents", "Resources", "app.asar");
  if (current.version !== patched.version) fail("candidate bundle version does not match the original app");
  if (current.hash === patched.hash) fail("candidate ASAR is identical to the original ASAR");
  if (!fs.existsSync(saved) || hashFile(saved) !== current.hash) fail("full-bundle backup does not contain the verified original app.asar");
  if (!fs.existsSync(staged) || hashFile(staged) !== patched.hash) fail("candidate bundle does not contain the verified patched app.asar");
  const sourceTree = bundleTreeDigest(app);
  const originalTree = bundleTreeDigest(originalBundle);
  if (originalTree.sha256 !== sourceTree.sha256 || originalTree.entries !== sourceTree.entries) {
    fail("full-bundle backup tree differs from the original app; refusing to record it as a trusted backup");
  }
  const candidateTree = bundleTreeDigest(candidateApp);
  const directory = manifestDirectory(args.backupRoot, "macos", current.version, current.hash, app);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    platform: "macos",
    appPath: app,
    appVersion: current.version,
    sourceAsarSha256: current.hash,
    patchedAsarSha256: patched.hash,
    originalArchive: null,
    originalBundle: path.relative(directory, originalBundle),
    originalBundleTreeSha256: sourceTree.sha256,
    originalBundleEntryCount: sourceTree.entries,
    candidateBundleTreeSha256: candidateTree.sha256,
    candidateBundleEntryCount: candidateTree.entries,
    fuseBefore: args.fuseBefore,
    fuseAfter: args.fuseAfter,
    createdAt: new Date().toISOString(),
    state: "prepared",
  };
  saveManifest(directory, manifest);
  return { ...manifest, backupDirectory: directory, candidate: candidateApp };
}

function findBundleBackup(args) {
  const app = canonical(args.app);
  const current = inspectAsarFile(args.input);
  const manifests = listManifests(args.backupRoot, "macos").filter(item =>
    pathMatches(item.manifest.appPath, app) && item.manifest.appVersion === current.version &&
    item.manifest.patchedAsarSha256 === current.hash);
  if (manifests.length !== 1) {
    const anyForApp = listManifests(args.backupRoot, "macos").some(item => pathMatches(item.manifest.appPath, app));
    if (anyForApp) fail("current app version or ASAR hash does not match a macOS bundle manifest; refusing cross-version restore");
    fail("no matching original macOS bundle backup exists");
  }
  const { filename, manifest } = manifests[0];
  const originalBundle = path.resolve(path.dirname(filename), manifest.originalBundle);
  const backupAsar = path.join(originalBundle, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(backupAsar) || hashFile(backupAsar) !== manifest.sourceAsarSha256) fail("original macOS bundle backup is missing or corrupt");
  if (!/^[0-9a-f]{64}$/.test(manifest.originalBundleTreeSha256 || "")) fail("macOS manifest has no verified full-bundle tree digest; refusing restore");
  const originalTree = bundleTreeDigest(originalBundle);
  if (originalTree.sha256 !== manifest.originalBundleTreeSha256 || originalTree.entries !== manifest.originalBundleEntryCount) {
    fail("original macOS bundle backup tree does not match its manifest; refusing restore");
  }
  return { manifest, originalBundle, manifestFile: filename };
}

function verifyBundle(args) {
  if (!/^[0-9a-f]{64}$/.test(args.digest || "")) fail("--digest must be a SHA256 bundle-tree digest");
  const actual = bundleTreeDigest(args.bundle);
  if (actual.sha256 !== args.digest) fail("staged macOS bundle tree does not match the verified original bundle");
  return { bundle: path.resolve(args.bundle), sha256: actual.sha256, entries: actual.entries };
}

function setBundleState(args) {
  const app = canonical(args.app);
  const current = inspectAsarFile(args.input);
  const expectsPatched = args.state === "applied" || args.state === "restore-failed";
  const manifests = listManifests(args.backupRoot, "macos").filter(item =>
    pathMatches(item.manifest.appPath, app) && item.manifest.appVersion === current.version &&
    (expectsPatched ? item.manifest.patchedAsarSha256 === current.hash : item.manifest.sourceAsarSha256 === current.hash));
  if (manifests.length !== 1) fail("no unique macOS bundle manifest matches the requested state");
  const { filename, manifest } = manifests[0];
  if (args.state === "applied" || args.state === "restored") {
    const expectedTree = args.state === "applied" ? manifest.candidateBundleTreeSha256 : manifest.originalBundleTreeSha256;
    const expectedEntries = args.state === "applied" ? manifest.candidateBundleEntryCount : manifest.originalBundleEntryCount;
    const actualTree = bundleTreeDigest(app);
    if (!/^[0-9a-f]{64}$/.test(expectedTree || "") || actualTree.sha256 !== expectedTree || actualTree.entries !== expectedEntries) {
      fail("current macOS bundle tree does not match the manifest for state " + args.state);
    }
  }
  manifest.state = args.state;
  manifest[args.state === "applied" ? "appliedAt" : "restoredAt"] = new Date().toISOString();
  saveManifest(path.dirname(filename), manifest);
  return { manifest, manifestFile: filename };
}

function bundleBackupPath(args) {
  const app = canonical(args.app);
  const current = inspectAsarFile(args.input);
  const directory = manifestDirectory(args.backupRoot, "macos", current.version, current.hash, app);
  return { directory, originalBundle: path.join(directory, "original-bundle", path.basename(app)),
    appVersion: current.version, sourceAsarSha256: current.hash };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail("unexpected argument: " + key);
    const name = key.slice(2);
    if (Object.prototype.hasOwnProperty.call(result, name)) fail("duplicate argument: " + key);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("missing value for " + key);
    result[name] = value;
    index += 1;
  }
  return result;
}
function required(args, names) {
  for (const name of names) if (!args[name]) fail("--" + name + " is required");
}
function output(result) { process.stdout.write(JSON.stringify(result) + "\n"); }
function runCli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "apply-asar") {
    required(args, ["platform", "app", "input", "patched", "backup-root"]);
    if (!["windows", "linux"].includes(args.platform)) fail("apply-asar supports windows and linux; macOS needs a full-bundle swap");
    output(applyAsar({ platform: args.platform, app: args.app, input: args.input, patched: args.patched, backupRoot: args["backup-root"] }));
  } else if (command === "restore-asar") {
    required(args, ["platform", "app", "input", "backup-root"]);
    if (!["windows", "linux"].includes(args.platform)) fail("restore-asar supports windows and linux; macOS needs a full-bundle restore");
    output(restoreAsar({ platform: args.platform, app: args.app, input: args.input, backupRoot: args["backup-root"] }));
  } else if (command === "prepare-bundle") {
    required(args, ["app", "candidate", "input", "patched", "original-bundle", "backup-root", "fuse-before", "fuse-after"]);
    output(prepareBundleManifest({ app: args.app, candidate: args.candidate, input: args.input, patched: args.patched,
      originalBundle: args["original-bundle"], backupRoot: args["backup-root"], fuseBefore: args["fuse-before"], fuseAfter: args["fuse-after"] }));
  } else if (command === "find-bundle-backup") {
    required(args, ["app", "input", "backup-root"]);
    output(findBundleBackup({ app: args.app, input: args.input, backupRoot: args["backup-root"] }));
  } else if (command === "set-bundle-state") {
    required(args, ["app", "input", "backup-root", "state"]);
    if (!["applied", "restored", "apply-failed", "restore-failed"].includes(args.state)) fail("invalid bundle state");
    output(setBundleState({ app: args.app, input: args.input, backupRoot: args["backup-root"], state: args.state }));
  } else if (command === "bundle-backup-path") {
    required(args, ["app", "input", "backup-root"]);
    output(bundleBackupPath({ app: args.app, input: args.input, backupRoot: args["backup-root"] }));
  } else if (command === "verify-bundle") {
    required(args, ["bundle", "digest"]);
    output(verifyBundle({ bundle: args.bundle, digest: args.digest }));
  } else {
    fail("command must be apply-asar, restore-asar, prepare-bundle, find-bundle-backup, set-bundle-state, bundle-backup-path, or verify-bundle");
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write("[install] ERROR: " + error.message + "\n"); process.exitCode = 1; }
}

module.exports = {
  applyAsar, restoreAsar, prepareBundleManifest, findBundleBackup, setBundleState, bundleBackupPath,
  atomicReplaceFile, inspectAsarFile, bundleTreeDigest, verifyBundle, manifestDirectory, listManifests, matchingRestore, appPathKey,
  validateBackupRoot, validateTransactionPath, runCli, MANIFEST_SCHEMA,
};
