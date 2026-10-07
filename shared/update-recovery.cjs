"use strict";

// Windows recovery is deliberately kept outside the packaged application.  It
// only ever mutates the feature runtime and the exact app.asar after the
// process gates have proved that the official updater is finished.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const patcher = require("./patch-package.cjs");
const support = require("./install-support.cjs");
const feature = require("./feature-update.cjs");
const maintenancePackage = require("./maintenance-package.cjs");

const SCHEMA = 1;
const FEATURE_VERSION = "0.2.0";
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const STABLE_MS = 3000;
const POLL_MS = 250;
const HEX64 = /^[0-9a-f]{64}$/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REQUIRED_SOURCE = [
  "shared/patch-package.cjs", "shared/feature-update.cjs", "shared/install-support.cjs",
  "shared/desktop-bridge.cjs", "shared/oc-mic.js", "shared/voice_server.py",
  "shared/voice_cli.py", "shared/voice_text.py", "shared/voice_secrets.py",
  "shared/native-voice-settings.js", "shared/update-bridge.cjs",
  "shared/update-recovery.cjs", "shared/update-launcher.pyw", "shared/update-notify.pyw",
  "shared/maintenance-package.cjs", "shared/maintenance-inspect.cjs", "shared/install-support.py",
  "windows/maintenance-processes.ps1", "windows/maintenance-shortcuts.ps1",
];

function recoveryError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function hashFile(filename, fsa = fs) { return sha256(fsa.readFileSync(filename)); }
function isObject(value) { return value && typeof value === "object" && !Array.isArray(value); }

function pathEqual(left, right, platform = process.platform) {
  const a = path.resolve(left).replace(/\\/g, "/");
  const b = path.resolve(right).replace(/\\/g, "/");
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathInside(root, candidate, platform = process.platform) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === "." || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  return platform !== "win32" || !pathEqual(root, candidate, platform);
}

function canonicalPath(filename, fsa = fs) {
  try { return fsa.realpathSync.native(filename); }
  catch (_) { return path.resolve(filename); }
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw recoveryError("CONFIG_INVALID", label + " must be an absolute path");
  }
  return path.resolve(value);
}

function statRegular(filename, fsa = fs, label = filename) {
  let stat;
  try { stat = fsa.lstatSync(filename); } catch (_) { throw recoveryError("CONFIG_INVALID", label + " is missing"); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw recoveryError("CONFIG_INVALID", label + " must be a regular file");
  return stat;
}

function statDirectory(filename, fsa = fs, label = filename) {
  let stat;
  try { stat = fsa.lstatSync(filename); } catch (_) { throw recoveryError("CONFIG_INVALID", label + " is missing"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryError("CONFIG_INVALID", label + " must be a real directory");
  return stat;
}

function readJson(filename, fsa = fs, label = filename) {
  let value;
  try { value = JSON.parse(fsa.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw recoveryError("JSON_INVALID", label + " is not valid JSON: " + error.message); }
  if (!isObject(value)) throw recoveryError("JSON_INVALID", label + " must contain an object");
  return value;
}

function atomicWrite(filename, data, fsa = fs) {
  if (typeof fsa.writeAtomic === "function") { fsa.writeAtomic(filename, data); return; }
  const directory = path.dirname(filename);
  fsa.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "." + path.basename(filename) + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  try {
    const fd = fsa.openSync(temporary, "wx", 0o600);
    try { fsa.writeFileSync(fd, data); fsa.fsyncSync?.(fd); } finally { fsa.closeSync(fd); }
    fsa.renameSync(temporary, filename);
  } finally { try { fsa.unlinkSync(temporary); } catch (_) {} }
}

function removeFile(filename, fsa = fs) { try { fsa.unlinkSync(filename); } catch (error) { if (error.code !== "ENOENT") throw error; } }

function normalizeHooks(hooks = {}) {
  const processHooks = hooks.process || hooks.processes || {};
  const clock = hooks.clock || {};
  return {
    fs: hooks.fs || fs,
    platform: hooks.platform || process.platform,
    process: processHooks,
    clock: {
      now: typeof clock.now === "function" ? clock.now : () => Date.now(),
      sleep: typeof clock.sleep === "function" ? clock.sleep : ms => new Promise(resolve => setTimeout(resolve, ms)),
    },
    patch: hooks.patch || hooks.patchAsar || patcher.patchAsar,
    apply: hooks.apply || hooks.featureApply || feature.apply,
    applyOptions: hooks.applyOptions || {},
    restore: hooks.restore || feature.restore,
    notify: hooks.notify,
    launch: hooks.launch,
    rebind: hooks.rebind,
    logger: hooks.logger,
    helperPid: Number.isInteger(hooks.helperPid) ? hooks.helperPid : process.pid,
    currentPid: Number.isInteger(hooks.currentPid) ? hooks.currentPid : process.pid,
  };
}

function parseManifest(packageRoot, expectedHash, fsa = fs) {
  const manifestFile = path.join(packageRoot, "CONTENTS.sha256");
  statRegular(manifestFile, fsa, "package manifest");
  const bytes = fsa.readFileSync(manifestFile);
  if (!HEX64.test(expectedHash || "") || sha256(bytes).toLowerCase() !== String(expectedHash).toLowerCase()) {
    throw recoveryError("SOURCE_MANIFEST_CHANGED", "release package manifest hash does not match active.json");
  }
  const entries = new Map();
  for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+(?:\*)?(.+)$/.exec(line);
    if (!match) throw recoveryError("SOURCE_MANIFEST_INVALID", "release package manifest contains an invalid entry");
    const relative = match[2].trim().replace(/\\/g, "/");
    if (!relative || relative.startsWith("/") || relative.includes("\0") || relative.split("/").includes("..") || path.isAbsolute(relative)) {
      throw recoveryError("SOURCE_MANIFEST_INVALID", "release package manifest contains an unsafe path");
    }
    if (entries.has(relative)) throw recoveryError("SOURCE_MANIFEST_INVALID", "release package manifest contains a duplicate path");
    entries.set(relative, match[1].toLowerCase());
  }
  if (!entries.size) throw recoveryError("SOURCE_MANIFEST_INVALID", "release package manifest is empty");
  for (const [relative, expected] of entries) {
    const filename = path.join(packageRoot, ...relative.split("/"));
    statRegular(filename, fsa, "release package file " + relative);
    if (hashFile(filename, fsa).toLowerCase() !== expected) throw recoveryError("SOURCE_FILE_CHANGED", "release package file hash changed: " + relative);
  }
  return { filename: manifestFile, entries, hash: sha256(bytes) };
}

function validateSourceFiles(packageRoot, manifest, fsa = fs, required = REQUIRED_SOURCE) {
  for (const relative of required) {
    if (!manifest.entries.has(relative)) throw recoveryError("SOURCE_ALLOWLIST", "release package does not allow required source: " + relative);
    const filename = path.join(packageRoot, ...relative.split("/"));
    statRegular(filename, fsa, "release package file " + relative);
    if (hashFile(filename, fsa).toLowerCase() !== manifest.entries.get(relative)) {
      throw recoveryError("SOURCE_FILE_CHANGED", "release package file hash changed: " + relative);
    }
  }
}

function validateActiveConfig(configPath, raw, hooks = {}) {
  const fsa = hooks.fs || fs;
  const platform = hooks.platform || process.platform;
  if (!isObject(raw) || raw.schema !== SCHEMA) throw recoveryError("CONFIG_INVALID", "active.json schema must be 1");
  if (typeof raw.featureVersion !== "string" || !SEMVER.test(raw.featureVersion)) throw recoveryError("CONFIG_INVALID", "active.json featureVersion is invalid");
  if (raw.featureVersion !== FEATURE_VERSION) throw recoveryError("CONFIG_INVALID", "active.json featureVersion is not supported");
  if (!HEX64.test(raw.packageManifestSha256 || "")) throw recoveryError("CONFIG_INVALID", "active.json packageManifestSha256 is invalid");
  const fields = ["packageRoot", "node", "python", "pythonw", "app", "home", "runtime", "backupRoot", "maintenanceRoot", "shortcutReceipt"];
  const config = { ...raw, configPath: path.resolve(configPath) };
  for (const field of fields) config[field] = requireAbsolute(raw[field], field);
  config.packageRoot = path.resolve(raw.packageRoot);
  statDirectory(config.packageRoot, fsa, "packageRoot");
  statRegular(config.node, fsa, "node"); statRegular(config.python, fsa, "python"); statRegular(config.pythonw, fsa, "pythonw");
  statDirectory(config.app, fsa, "app"); statDirectory(config.home, fsa, "home"); statDirectory(config.runtime, fsa, "runtime");
  statDirectory(config.backupRoot, fsa, "backupRoot"); statDirectory(config.maintenanceRoot, fsa, "maintenanceRoot");
  const expectedBackupRoot = path.join(config.maintenanceRoot, "backups", FEATURE_VERSION);
  if (!pathEqual(canonicalPath(config.backupRoot, fsa), canonicalPath(expectedBackupRoot, fsa), platform)) {
    throw recoveryError("CONFIG_INVALID", "backupRoot must be maintenance/backups/0.2.0");
  }
  if (!pathInside(config.maintenanceRoot, config.shortcutReceipt, platform) || path.basename(config.shortcutReceipt).toLowerCase() !== "shortcut-receipt.json") {
    throw recoveryError("CONFIG_INVALID", "shortcutReceipt must be maintenance/shortcut-receipt.json");
  }
  if (pathInside(config.app, config.packageRoot, platform) || pathEqual(config.app, config.packageRoot, platform)) throw recoveryError("CONFIG_INVALID", "packageRoot must be outside app");
  for (const field of ["home", "runtime", "backupRoot", "maintenanceRoot"]) {
    if (pathInside(config.app, config[field], platform) || pathEqual(config.app, config[field], platform)) throw recoveryError("CONFIG_INVALID", field + " must be outside app");
  }
  if (pathEqual(config.home, config.runtime, platform) || pathInside(config.home, config.runtime, platform) || pathInside(config.runtime, config.home, platform)) {
    throw recoveryError("CONFIG_INVALID", "home and runtime must be separate directories");
  }
  if (pathEqual(config.backupRoot, config.app, platform) || pathEqual(config.maintenanceRoot, config.app, platform)) throw recoveryError("CONFIG_INVALID", "maintenance paths must be outside app");
  const appReal = canonicalPath(config.app, fsa);
  const protectedRoots = [config.configPath, config.packageRoot, config.home, config.runtime, config.backupRoot, config.maintenanceRoot, config.shortcutReceipt];
  for (const candidate of protectedRoots) {
    const realCandidate = canonicalPath(candidate, fsa);
    if (pathEqual(appReal, realCandidate, platform) || pathInside(appReal, realCandidate, platform)) throw recoveryError("CONFIG_INVALID", "configured path resolves inside app");
  }
  const target = path.join(config.app, "resources", "app.asar");
  statDirectory(path.join(config.app, "resources"), fsa, "app/resources");
  statRegular(target, fsa, "app/resources/app.asar");
  if (!raw.executable) statRegular(path.join(config.app, "OpenCode.exe"), fsa, "app/OpenCode.exe");
  config.targetAsar = target;
  config.sourceRoot = path.join(config.packageRoot, "shared");
  statDirectory(config.sourceRoot, fsa, "packageRoot/shared");
  config.core = requireAbsolute(raw.core || path.join(config.packageRoot, "shared", "update-recovery.cjs"), "core");
  statRegular(config.core, fsa, "core");
  const packageReal = canonicalPath(config.packageRoot, fsa);
  const coreReal = canonicalPath(config.core, fsa);
  if (!pathInside(packageReal, coreReal, platform)) throw recoveryError("CONFIG_INVALID", "core must be inside packageRoot");
  if (raw.executable !== undefined) {
    config.executable = requireAbsolute(raw.executable, "executable");
    if (!pathInside(config.app, config.executable, platform)) throw recoveryError("CONFIG_INVALID", "executable must be inside app");
    statRegular(config.executable, fsa, "executable");
  }
  const manifest = parseManifest(config.packageRoot, config.packageManifestSha256, fsa);
  // The release cache verifier owns the complete package allowlist.  Keep the
  // local parser above for injected filesystems used by Node tests, while the
  // real Windows path gets the same immutable-package checks as installation.
  if (fsa === fs) {
    try {
      const verified = maintenancePackage.verifyPackage(config.packageRoot, config.packageManifestSha256);
      if (verified.featureVersion !== config.featureVersion) throw new Error("maintenance package VERSION does not match active.json");
    }
    catch (error) { throw recoveryError("SOURCE_PACKAGE_INVALID", error.message || String(error)); }
  }
  config.manifest = manifest;
  return config;
}

function loadConfig(configPath, hooks = {}) {
  const fsa = hooks.fs || fs;
  const filename = requireAbsolute(configPath, "config");
  return validateActiveConfig(filename, readJson(filename, fsa, "active.json"), hooks);
}

function normalizeRecord(record) {
  if (!isObject(record)) throw recoveryError("PROCESS_QUERY_FAILED", "process query returned an invalid record");
  const pid = Number(record.pid ?? record.PID ?? record.ProcessId);
  const parent = Number(record.parent ?? record.ParentProcessId ?? record.parentPid ?? record.PPID ?? 0);
  const name = record.name ?? record.Name ?? "";
  const executable = record.path ?? record.Path ?? record.ExecutablePath ?? "";
  const creation = record.creation ?? record.Creation ?? record.CreationDate ?? null;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parent) || parent < 0 || typeof name !== "string" ||
      (executable !== "" && (typeof executable !== "string" || !path.isAbsolute(executable)))) {
    throw recoveryError("PROCESS_QUERY_FAILED", "process query returned an invalid record");
  }
  return { pid, parent, name, path: executable || "", creation: creation == null ? null : String(creation) };
}

function parseProcessOutput(output) {
  let parsed;
  try { parsed = typeof output === "string" ? JSON.parse(output) : output; }
  catch (_) { throw recoveryError("PROCESS_QUERY_FAILED", "process query returned invalid JSON"); }
  if (!Array.isArray(parsed)) parsed = parsed == null ? [] : [parsed];
  return parsed.map(normalizeRecord);
}

function powershellEnvironment(hooks) {
  const source = hooks?.process?.env || process.env;
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}

function defaultListProcesses(config, hooks) {
  if (hooks.platform !== "win32" && hooks.process.list === undefined && hooks.process.listProcesses === undefined) {
    throw recoveryError("PROCESS_QUERY_FAILED", "Windows process query is unavailable");
  }
  const script = path.join(config.packageRoot, "windows", "maintenance-processes.ps1");
  statRegular(script, hooks.fs, "maintenance process script");
  const spawnSync = hooks.process.spawnSync || childProcess.spawnSync;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], env: powershellEnvironment(hooks),
  });
  if (result.error || result.status !== 0) throw recoveryError("PROCESS_QUERY_FAILED", "Windows process query failed");
  return parseProcessOutput(result.stdout);
}

async function listProcesses(config, hooks) {
  const fn = hooks.process.list || hooks.process.listProcesses;
  if (typeof fn === "function") return parseProcessOutput(await fn(config));
  return defaultListProcesses(config, hooks);
}

function pathLooksInside(root, candidate, platform) {
  if (!candidate) return false;
  try { return pathEqual(root, candidate, platform) || pathInside(root, candidate, platform); } catch (_) { return false; }
}

function isOpenCodeRecord(record, config, platform) {
  if (!record || record.pid === config._helperPid) return false;
  const name = String(record.name || "");
  return pathLooksInside(config.app, record.path, platform) || /^opencode(?:\.exe)?$/i.test(name);
}

function appRecords(records, config, hooks) { return records.filter(record => record.pid !== hooks.helperPid && isOpenCodeRecord(record, config, hooks.platform)); }

function targetEntry(metadata, buffer, name) {
  try {
    const node = patcher.getEntry(metadata.header, name);
    return node ? patcher.readEntry(buffer, metadata.dataStart, node, name) : null;
  } catch (_) { return null; }
}

function walkArchiveEntries(node, prefix = "", output = []) {
  if (!node || typeof node !== "object") return output;
  if (node.files && typeof node.files === "object") {
    for (const [name, child] of Object.entries(node.files)) walkArchiveEntries(child, prefix ? prefix + "/" + name : name, output);
  } else if (prefix) output.push({ name: prefix, node });
  return output;
}

function countText(text, needle) {
  return String(text || "").split(needle).length - 1;
}

function archiveHealth(config, fsa = fs) {
  let buffer;
  try { buffer = fsa.readFileSync(config.targetAsar); patcher.inspectAsarBuffer(buffer); }
  catch (error) { return { complete: false, reason: "archive-invalid", error }; }
  let metadata;
  try { metadata = patcher.inspectAsarBuffer(buffer); } catch (error) { return { complete: false, reason: "archive-invalid", error }; }
  const main = targetEntry(metadata, buffer, "out/main/index.js");
  const preload = targetEntry(metadata, buffer, "out/preload/index.js");
  const html = targetEntry(metadata, buffer, "out/renderer/index.html");
  const renderer = targetEntry(metadata, buffer, "out/renderer/oc-voice-v2.js");
  const native = targetEntry(metadata, buffer, "out/renderer/oc-voice-native-settings.js");
  const bridge = targetEntry(metadata, buffer, "out/main/oc-voice-bridge.cjs");
  const updateBridge = targetEntry(metadata, buffer, "out/main/oc-voice-update.cjs");
  const bridgeExpected = config.manifest?.entries?.get("shared/desktop-bridge.cjs");
  const rendererExpected = config.manifest?.entries?.get("shared/oc-mic.js");
  const updateBridgeExpected = config.manifest?.entries?.get("shared/update-bridge.cjs");
  const mainText = main?.toString("utf8") || "";
  const preloadText = preload?.toString("utf8") || "";
  const htmlText = html?.toString("utf8") || "";
  const updateInstallStart = (mainText.match(/\/\*oc-voice-update:install:start\*\//g) || []).length;
  const updateInstallEnd = (mainText.match(/\/\*oc-voice-update:install:end\*\//g) || []).length;
  const updateCallStart = (mainText.match(/\/\*oc-voice-update:call:start\*\//g) || []).length;
  const updateCallEnd = (mainText.match(/\/\*oc-voice-update:call:end\*\//g) || []).length;
  const updateHook = updateInstallStart === 1 && updateInstallEnd === 1 && updateCallStart === 1 && updateCallEnd === 1 &&
    mainText.includes('require2("./oc-voice-update.cjs").prepare') &&
    mainText.includes('require2("./oc-voice-update.cjs").commit') &&
    mainText.includes('require2("./oc-voice-update.cjs").cancel') &&
    mainText.includes('require2("./oc-voice-update.cjs").quitAndInstall');
  const updateBridgeMatches = !!updateBridge && !!updateBridgeExpected && sha256(updateBridge).toLowerCase() === updateBridgeExpected.toLowerCase();
  const bridgeMatches = !!bridge && !!bridgeExpected && sha256(bridge).toLowerCase() === bridgeExpected.toLowerCase();
  const rendererMatches = !!renderer && !!rendererExpected && sha256(renderer).toLowerCase() === rendererExpected.toLowerCase();
  const nativeText = native?.toString("utf8") || "";
  const nativeComponentHealthy = countText(nativeText, "function __ocVoiceNativeSettingsV2(props)") === 1 &&
    countText(nativeText, "function __ocVoiceNativePanel()") === 1 &&
    countText(nativeText, "oc-voice-settings-updated") === 1;
  const nativeCandidates = walkArchiveEntries(metadata.header).filter(item => item.name.startsWith("out/renderer/assets/") && item.name.endsWith(".js"));
  const nativeVariantHealthy = (variant, markers) => {
    const candidate = nativeCandidates.filter(item => {
      const text = targetEntry(metadata, buffer, item.name)?.toString("utf8") || "";
      return markers.every(marker => countText(text, marker) === 1) && countText(text, 'value:"voice-input"') === 2 && countText(text, "createComponent(__ocVoiceNativePanel,{})") === 1;
    });
    return candidate.length === 1;
  };
  const nativeV2Healthy = nativeVariantHealthy("v2", [
    "/*oc-voice-native-settings-v2:helper:start*/", "/*oc-voice-native-settings-v2:helper:end*/",
    "/*oc-voice-native-settings-v2:trigger:start*/", "/*oc-voice-native-settings-v2:trigger:end*/",
    "/*oc-voice-native-settings-v2:content:start*/", "/*oc-voice-native-settings-v2:content:end*/",
  ]);
  const nativeLegacyHealthy = nativeVariantHealthy("legacy", [
    "/*oc-voice-native-settings-legacy:helper:start*/", "/*oc-voice-native-settings-legacy:helper:end*/",
    "/*oc-voice-native-settings-legacy:trigger:start*/", "/*oc-voice-native-settings-legacy:trigger:end*/",
    "/*oc-voice-native-settings-legacy:content:start*/", "/*oc-voice-native-settings-legacy:content:end*/",
  ]);
  const complete = !!main && !!preload && !!html && !!renderer && !!native &&
    updateHook && updateBridgeMatches && bridgeMatches && rendererMatches && nativeComponentHealthy && nativeV2Healthy && nativeLegacyHealthy && mainText.includes("/*oc-voice-v2:start*/") &&
    mainText.includes("/*oc-voice-v2:end*/") &&
    preloadText.includes("/*oc-voice-v2-preload:start*/") &&
    htmlText.includes("./oc-voice-v2.js");
  return { complete, reason: complete ? "ok" : "entry-incomplete", metadata, hash: sha256(buffer), version: metadata.version, updateBridgeMatches, bridgeMatches, rendererMatches, nativeComponentHealthy, nativeV2Healthy, nativeLegacyHealthy, updateHook };
}

function runtimeHealth(config, manifest, fsa = fs) {
  const map = feature.FILES || {};
  const failures = [];
  for (const [name, sourceName] of Object.entries(map)) {
    const relative = "shared/" + sourceName;
    const expected = manifest.entries.get(relative);
    if (!expected) { failures.push(name + ":source-not-allowed"); continue; }
    const target = path.join(config.runtime, name);
    try { statRegular(target, fsa, "runtime/" + name); if (hashFile(target, fsa).toLowerCase() !== expected) failures.push(name + ":hash"); }
    catch (_) { failures.push(name + ":missing"); }
  }
  return { complete: failures.length === 0, failures };
}

function health(config, hooks) {
  const archive = archiveHealth(config, hooks.fs);
  const runtime = runtimeHealth(config, config.manifest, hooks.fs);
  return { complete: archive.complete && runtime.complete, archive, runtime };
}

function writeLog(config, details, hooks) {
  if (!details) return;
  const line = "[" + new Date(hooks.clock.now()).toISOString() + "] " + String(details).replace(/[\r\n]+/g, " ").slice(0, 1200) + "\n";
  try {
    const filename = path.join(config.maintenanceRoot, "recovery.log");
    hooks.fs.mkdirSync(path.dirname(filename), { recursive: true });
    hooks.fs.appendFileSync(filename, line, { encoding: "utf8", mode: 0o600 });
  } catch (_) { if (typeof hooks.logger === "function") { try { hooks.logger(line.trim()); } catch (_) {} } }
}

async function notify(config, message, details, hooks) {
  writeLog(config, details || message, hooks);
  if (typeof hooks.notify === "function") { await hooks.notify(message, details, config); return; }
  const messageFile = path.join(config.maintenanceRoot, "notify-" + hooks.currentPid + "-" + crypto.randomBytes(5).toString("hex") + ".txt");
  try {
    atomicWrite(messageFile, Buffer.from(String(message).slice(0, 240) + "\n", "utf8"), hooks.fs);
    const spawn = hooks.process.spawn || childProcess.spawn;
    const child = spawn(config.pythonw, [path.join(config.packageRoot, "shared", "update-notify.pyw"), "--message-file", messageFile], {
      windowsHide: true, detached: false, stdio: "ignore",
    });
    child?.unref?.();
  } catch (error) { writeLog(config, "notification failed: " + error.message, hooks); }
}

function lockPath(config) { return path.join(config.maintenanceRoot, "recovery.lock"); }

async function holderAlive(record, config, hooks) {
  if (typeof hooks.process.isAlive === "function") {
    try { return !!(await hooks.process.isAlive(record.pid, record, config)); } catch (_) { throw recoveryError("PROCESS_QUERY_FAILED", "could not verify recovery lock owner"); }
  }
  const records = await listProcesses(config, hooks);
  return records.some(item => item.pid === record.pid);
}

async function acquireLock(config, hooks) {
  hooks = normalizeHooks(hooks);
  const filename = lockPath(config);
  const body = JSON.stringify({ schema: 1, pid: hooks.currentPid, app: config.app, createdAt: new Date(hooks.clock.now()).toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = hooks.fs.openSync(filename, "wx", 0o600);
      try { hooks.fs.writeFileSync(fd, body, "utf8"); hooks.fs.fsyncSync?.(fd); } finally { hooks.fs.closeSync(fd); }
      return { acquired: true, filename, token: body };
    } catch (error) {
      if (error.code !== "EEXIST") throw recoveryError("LOCK_FAILED", "could not create recovery lock");
      let existingBytes;
      try { existingBytes = hooks.fs.readFileSync(filename, "utf8"); } catch (_) { continue; }
      let existing;
      try { existing = JSON.parse(existingBytes); } catch (_) { return { acquired: false, busy: true, reason: "invalid-lock" }; }
      if (!isObject(existing) || !Number.isInteger(existing.pid) || existing.pid <= 0 || typeof existing.app !== "string" || !path.isAbsolute(existing.app)) {
        return { acquired: false, busy: true, reason: "invalid-lock" };
      }
      if (!pathEqual(existing.app, config.app, hooks.platform)) return { acquired: false, busy: true, reason: "app-mismatch" };
      if (await holderAlive(existing, config, hooks)) return { acquired: false, busy: true, reason: "active-lock", holder: existing };
      let current;
      try { current = hooks.fs.readFileSync(filename, "utf8"); } catch (_) { continue; }
      if (current !== existingBytes) continue;
      try { hooks.fs.unlinkSync(filename); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") return { acquired: false, busy: true, reason: "lock-race" }; }
    }
  }
  return { acquired: false, busy: true, reason: "lock-race" };
}

function releaseLock(lock, config, hooks) {
  hooks = normalizeHooks(hooks);
  if (!lock?.acquired) return;
  try {
    const current = hooks.fs.readFileSync(lock.filename, "utf8");
    const parsed = JSON.parse(current);
    if (parsed.pid === hooks.currentPid && pathEqual(parsed.app, config.app, hooks.platform)) removeFile(lock.filename, hooks.fs);
  } catch (_) {}
}

function resolveExecutable(config, records, fsa = fs, platform = process.platform) {
  if (config.executable) return config.executable;
  const existing = records.find(record => isOpenCodeRecord(record, config, platform) && record.path && pathInside(config.app, record.path, platform));
  if (existing?.path) return existing.path;
  for (const name of ["OpenCode.exe", "opencode.exe", "OpenCode", "opencode"]) {
    const candidate = path.join(config.app, name);
    try { statRegular(candidate, fsa, candidate); return candidate; } catch (_) {}
  }
  throw recoveryError("APP_EXECUTABLE_MISSING", "OpenCode executable is missing from the configured app directory");
}

async function launchApp(config, args, records, hooks, context = {}) {
  const executable = resolveExecutable(config, records || [], hooks.fs, hooks.platform);
  const launchArgs = Array.isArray(args) ? [...args] : [];
  const options = { detached: true, stdio: "ignore", windowsHide: false };
  if (typeof hooks.launch === "function") return await hooks.launch(executable, launchArgs, options, { ...context, config });
  const spawn = hooks.process.spawn || childProcess.spawn;
  const child = spawn(executable, launchArgs, options);
  child?.unref?.();
  return { state: "launched", executable, args: launchArgs };
}

function snapshotSignature(filename, fsa = fs) {
  try { const stat = fsa.statSync(filename); return [stat.size, Number(stat.mtimeMs), Number(stat.ctimeMs)].join(":"); }
  catch (_) { return null; }
}

function sourceFiles(config, fsa = fs) {
  const map = feature.FILES || {};
  return Object.entries(map).map(([name, sourceName]) => ({ name, filename: path.join(config.sourceRoot, sourceName), target: path.join(config.runtime, name), data: fsa.readFileSync(path.join(config.sourceRoot, sourceName)) }));
}

function restoreRuntimeSnapshot(snapshot, hooks) {
  for (const item of snapshot) {
    try {
      if (item.exists) { atomicWrite(item.entry.target, item.data, hooks.fs); try { hooks.fs.chmodSync(item.entry.target, item.mode); } catch (_) {} }
      else removeFile(item.entry.target, hooks.fs);
    } catch (_) {}
  }
}

function runtimeRepair(config, hooks, expectedArchiveHash = null, options = {}) {
  options.checkCancelled?.();
  const entries = sourceFiles(config, hooks.fs);
  if (expectedArchiveHash && hashFile(config.targetAsar, hooks.fs) !== expectedArchiveHash) throw recoveryError("SOURCE_CHANGED", "app.asar changed before runtime repair");
  const before = entries.map(entry => {
    if (!hooks.fs.existsSync(entry.target)) return { entry, exists: false };
    const stat = statRegular(entry.target, hooks.fs, "runtime/" + entry.name);
    return { entry, exists: true, data: hooks.fs.readFileSync(entry.target), mode: stat.mode & 0o777 };
  });
  try {
    for (const item of entries) {
      options.checkCancelled?.();
      atomicWrite(item.target, item.data, hooks.fs);
      try { hooks.fs.chmodSync(item.target, 0o600); } catch (_) {}
    }
  } catch (error) {
    restoreRuntimeSnapshot(before, hooks);
    throw error;
  }
  if (expectedArchiveHash && hashFile(config.targetAsar, hooks.fs) !== expectedArchiveHash) {
    restoreRuntimeSnapshot(before, hooks);
    throw recoveryError("SOURCE_CHANGED", "app.asar changed during runtime repair");
  }
  return { state: "runtime-repaired", files: entries.map(item => item.name) };
}

async function ensureNoActiveApp(config, hooks) {
  const records = await listProcesses(config, hooks);
  const active = appRecords(records, config, hooks);
  if (active.length) throw recoveryError("APP_RUNNING", "OpenCode is still running; close it before voice recovery");
  return records;
}

async function generateAndApply(config, hooks, options = {}) {
  options.checkCancelled?.();
  validateSourceFiles(config.packageRoot, config.manifest, hooks.fs);
  await ensureNoActiveApp(config, hooks);
  options.checkCancelled?.();
  const before = hashFile(config.targetAsar, hooks.fs);
  const input = hooks.fs.readFileSync(config.targetAsar);
  let patchResult;
  try {
    options.checkCancelled?.();
    patchResult = await hooks.patch(input, {
      platform: "windows", bridgeSource: hooks.fs.readFileSync(path.join(config.sourceRoot, "desktop-bridge.cjs"), "utf8"),
      micSource: hooks.fs.readFileSync(path.join(config.sourceRoot, "oc-mic.js"), "utf8"), expectedSourceHash: before,
    });
    options.checkCancelled?.();
  } catch (error) {
    if (error?.code === "REQUEST_CANCELLED") throw error;
    throw recoveryError("PATCH_FAILED", error.message || String(error));
  }
  const candidate = Buffer.isBuffer(patchResult) ? patchResult : patchResult?.buffer;
  if (!Buffer.isBuffer(candidate)) throw recoveryError("PATCH_FAILED", "patcher did not return a candidate archive");
  const afterGeneration = hashFile(config.targetAsar, hooks.fs);
  if (afterGeneration !== before) throw recoveryError("SOURCE_CHANGED", "app.asar changed while generating the recovery candidate");
  let candidateMeta;
  try { candidateMeta = patcher.inspectAsarBuffer(candidate); } catch (error) { throw recoveryError("CANDIDATE_INVALID", error.message || String(error)); }
  const currentMeta = patcher.inspectAsarBuffer(input);
  if (candidateMeta.version !== currentMeta.version) throw recoveryError("CANDIDATE_VERSION", "candidate app version differs from the installed archive");
  if (options.expectedVersion && candidateMeta.version !== options.expectedVersion) throw recoveryError("UPDATE_VERSION", "updated app version does not match the requested version");
  const candidateHash = sha256(candidate);
  if (candidateHash === before) {
    const currentHealth = health(config, hooks);
    if (currentHealth.complete) return { state: "already-applied", sourceAsarSha256: before, candidateAsarSha256: candidateHash, health: currentHealth };
    options.checkCancelled?.();
    const repaired = runtimeRepair(config, hooks, before, options);
    const finalHealth = health(config, hooks);
    if (!finalHealth.complete) throw recoveryError("RUNTIME_INVALID", "feature runtime remains incomplete after repair");
    return { ...repaired, sourceAsarSha256: before, candidateAsarSha256: candidateHash, health: finalHealth };
  }
  const candidateDir = path.join(config.maintenanceRoot, "recovery-candidates");
  try {
    if (hooks.fs.existsSync(candidateDir)) statDirectory(candidateDir, hooks.fs, "recovery-candidates");
    else hooks.fs.mkdirSync(candidateDir, { recursive: false });
    if (!pathInside(canonicalPath(config.maintenanceRoot, hooks.fs), canonicalPath(candidateDir, hooks.fs), hooks.platform)) throw recoveryError("CONFIG_INVALID", "recovery-candidates must be inside maintenanceRoot");
  } catch (error) {
    if (error?.code === "CONFIG_INVALID") throw error;
    throw recoveryError("CANDIDATE_WRITE_FAILED", "could not create the recovery candidate directory");
  }
  const candidateFile = path.join(candidateDir, "candidate-" + hooks.currentPid + "-" + crypto.randomBytes(6).toString("hex") + ".asar");
  options.checkCancelled?.();
  atomicWrite(candidateFile, candidate, hooks.fs);
  try {
    const beforeCommit = hashFile(config.targetAsar, hooks.fs);
    if (beforeCommit !== before) throw recoveryError("SOURCE_CHANGED", "app.asar changed before recovery commit");
    options.checkCancelled?.();
    let result;
    try {
      result = await hooks.apply({
        platform: "windows", app: config.app, input: config.targetAsar, patched: candidateFile, source: config.sourceRoot,
        home: config.home, runtime: config.runtime,
        backupRoot: config.backupRoot, python: config.python, expectedSourceHash: before,
      }, hooks.applyOptions || {});
    } catch (error) {
      if (error?.code === "REQUEST_CANCELLED") throw error;
      throw recoveryError("APPLY_FAILED", error.message || String(error));
    }
    const finalHash = hashFile(config.targetAsar, hooks.fs);
    if (finalHash !== candidateHash) throw recoveryError("APPLY_VERIFY_FAILED", "applied archive hash does not match the verified candidate");
    const finalHealth = health(config, hooks);
    if (!finalHealth.complete) throw recoveryError("APPLY_VERIFY_FAILED", "applied package failed entry/runtime verification");
    return { ...(result || {}), state: result?.state || "applied", sourceAsarSha256: before, candidateAsarSha256: candidateHash, health: finalHealth };
  } finally {
    try { hooks.fs.unlinkSync(candidateFile); } catch (_) {}
    try { if (hooks.fs.readdirSync(candidateDir).length === 0) hooks.fs.rmdirSync(candidateDir); } catch (_) {}
  }
}

function validateRequest(request, config, requestPath, fsa = fs, platform = process.platform) {
  if (!isObject(request) || request.schema !== SCHEMA || typeof request.id !== "string" || !UUID.test(request.id)) throw recoveryError("REQUEST_INVALID", "update request schema or id is invalid");
  if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw recoveryError("REQUEST_INVALID", "update request createdAt is invalid");
  if (!Number.isInteger(request.parentPid) || request.parentPid <= 0) throw recoveryError("REQUEST_INVALID", "update request parentPid is invalid");
  if (!HEX64.test(request.currentAsarSha256 || "") || typeof request.expectedVersion !== "string" || !SEMVER.test(request.expectedVersion)) throw recoveryError("REQUEST_INVALID", "update request hash or version is invalid");
  for (const field of ["app", "installerPath", "configPath"]) request[field] = requireAbsolute(request[field], "request." + field);
  if (!pathEqual(request.app, config.app, platform) || !pathEqual(request.configPath, config.configPath, platform)) throw recoveryError("REQUEST_INVALID", "update request target does not match active.json");
  const directory = path.dirname(requestPath);
  if (!pathEqual(path.basename(directory), request.id, platform) && path.basename(requestPath) === "request.json") {
    throw recoveryError("REQUEST_INVALID", "update request directory does not match id");
  }
  request.requestPath = requestPath; request.requestDirectory = directory;
  return request;
}

function requestMarker(request, name) { return path.join(request.requestDirectory, name + ".json"); }

function readOptionalJson(filename, fsa) { return fsa.existsSync(filename) ? readJson(filename, fsa, path.basename(filename)) : null; }

function cancellationMarker(request, hooks) {
  const marker = readOptionalJson(requestMarker(request, "cancel"), hooks.fs);
  if (marker && marker.id !== undefined && marker.id !== request.id) {
    throw recoveryError("REQUEST_INVALID", "cancel.json belongs to another request");
  }
  return marker;
}

function assertUpdateNotCancelled(request, hooks) {
  const marker = cancellationMarker(request, hooks);
  if (marker) {
    const error = recoveryError("REQUEST_CANCELLED", "update request was cancelled");
    error.cancelMarker = marker;
    throw error;
  }
}

function validateInstallerPids(value, platform = process.platform, expectedId = null) {
  if (!isObject(value) || !Array.isArray(value.pids) || value.pids.length === 0) return null;
  if (value.schema !== undefined && value.schema !== SCHEMA) throw recoveryError("REQUEST_INVALID", "installer-pids.json schema is invalid");
  if (expectedId && value.id !== undefined && value.id !== expectedId) throw recoveryError("REQUEST_INVALID", "installer-pids.json belongs to another request");
  const pids = value.pids.map(item => {
    if (!isObject(item) || !Number.isInteger(item.pid) || item.pid <= 0 || typeof item.path !== "string" || !path.isAbsolute(item.path) || typeof item.startedAt !== "string" || Number.isNaN(Date.parse(item.startedAt))) throw recoveryError("REQUEST_INVALID", "installer-pids.json contains an invalid pid record");
    return { pid: item.pid, path: path.resolve(item.path), startedAt: item.startedAt };
  });
  const unique = new Set(pids.map(item => item.pid));
  if (unique.size !== pids.length) throw recoveryError("REQUEST_INVALID", "installer-pids.json contains duplicate pids");
  return pids;
}

function descendants(records, roots, helperPid) {
  const tracked = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) if (record.pid !== helperPid && tracked.has(record.parent) && !tracked.has(record.pid)) { tracked.add(record.pid); changed = true; }
  }
  return tracked;
}

function sameExecutable(left, right, platform) { return pathEqual(left, right, platform); }

function identityConflict(previous, record, platform) {
  if (!previous) return false;
  if ((previous.creation || record.creation) && previous.creation !== record.creation) return true;
  if (previous.path && record.path && !sameExecutable(previous.path, record.path, platform)) return true;
  if (previous.name && record.name && previous.name.toLowerCase() !== record.name.toLowerCase()) return true;
  return false;
}

function processTracker(request, config, hooks) {
  const tracker = { roots: new Map(), known: new Map(), blocked: new Set() };
  const addRoot = (kind, pid, expectedPath = "") => {
    const key = kind + ":" + pid;
    if (tracker.roots.has(key)) return;
    tracker.roots.set(key, { kind, pid, expectedPath });
    // Keep the root as a seed even while the process query is between two
    // snapshots. This is what lets a surviving child remain observable after
    // its installer parent has already exited.
    tracker.known.set(pid, { kind, pid, parent: 0, path: "", creation: null, name: "", observed: false });
  };
  addRoot("app", request.parentPid, config.app);
  tracker.addRoot = addRoot;
  return tracker;
}

function rootMatches(root, record, config, hooks) {
  if (root.kind === "installer") return !!record.path && (!root.expectedPath || sameExecutable(root.expectedPath, record.path, hooks.platform));
  if (record.path) return pathLooksInside(config.app, record.path, hooks.platform);
  return /^opencode(?:\.exe)?$/i.test(record.name);
}

function observeProcessState(tracker, records, installerPids, config, hooks) {
  const clean = records.filter(record => record.pid !== hooks.helperPid);
  for (const item of installerPids) tracker.addRoot("installer", item.pid, item.path);
  for (const record of appRecords(clean, config, hooks)) tracker.addRoot("app", record.pid, config.app);
  const active = new Set();
  const current = new Map(clean.map(record => [record.pid, record]));
  for (const root of tracker.roots.values()) {
    const record = current.get(root.pid);
    if (!record) continue;
    const previous = tracker.known.get(record.pid);
    const key = root.kind + ":" + root.pid;
    if (!rootMatches(root, record, config, hooks) || previous?.observed && identityConflict(previous, record, hooks.platform)) {
      // A reused PID must keep the update gate closed.  Dropping it from the
      // active set would allow an unrelated process to race archive writes.
      tracker.blocked.add(key);
      active.add(record.pid);
      continue;
    }
    tracker.known.set(record.pid, { ...previous, kind: root.kind, pid: record.pid, parent: record.parent, path: record.path, creation: record.creation, name: record.name });
    tracker.known.get(record.pid).observed = true;
    active.add(record.pid);
  }
  // Iterate to a fixed point so a grandchild observed in the same query is
  // tracked even when its direct parent was also first seen this round.
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of clean) {
      if (active.has(record.pid)) continue;
      const parentAppKey = "app:" + record.parent;
      const parentInstallerKey = "installer:" + record.parent;
      if (tracker.blocked.has(parentAppKey) || tracker.blocked.has(parentInstallerKey)) {
        // The parent PID was reused or had an untrusted identity.  Keep a
        // surviving child in the gate until it is gone; never treat it as an
        // untracked process merely because its root disappeared.
        active.add(record.pid);
        continue;
      }
      const parent = tracker.known.get(record.parent);
      if (!parent) continue;
      const previous = tracker.known.get(record.pid);
      const kind = parent.kind;
      const key = kind + ":" + record.pid;
      if (tracker.blocked.has(key) || previous?.observed && identityConflict(previous, record, hooks.platform)) {
        tracker.blocked.add(key);
        active.add(record.pid);
        continue;
      }
      tracker.known.set(record.pid, { ...previous, kind, pid: record.pid, parent: record.parent, path: record.path, creation: record.creation, name: record.name, observed: true });
      active.add(record.pid); changed = true;
    }
  }
  return !clean.some(record => active.has(record.pid));
}

async function waitForUpdate(config, request, hooks, options = {}) {
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : UPDATE_TIMEOUT_MS;
  const start = Number(hooks.clock.now());
  let lastSignature = null, stableSince = null;
  const tracker = processTracker(request, config, hooks);
  for (;;) {
    const cancel = cancellationMarker(request, hooks);
    if (cancel) return { state: "cancelled", marker: cancel };
    const commit = readOptionalJson(requestMarker(request, "commit"), hooks.fs);
    if (commit && (commit.id !== undefined && commit.id !== request.id || commit.schema !== undefined && commit.schema !== SCHEMA)) throw recoveryError("REQUEST_INVALID", "commit.json belongs to another request");
    const pidFile = readOptionalJson(requestMarker(request, "installer-pids"), hooks.fs);
    let installerPids = null;
    if (pidFile) installerPids = validateInstallerPids(pidFile, hooks.platform, request.id);
    if (commit && installerPids) {
      const records = await listProcesses(config, hooks);
      if (observeProcessState(tracker, records, installerPids, config, hooks)) {
        const signature = snapshotSignature(config.targetAsar, hooks.fs);
        const now = Number(hooks.clock.now());
        if (signature && signature === lastSignature) {
          if (stableSince == null) stableSince = now;
          if (now - stableSince >= STABLE_MS) return { state: "ready", commit, installerPids, records, signature };
        } else { lastSignature = signature; stableSince = signature ? now : null; }
      } else { lastSignature = null; stableSince = null; }
    }
    if (Number(hooks.clock.now()) - start >= timeout) return { state: "timeout" };
    await hooks.clock.sleep(Math.min(POLL_MS, Math.max(1, timeout)));
  }
}

function writeRequestMarker(request, name, body, hooks) {
  atomicWrite(requestMarker(request, name), Buffer.from(JSON.stringify(body, null, 2) + "\n", "utf8"), hooks.fs);
}

async function rebindShortcuts(config, hooks) {
  if (typeof hooks.rebind === "function") return await hooks.rebind(config);
  const script = path.join(config.packageRoot, "windows", "maintenance-shortcuts.ps1");
  statRegular(script, hooks.fs, "maintenance-shortcuts.ps1");
  const spawnSync = hooks.process.spawnSync || childProcess.spawnSync;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "Rebind", "-ConfigPath", config.configPath], { windowsHide: true, stdio: "ignore", timeout: 30000, env: powershellEnvironment(hooks) });
  if (result.error || result.status !== 0) throw recoveryError("REBIND_FAILED", "Windows shortcut rebind failed");
  return { state: "rebound" };
}

const SAFE_OFFICIAL_FALLBACK_CODES = new Set([
  "PATCH_FAILED", "CANDIDATE_INVALID", "CANDIDATE_VERSION", "RUNTIME_INVALID",
  "CANDIDATE_WRITE_FAILED", "APPLY_FAILED", "APPLY_VERIFY_FAILED", "SOURCE_ALLOWLIST", "SOURCE_FILE_CHANGED", "SOURCE_MANIFEST_CHANGED", "UPDATE_VERSION",
]);

async function launchOfficialFallback(config, args, hooks, baselineHash, expectedVersion, error, options = {}) {
  options.checkCancelled?.();
  if (!baselineHash || !SAFE_OFFICIAL_FALLBACK_CODES.has(error?.code)) return null;
  let currentHash;
  try { currentHash = hashFile(config.targetAsar, hooks.fs); } catch (_) { return null; }
  if (currentHash !== baselineHash) return null;
  let inspected;
  try { inspected = support.inspectAsarFile(config.targetAsar); } catch (_) { return null; }
  if (expectedVersion && inspected.version !== expectedVersion) return null;
  let records;
  try { records = await listProcesses(config, hooks); } catch (_) { return null; }
  if (appRecords(records, config, hooks).length) return null;
  options.checkCancelled?.();
  const launch = await launchApp(config, args, records, hooks, { officialFallback: true, recoveryError: error.code });
  await notify(config, "本地语音暂不可用，已启动官方 OpenCode。", error.message || String(error), hooks);
  error.userNotified = true;
  return { state: "launched-official", launch, recoveryError: error.code };
}

async function runLaunch(config, args, hooks) {
  const lock = await acquireLock(config, hooks);
  if (!lock.acquired) { await notify(config, "语音恢复正在进行，请稍后重试。", "launch blocked by recovery lock", hooks); return { state: "busy" }; }
  let baselineHash = null;
  try {
    baselineHash = hashFile(config.targetAsar, hooks.fs);
    validateSourceFiles(config.packageRoot, config.manifest, hooks.fs);
    let records = await listProcesses(config, hooks);
    const active = appRecords(records, config, hooks);
    const currentHealth = health(config, hooks);
    if (active.length) {
      if (!currentHealth.complete) {
        await notify(config, "请先退出 OpenCode，完成语音恢复后再启动。", "OpenCode is running with an incomplete voice entry", hooks);
        return { state: "app-running-incomplete" };
      }
      return await launchApp(config, args, active, hooks, { forwarded: true });
    }
    if (!currentHealth.complete) {
      await generateAndApply(config, hooks);
      records = await listProcesses(config, hooks);
      if (appRecords(records, config, hooks).length) {
        await notify(config, "请先退出 OpenCode，完成语音恢复后再启动。", "OpenCode started during recovery", hooks);
        return { state: "app-started-during-recovery" };
      }
    }
    return await launchApp(config, args, records, hooks);
  } catch (error) {
    try {
      const fallback = await launchOfficialFallback(config, args, hooks, baselineHash, null, error);
      if (fallback) return fallback;
    } catch (_) {}
    await notify(config, "本地语音暂不可用，请查看恢复日志。", error.message || String(error), hooks);
    error.userNotified = true;
    throw error;
  } finally { releaseLock(lock, config, hooks); }
}

async function runUpdate(config, requestPath, args, hooks, options = {}) {
  const requestFile = requireAbsolute(requestPath, "request");
  statRegular(requestFile, hooks.fs, "request.json");
  const requestDirectory = path.dirname(requestFile);
  if (!pathInside(canonicalPath(config.maintenanceRoot, hooks.fs), canonicalPath(requestDirectory, hooks.fs), hooks.platform)) {
    throw recoveryError("REQUEST_INVALID", "update request must be inside maintenanceRoot");
  }
  const request = validateRequest(readJson(requestFile, hooks.fs, "request.json"), config, requestFile, hooks.fs, hooks.platform);
  const lock = await acquireLock(config, hooks);
  if (!lock.acquired) {
    try { writeRequestMarker(request, "error", { state: "error", id: request.id, ownerPid: hooks.currentPid, message: "maintenance recovery failed; see recovery.log" }, hooks); } catch (_) {}
    await notify(config, "语音恢复正在进行，请稍后重试。", "update blocked by recovery lock", hooks);
    return { state: "busy" };
  }
  let officialHash = null;
  try {
    // A cancellation can race lock acquisition.  Check it after the lock is
    // held as well as before it, so a late helper can never repair/start the
    // app after the bridge has cancelled the request.
    if (cancellationMarker(request, hooks)) return { state: "cancelled", late: true };
    const existingError = readOptionalJson(requestMarker(request, "error"), hooks.fs);
    if (existingError) return { state: "failed", error: existingError };
    const readyFile = requestMarker(request, "ready");
    const existingReady = readOptionalJson(readyFile, hooks.fs);
    if (existingReady && (existingReady.state !== "ready" || existingReady.id !== request.id)) {
      throw recoveryError("REQUEST_INVALID", "ready.json belongs to another request");
    }
    if (!existingReady || existingReady.ownerPid !== hooks.currentPid) {
      assertUpdateNotCancelled(request, hooks);
      writeRequestMarker(request, "ready", { state: "ready", id: request.id, ownerPid: hooks.currentPid }, hooks);
    }
    const waited = await waitForUpdate(config, request, hooks, options);
    if (waited.state === "timeout") {
      writeRequestMarker(request, "cancel", { schema: 1, id: request.id, state: "timeout", at: new Date(hooks.clock.now()).toISOString() }, hooks);
      await notify(config, "更新等待超时，语音暂不可用。", "update request timed out without a complete installer process", hooks);
      return { state: "timeout" };
    }
    if (waited.state === "cancelled") {
      const unchanged = hashFile(config.targetAsar, hooks.fs) === request.currentAsarSha256;
      await notify(config, unchanged ? "更新已取消，已保留原版语音入口。" : "更新已取消，官方 OpenCode 包已保留。", "update request cancelled", hooks);
      return { state: "cancelled", unchanged };
    }
    assertUpdateNotCancelled(request, hooks);
    const currentHash = hashFile(config.targetAsar, hooks.fs);
    if (currentHash === request.currentAsarSha256) {
      assertUpdateNotCancelled(request, hooks);
      await notify(config, "更新未替换 OpenCode，已保留原版语音入口。", "installer completed without changing the target archive", hooks);
      const records = await listProcesses(config, hooks);
      assertUpdateNotCancelled(request, hooks);
      if (!appRecords(records, config, hooks).length && health(config, hooks).complete) return await launchApp(config, args, records, hooks, { unchanged: true });
      return { state: "unchanged" };
    }
    officialHash = currentHash;
    let inspected;
    try { inspected = support.inspectAsarFile(config.targetAsar); } catch (error) { throw recoveryError("UPDATED_ARCHIVE_INVALID", error.message || String(error)); }
    if (inspected.version !== request.expectedVersion) throw recoveryError("UPDATE_VERSION", "updated app version does not match the request");
    validateSourceFiles(config.packageRoot, config.manifest, hooks.fs);
    const result = await generateAndApply(config, hooks, {
      expectedVersion: request.expectedVersion,
      checkCancelled: () => assertUpdateNotCancelled(request, hooks),
    });
    assertUpdateNotCancelled(request, hooks);
    try { await rebindShortcuts(config, hooks); }
    catch (error) {
      assertUpdateNotCancelled(request, hooks);
      await notify(config, "OpenCode 已更新，但语音快捷方式需要重新维护。", error.message || String(error), hooks);
      return { ...result, state: "rebind-failed", rebindError: error.message };
    }
    assertUpdateNotCancelled(request, hooks);
    const records = await listProcesses(config, hooks);
    if (appRecords(records, config, hooks).length) {
      await notify(config, "OpenCode 已更新，请稍后重新启动以使用语音。", "OpenCode appeared after update recovery", hooks);
      return { ...result, state: "updated-app-running" };
    }
    assertUpdateNotCancelled(request, hooks);
    return { ...result, state: result.state === "already-applied" ? result.state : "updated", launch: await launchApp(config, args, records, hooks, { updated: true }) };
  } catch (error) {
    if (error?.code === "REQUEST_CANCELLED") return { state: "cancelled", late: true };
    try { if (cancellationMarker(request, hooks)) return { state: "cancelled", late: true }; } catch (_) {}
    // `error.json` is the preparation/repair failure handshake.  Keep the
    // request directory inspectable and ensure a failed prepare is never
    // mistaken for a successful ready state by the bridge.
    try {
      if (!cancellationMarker(request, hooks)) {
        removeFile(requestMarker(request, "ready"), hooks.fs);
        if (!cancellationMarker(request, hooks)) writeRequestMarker(request, "error", { state: "error", id: request.id, ownerPid: hooks.currentPid, message: "maintenance recovery failed; see recovery.log" }, hooks);
      }
    } catch (_) {}
    try {
      const fallback = await launchOfficialFallback(config, args, hooks, typeof officialHash === "string" ? officialHash : null, null, error, {
        checkCancelled: () => assertUpdateNotCancelled(request, hooks),
      });
      if (fallback) return fallback;
    } catch (fallbackError) {
      if (fallbackError?.code === "REQUEST_CANCELLED") return { state: "cancelled", late: true };
    }
    await notify(config, "更新后的本地语音暂不可用，官方 OpenCode 包已保留。", error.message || String(error), hooks);
    error.userNotified = true;
    throw error;
  } finally { releaseLock(lock, config, hooks); }
}

async function runCheck(config, hooks) {
  validateSourceFiles(config.packageRoot, config.manifest, hooks.fs);
  const result = health(config, hooks);
  return { state: result.complete ? "ready" : "incomplete", configPath: config.configPath, targetAsar: config.targetAsar, packageRoot: config.packageRoot, archive: { version: result.archive.version || null, hash: result.archive.hash || null }, runtime: result.runtime, complete: result.complete };
}

async function run(input, hooksInput = {}) {
  const rawInput = typeof input === "string" ? { configPath: input } : (input || {});
  const hooks = normalizeHooks(hooksInput);
  const mode = rawInput.mode || "launch";
  const config = rawInput.config && isObject(rawInput.config) && rawInput.config.targetAsar ? rawInput.config : loadConfig(rawInput.configPath || rawInput.config, hooks);
  if (mode === "check") return runCheck(config, hooks);
  if (mode === "launch") return runLaunch(config, rawInput.args || [], hooks);
  if (mode === "update") {
    if (!rawInput.request) throw recoveryError("REQUEST_REQUIRED", "update mode requires --request");
    return runUpdate(config, rawInput.request, rawInput.args || [], hooks, rawInput);
  }
  throw recoveryError("CLI_INVALID", "mode must be launch, update, or check");
}

function parseCli(argv) {
  const args = { args: [] };
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (passthrough) { args.args.push(value); continue; }
    if (value === "--") { passthrough = true; continue; }
    if (!["--config", "--mode", "--request"].includes(value)) throw recoveryError("CLI_INVALID", "invalid recovery argument");
    const next = argv[++index];
    if (!next || next.startsWith("--")) throw recoveryError("CLI_INVALID", value + " requires a value");
    args[value.slice(2)] = next;
  }
  if (!args.config || !args.mode) throw recoveryError("CLI_INVALID", "--config and --mode are required");
  if (!["launch", "update", "check"].includes(args.mode)) throw recoveryError("CLI_INVALID", "invalid recovery mode");
  if (args.mode === "update" && !args.request) throw recoveryError("REQUEST_REQUIRED", "update mode requires --request");
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  const result = await run(parsed);
  if (parsed.mode === "check") process.stdout.write(JSON.stringify(result) + "\n");
  return result;
}

if (require.main === module) {
  main().catch(error => { process.exitCode = error?.userNotified ? 2 : 1; });
}

module.exports = {
  SCHEMA, FEATURE_VERSION, UPDATE_TIMEOUT_MS, STABLE_MS, POLL_MS,
  parseManifest, validateSourceFiles, validateActiveConfig, loadConfig,
  normalizeRecord, parseProcessOutput, listProcesses, archiveHealth, runtimeHealth, health,
  acquireLock, releaseLock, lockPath, waitForUpdate, processTracker, observeProcessState, validateRequest, generateAndApply,
  runtimeRepair, rebindShortcuts, runLaunch, runUpdate, runCheck, run, parseCli, main,
  validateConfig: validateActiveConfig, readActiveConfig: loadConfig, runRecovery: run,
  launch: runLaunch, update: runUpdate, check: runCheck,
  hashFile, sha256, pathInside, pathEqual,
};
