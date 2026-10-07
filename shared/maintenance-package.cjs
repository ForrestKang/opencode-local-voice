"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const REQUIRED_FILES = ["VERSION",
  ...["patch-package.cjs", "feature-update.cjs", "install-support.cjs", "install-support.py", "voice_server.py", "voice_cli.py", "voice_text.py", "voice_secrets.py", "desktop-bridge.cjs", "oc-mic.js", "native-voice-settings.js", "update-recovery.cjs", "update-bridge.cjs", "update-launcher.pyw", "update-notify.pyw", "maintenance-package.cjs", "maintenance-inspect.cjs"].map(name => "shared/" + name),
  ...["maintenance-processes.ps1", "maintenance-shortcuts.ps1", "install-maintenance.ps1", "restore-maintenance.ps1", "install-feature-preview.ps1", "Repair-Voice.cmd", "Repair-Voice.ps1", "Restore-Voice.cmd", "Restore-Voice.ps1", "maintenance-README.txt", "restore-voice-managed.ps1"].map(name => "windows/" + name)];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function inside(root, file) { const relative = path.relative(root, file); return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); }
function safeRelative(name) {
  if (!name || name.includes("\\") || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe package manifest path");
  if (name.split("/").some(part => ["node_modules", "models", "backups", "test-results", "__pycache__"].includes(part)) || /(?:^|\/)(?:config\.json|token|rewrite_api_key|credentials\.json)$/.test(name)) throw new Error("private data is not a maintenance package file");
  return name;
}
function readRegular(root, name) {
  const file = path.join(root, safeRelative(name));
  if (!inside(root, file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || !inside(root, fs.realpathSync.native(file))) throw new Error("package entry is not a regular contained file: " + name);
  return fs.readFileSync(file);
}
function inspectPackage(root, suppliedManifest) {
  const directory = fs.realpathSync.native(root);
  const version = readRegular(directory, "VERSION").toString("utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("maintenance package VERSION is invalid");
  let manifest = suppliedManifest;
  if (!manifest) {
    const filename = path.join(directory, "CONTENTS.sha256");
    manifest = fs.existsSync(filename) ? readRegular(directory, "CONTENTS.sha256") : Buffer.from(REQUIRED_FILES.slice().sort().map(name => sha(readRegular(directory, name)) + "  " + name).join("\n") + "\n");
  }
  const files = new Map();
  for (const line of manifest.toString("utf8").trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error("maintenance package manifest is malformed");
    const name = safeRelative(match[2]);
    if (files.has(name) || name === "CONTENTS.sha256") throw new Error("duplicate maintenance package entry");
    const bytes = readRegular(directory, name);
    if (sha(bytes) !== match[1]) throw new Error("maintenance package file hash mismatch: " + name);
    files.set(name, bytes);
  }
  for (const name of REQUIRED_FILES) if (!files.has(name)) throw new Error("maintenance package is incomplete: " + name);
  return { directory, featureVersion: version, manifest, manifestSha256: sha(manifest), files };
}
function verifyPackage(root, expectedManifestSha256) {
  const inspected = inspectPackage(root);
  if (expectedManifestSha256 && inspected.manifestSha256 !== expectedManifestSha256) throw new Error("maintenance package manifest hash mismatch");
  return { packageRoot: inspected.directory, manifestSha256: inspected.manifestSha256, featureVersion: inspected.featureVersion, files: inspected.files.size };
}
function ensurePackage(sourceRoot, maintenanceRoot) {
  const source = inspectPackage(sourceRoot);
  fs.mkdirSync(maintenanceRoot, { recursive: true });
  const maintenance = fs.realpathSync.native(maintenanceRoot);
  const cache = path.join(maintenance, "cache");
  fs.mkdirSync(cache, { recursive: true });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error("maintenance cache must not be a link");
  const cacheRoot = fs.realpathSync.native(cache);
  const parent = path.join(cacheRoot, source.featureVersion);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink() || !inside(cacheRoot, fs.realpathSync.native(parent))) throw new Error("maintenance version cache must be contained");
  const destination = path.join(parent, source.manifestSha256);
  if (fs.existsSync(destination)) return verifyPackage(destination, source.manifestSha256);
  const stage = fs.mkdtempSync(path.join(cacheRoot, ".staging-"));
  try {
    for (const [name, bytes] of source.files) {
      const file = path.join(stage, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx" });
    }
    fs.writeFileSync(path.join(stage, "CONTENTS.sha256"), source.manifest, { flag: "wx" });
    verifyPackage(stage, source.manifestSha256);
    try { fs.renameSync(stage, destination); }
    catch (error) { if (!fs.existsSync(destination)) throw error; verifyPackage(destination, source.manifestSha256); }
    return verifyPackage(destination, source.manifestSha256);
  } finally {
    if (fs.existsSync(stage)) {
      const resolved = fs.realpathSync.native(stage);
      if (!fs.lstatSync(stage).isSymbolicLink() && inside(cacheRoot, resolved) && path.basename(resolved).startsWith(".staging-")) fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}
if (require.main === module) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i++) {
      const name = process.argv[i];
      if (Object.hasOwn(args, name)) throw new Error("duplicate cache package argument");
      if (name === "--verify-only") { args[name] = true; continue; }
      if (!["--source", "--maintenance-root"].includes(name) || !process.argv[i + 1]) throw new Error("invalid cache package arguments");
      args[name] = process.argv[++i];
    }
    if (!args["--source"] || (!args["--verify-only"] && !args["--maintenance-root"])) throw new Error("source and maintenance root are required unless verifying only");
    console.log(JSON.stringify(args["--verify-only"] ? verifyPackage(args["--source"]) : ensurePackage(args["--source"], args["--maintenance-root"])));
  } catch (error) { console.error("[maintenance-package] " + error.message); process.exitCode = 1; }
}
module.exports = { REQUIRED_FILES, verifyPackage, ensurePackage };
