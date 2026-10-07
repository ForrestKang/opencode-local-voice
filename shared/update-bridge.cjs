"use strict";

// The update bridge is deliberately small and dependency-free.  It runs from
// the patched OpenCode main process, while update-recovery.cjs lives in the
// versioned package outside app.asar.  All state is written to the maintenance
// directory so replacing app.asar cannot remove the hand-off record.
// Electron's fs views app.asar as a virtual directory. Validation and hashing
// here must inspect the physical archive; standalone Node helpers use normal fs.
const nodeFs = process.versions.electron ? require("original-fs") : require("node:fs");
const nodePath = require("node:path");
const nodeCrypto = require("node:crypto");
const childProcess = require("node:child_process");

const SCHEMA = 1;
const READY_TIMEOUT_MS = 5000;
const READY_POLL_MS = 25;
let currentSession = null;

function fail(message) { throw new Error("update recovery: " + message); }
function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label + " must be an object");
  return value;
}
function absolute(value, label) {
  if (typeof value !== "string" || !value || !nodePath.isAbsolute(value)) fail(label + " must be an absolute path");
  return nodePath.normalize(value);
}
function samePath(left, right) {
  const a = nodePath.normalize(left), b = nodePath.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function sha256(bytes) { return nodeCrypto.createHash("sha256").update(bytes).digest("hex"); }
function isHash(value) { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
function regular(fsImpl, file) {
  try {
    const stat = (typeof fsImpl.lstatSync === "function" ? fsImpl.lstatSync(file) : fsImpl.statSync(file));
    return !!stat.isFile() && !(typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink());
  } catch (_) { return false; }
}
function directory(fsImpl, file) {
  try { return !!fsImpl.statSync(file).isDirectory(); } catch (_) { return false; }
}
function writeJson(fsImpl, file, value) {
  const directoryName = nodePath.dirname(file);
  if (typeof fsImpl.mkdirSync === "function") fsImpl.mkdirSync(directoryName, { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  const temporary = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  if (typeof fsImpl.writeFileSync !== "function") fail("filesystem injection must provide writeFileSync");
  fsImpl.writeFileSync(temporary, text, "utf8");
  if (typeof fsImpl.renameSync === "function") fsImpl.renameSync(temporary, file);
  else fsImpl.writeFileSync(file, text, "utf8");
}
function readJson(fsImpl, file) {
  const text = String(fsImpl.readFileSync(file, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(String(text));
}
function configPathFor(electron, options) {
  if (options.configPath) return absolute(options.configPath, "maintenance config path");
  if (options.activePath) return absolute(options.activePath, "maintenance config path");
  if (!electron || !electron.app || typeof electron.app.getPath !== "function") fail("electron.app.getPath is unavailable");
  const home = absolute(electron.app.getPath("home"), "electron home");
  return nodePath.join(home, ".config", "opencode", "voice-maintenance", "active.json");
}
function dialogError(electron, message, options) {
  const dialog = options && options.dialog;
  const target = dialog || electron && electron.dialog;
  let reason = "语音插件的更新准备未完成，请查看应用日志中的更新诊断信息。";
  if (/current app\.asar is missing|application directory is missing|OpenCode\.exe is missing/.test(message)) reason = "未找到当前 OpenCode 的应用文件，请通过语音维护启动器重新打开 OpenCode 后重试。";
  else if (/manifest|stable package|featureVersion|schema/.test(message)) reason = "语音插件的安装记录或文件校验未通过，请使用当前版本的安装包修复后重试。";
  else if (/installer.*(?:missing|unavailable)/.test(message)) reason = "未找到已下载的更新安装包，请重新检查并下载更新后重试。";
  else if (/administrator elevation/.test(message)) reason = "本次更新需要管理员权限，当前自动恢复流程无法安全接管，请保留当前应用并使用安装包手动更新。";
  else if (/ready\.json|maintenance helper|node is missing|pythonw? is missing/.test(message)) reason = "语音维护程序未能就绪，请通过语音维护启动器重新打开 OpenCode 后重试。";
  else if (/already active/.test(message)) reason = "已有一次更新准备正在进行，请等待该次准备完成后重试。";
  const title = "OpenCode 更新准备失败";
  const text = "本次更新尚未开始，OpenCode 可以继续使用。\n\n" + reason;
  try {
    if (target && typeof target.showErrorBox === "function") target.showErrorBox(title, text);
    else if (target && typeof target.showMessageBoxSync === "function") target.showMessageBoxSync({ type: "error", title, message: text });
    else return false;
    return true;
  } catch (_) { /* An error dialog must never replace the original failure. */ }
  return false;
}
function now(options) {
  const clock = options && options.clock;
  if (typeof clock === "function") return new Date(clock()).toISOString();
  if (clock && typeof clock.now === "function") return new Date(clock.now()).toISOString();
  return new Date().toISOString();
}
function milliseconds(options) {
  const clock = options && options.clock;
  if (clock && typeof clock.now === "function") return Number(clock.now());
  if (typeof clock === "function") return Number(clock());
  return Date.now();
}
async function wait(options, duration) {
  const clock = options && options.clock;
  if (clock && typeof clock.sleep === "function") return clock.sleep(duration);
  if (clock && typeof clock.advance === "function") { clock.advance(duration); return; }
  if (typeof options.sleep === "function") return options.sleep(duration);
  return new Promise(resolve => setTimeout(resolve, duration));
}
function randomId(options) {
  if (typeof options.id === "string" && options.id) return options.id;
  if (typeof options.uuid === "function") return String(options.uuid());
  return nodeCrypto.randomUUID();
}
function normalVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  // Electron updateInfo versions are semver.  Permit prerelease/build labels,
  // but do not silently accept a path, empty value, or arbitrary text.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) fail("expected version is not valid semver");
  return version;
}
function inside(root, value) {
  const relative = nodePath.relative(root, value);
  return relative === "" || (!relative.startsWith(".." + nodePath.sep) && relative !== ".." && !nodePath.isAbsolute(relative));
}
function findAsar(fsImpl, app) {
  const candidates = [
    nodePath.join(app, "resources", "app.asar"),
    nodePath.join(app, "app.asar"),
    nodePath.join(app, "Contents", "Resources", "app.asar"),
  ];
  return candidates.find(file => regular(fsImpl, file)) || null;
}
function verifyManifestEntries(fsImpl, packageRoot, manifestBytes) {
  const entries = new Map();
  for (const raw of String(manifestBytes).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+(?:\*)?(.+)$/.exec(line);
    if (!match) fail("stable package manifest is malformed");
    const relative = match[2].trim().replace(/\\/g, "/");
    if (!relative || relative.startsWith("/") || relative.split("/").includes("..") || nodePath.isAbsolute(relative) || entries.has(relative)) fail("stable package manifest contains an unsafe or duplicate path");
    const file = nodePath.join(packageRoot, ...relative.split("/"));
    if (!inside(packageRoot, file) || !regular(fsImpl, file) || sha256(fsImpl.readFileSync(file)).toLowerCase() !== match[1].toLowerCase()) fail("stable package file hash does not match the manifest: " + relative);
    entries.set(relative, match[1].toLowerCase());
  }
  if (!entries.has("shared/update-recovery.cjs")) fail("stable package manifest does not cover update-recovery.cjs");
}
function resolveInstaller(updater, options) {
  const values = [];
  if (options && options.installerPath) values.push(options.installerPath);
  const source = updater || {};
  for (const key of ["installerPath", "downloadedInstallerPath", "installer", "packageFile", "downloadedUpdate"]) {
    if (typeof source[key] === "string") values.push(source[key]);
  }
  for (const owner of [source.downloadedUpdateHelper, source.downloadedUpdate, source.updateInfo]) {
    if (!owner || typeof owner !== "object") continue;
    for (const key of ["installerPath", "file", "packageFile", "path", "downloadedFile"]) if (typeof owner[key] === "string") values.push(owner[key]);
    if (typeof owner.getValidPath === "function") {
      try { const value = owner.getValidPath(); if (typeof value === "string") values.push(value); } catch (_) { }
    }
  }
  return values.find(value => typeof value === "string" && value) || null;
}
function elevatePaths(updater, options) {
  const values = [];
  for (const value of [
    ...(Array.isArray(options && options.elevatePaths) ? options.elevatePaths : []),
    options && options.elevatePath,
    updater && updater.elevatePath,
    updater && updater.elevateHelper,
    updater && updater.elevateExecutable,
    updater && updater.elevateExe,
  ]) if (typeof value === "string" && value) values.push(nodePath.normalize(value));
  return values;
}
function knownElevatePaths(updater, active, installerPath, fsImpl, options) {
  const values = elevatePaths(updater, options);
  const roots = [];
  for (const value of [
    updater && updater.resourcesPath,
    updater && updater.appPath,
    updater && updater.app,
    active && active.app,
    installerPath && nodePath.dirname(installerPath),
  ]) if (typeof value === "string" && value && nodePath.isAbsolute(value)) roots.push(value);
  for (const root of roots) {
    for (const candidate of [nodePath.join(root, "elevate.exe"), nodePath.join(root, "resources", "elevate.exe")]) {
      if (regular(fsImpl, candidate)) values.push(nodePath.normalize(candidate));
    }
  }
  return [...new Set(values)];
}
function requiresAdministrator(active, updater, options) {
  const info = updater && updater.downloadedUpdateHelper && updater.downloadedUpdateHelper.downloadedFileInfo;
  const values = [
    options && options.requiresAdministrator,
    options && options.requiresAdmin,
    active.requiresAdministrator,
    active.requiresAdmin,
    active.requiresElevation,
    active.installerRequiresAdministrator,
    updater && updater.requiresAdministrator,
    updater && updater.requiresElevation,
    info && info.isAdminRightsRequired,
  ];
  return values.some(value => value === true);
}
function validateActive(raw, fsImpl, updater, options) {
  const active = asObject(raw, "active.json");
  if (active.schema !== SCHEMA) fail("active.json schema is unsupported");
  if (active.featureVersion !== "0.2.0") fail("active.json featureVersion is unsupported");
  for (const key of ["packageRoot", "node", "python", "pythonw", "app", "home", "runtime", "backupRoot", "maintenanceRoot", "shortcutReceipt"]) absolute(active[key], key);
  if (!isHash(active.packageManifestSha256)) fail("package manifest hash is invalid");
  if (!directory(fsImpl, active.packageRoot)) fail("stable package root is missing");
  if (!directory(fsImpl, active.app)) fail("OpenCode application directory is missing");
  if (!directory(fsImpl, active.home) || !directory(fsImpl, active.runtime)) fail("voice home/runtime directory is missing");
  for (const key of ["node", "python", "pythonw"]) if (!regular(fsImpl, active[key])) fail(key + " is missing");
  const manifestPath = nodePath.join(active.packageRoot, "CONTENTS.sha256");
  if (!regular(fsImpl, manifestPath)) fail("stable package manifest is missing");
  const manifestBytes = fsImpl.readFileSync(manifestPath);
  if (sha256(manifestBytes) !== active.packageManifestSha256.toLowerCase()) fail("stable package manifest hash does not match active.json");
  verifyManifestEntries(fsImpl, active.packageRoot, manifestBytes);
  const recovery = nodePath.join(active.packageRoot, "shared", "update-recovery.cjs");
  if (!regular(fsImpl, recovery)) fail("stable update-recovery.cjs is missing");
  const asar = findAsar(fsImpl, active.app);
  if (!asar) fail("current app.asar is missing");
  const executable = nodePath.join(active.app, "OpenCode.exe");
  if (!regular(fsImpl, executable)) fail("OpenCode.exe is missing");
  const installerPath = resolveInstaller(updater, options);
  if (!installerPath) fail("downloaded installer path is unavailable");
  const installer = absolute(installerPath, "installer path");
  if (!regular(fsImpl, installer)) fail("downloaded installer is missing");
  if (requiresAdministrator(active, updater, options)) fail("installer requires administrator elevation; automatic recovery path is refused");
  return { active, asar, executable, installer, installerPath: installer, recovery, currentAsarSha256: sha256(fsImpl.readFileSync(asar)) };
}
function processSpawn(options) { return typeof options.spawn === "function" ? options.spawn : childProcess.spawn; }
function writeEvent(session, name, extra = {}) {
  const file = nodePath.join(session.requestDirectory, name + ".json");
  writeJson(session.fs, file, { schema: SCHEMA, id: session.request.id, ...extra, at: now(session.options) });
}
function terminateHelper(session) {
  const child = session && session.child;
  if (child && typeof child.kill === "function") {
    try { child.kill(); } catch (_) { }
  }
}
function cancelInternal(session, reason) {
  if (!session || session.cancelled) return;
  session.cancelled = true;
  for (const timer of session.pidTimers || []) { try { clearInterval(timer); } catch (_) {} }
  session.pidTimers = [];
  try { writeEvent(session, "cancel", { reason: String(reason || "cancelled") }); } finally { terminateHelper(session); }
}
function readReady(session) {
  const readyPath = nodePath.join(session.requestDirectory, "ready.json");
  const errorPath = nodePath.join(session.requestDirectory, "error.json");
  if (regular(session.fs, errorPath)) {
    try {
      const error = asObject(readJson(session.fs, errorPath), "error.json");
      fail(String(error.message || error.error || "maintenance helper failed before ready"));
    } catch (error) {
      if (String(error.message || "").startsWith("update recovery:")) throw error;
      fail("error.json is invalid: " + error.message);
    }
  }
  if (!regular(session.fs, readyPath)) return null;
  let value;
  try { value = asObject(readJson(session.fs, readyPath), "ready.json"); } catch (error) { fail("ready.json is invalid: " + error.message); }
  if (value.state !== "ready" || value.id !== session.request.id || !Number.isInteger(value.ownerPid) || value.ownerPid <= 0 || (Number.isInteger(session.helperPid) && value.ownerPid !== session.helperPid)) fail("ready.json does not match this request");
  if (value.error) fail(String(value.error));
  if (value.ready === false || value.ok === false || value.state === "error") fail(String(value.message || "maintenance helper did not become ready"));
  return value;
}
async function waitReady(session) {
  const started = milliseconds(session.options);
  const timeout = session.options.readyTimeoutMs || READY_TIMEOUT_MS;
  const poll = session.options.readyPollMs || READY_POLL_MS;
  const maxPolls = Math.ceil(timeout / poll) + 2;
  for (let attempt = 0; attempt < maxPolls && milliseconds(session.options) - started <= timeout; attempt++) {
    const ready = readReady(session);
    if (ready) return ready;
    await wait(session.options, poll);
  }
  fail("maintenance helper did not create ready.json within 5 seconds");
}

async function prepare(version, updater, electron, options = {}) {
  const fsImpl = options.fs || nodeFs;
  let session;
  try {
    if (currentSession && !currentSession.cancelled && !currentSession.finished) fail("another recovery hand-off is already active");
    const configPath = configPathFor(electron, options);
    const active = options.config && typeof options.config === "object" ? options.config : readJson(fsImpl, configPath);
    const checked = validateActive(active, fsImpl, updater, options);
    const expectedVersion = normalVersion(version);
    const id = randomId(options);
    const requestDirectory = nodePath.join(checked.active.maintenanceRoot, "requests", id);
    if (!inside(nodePath.resolve(checked.active.maintenanceRoot), nodePath.resolve(requestDirectory))) fail("request path escaped maintenance root");
    if (typeof fsImpl.mkdirSync === "function") fsImpl.mkdirSync(requestDirectory, { recursive: true });
    const request = {
      schema: SCHEMA,
      id,
      createdAt: now(options),
      parentPid: Number.isInteger(options.parentPid) ? options.parentPid : process.pid,
      app: checked.active.app,
      currentAsarSha256: checked.currentAsarSha256,
      expectedVersion,
      installerPath: checked.installerPath,
      configPath,
    };
    writeJson(fsImpl, nodePath.join(requestDirectory, "request.json"), request);
    session = { fs: fsImpl, options, active: checked.active, checked, updater, request, requestDirectory, child: null, cancelled: false, finished: false, installerPids: [], unknownSpawn: false, knownSpawn: false, quitAndInstallCalled: false };
    currentSession = session;
    const args = [checked.recovery, "--config", configPath, "--mode", "update", "--request", nodePath.join(requestDirectory, "request.json")];
    const child = processSpawn(options)(checked.active.node, args, { detached: true, windowsHide: true, stdio: "ignore" });
    session.child = child;
    if (child && Number.isInteger(child.pid)) session.helperPid = child.pid;
    if (child && typeof child.unref === "function") child.unref();
    if (child && typeof child.once === "function") child.once("error", error => { session.spawnError = error; });
    await waitReady(session);
    return session;
  } catch (error) {
    if (session) cancelInternal(session, error.message);
    if (dialogError(electron, error.message, options)) error.ocVoiceUpdateNotified = true;
    if (currentSession === session) currentSession = null;
    console.error("[oc-voice] update preparation failed:", error.message);
    throw error;
  }
}
function ensureToken(token) {
  if (!currentSession || currentSession !== token || currentSession.cancelled || currentSession.finished) fail("recovery hand-off token is no longer active");
  return currentSession;
}
function commit(token) {
  const session = ensureToken(token);
  writeEvent(session, "commit", { expectedVersion: session.request.expectedVersion, installerPath: session.request.installerPath });
  session.committed = true;
  return true;
}
function cancel(token) {
  if (!token || !currentSession || token !== currentSession) return false;
  cancelInternal(currentSession, "cancelled by OpenCode");
  currentSession.finished = true;
  currentSession = null;
  return true;
}
function pathEquals(value, expected) { try { return samePath(nodePath.normalize(value), nodePath.normalize(expected)); } catch (_) { return false; } }
function knownInstaller(command, args, session, updater) {
  if (typeof command !== "string") return null;
  if (pathEquals(command, session.request.installerPath)) return session.request.installerPath;
  for (const elevate of knownElevatePaths(updater, session.active, session.request.installerPath, session.fs, session.options)) {
    if (!pathEquals(command, elevate)) continue;
    const installer = (args || []).find(value => typeof value === "string" && pathEquals(value, session.request.installerPath));
    if (installer) return command;
    return null;
  }
  return null;
}
function spawnKnown(session, command, args, env, stdio, displayPath) {
  session.knownAttempted = true;
  let child;
  try { child = processSpawn(session.options)(command, args || [], { stdio: stdio === undefined ? "ignore" : stdio, env, detached: true }); }
  catch (error) { throw new Error("official installer spawn failed: " + error.message); }
  if (child && typeof child.unref === "function") child.unref();
  const result = new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const recordPid = () => {
      const pid = child && Number.isInteger(child.pid) ? child.pid : null;
      if (pid === null || session.installerPids.some(item => item.pid === pid)) return false;
      session.knownSpawn = true;
      session.installerPids.push({ pid, path: displayPath, startedAt: now(session.options) });
      writeJson(session.fs, nodePath.join(session.requestDirectory, "installer-pids.json"), { schema: SCHEMA, id: session.request.id, pids: session.installerPids });
      return true;
    };
    if (recordPid()) { settled = true; resolve(true); }
    const onError = error => {
      if (timer) clearInterval(timer);
      session.spawnError = error;
      if (!settled) { settled = true; reject(error); }
    };
    if (child && typeof child.once === "function") child.once("error", onError);
    if (!settled) {
      timer = setInterval(() => {
        if (recordPid()) { clearInterval(timer); timer = null; settled = true; resolve(true); }
      }, 5);
      timer.unref?.();
      session.pidTimers ||= [];
      session.pidTimers.push(timer);
    }
  });
  // Official electron-updater versions differ on whether doInstall awaits
  // spawnLog.  Mark the promise handled while retaining its rejection for a
  // version that does await it; this prevents a detached fallback error from
  // becoming an unrelated process-level unhandled rejection.
  result.catch(() => {});
  return result;
}
function restoreProperty(object, key, previous) {
  if (previous.had) object[key] = previous.value;
  else { try { delete object[key]; } catch (_) { object[key] = undefined; } }
}
function quitAndInstall(updater) {
  const session = currentSession;
  if (!session || !session.committed) fail("quitAndInstall called without a committed recovery hand-off");
  if (!updater || typeof updater.quitAndInstall !== "function") { cancel(session); fail("official updater quitAndInstall is unavailable"); }
  const originalSpawnLog = updater.spawnLog;
  if (typeof originalSpawnLog !== "function") { cancel(session); fail("official updater spawnLog is unavailable"); }
  const originalQuit = updater.quitAndInstall;
  const autorun = { had: Object.prototype.hasOwnProperty.call(updater, "autoRunAppAfterInstall"), value: updater.autoRunAppAfterInstall };
  const spawn = function(command, args = [], env, stdio) {
    const display = knownInstaller(command, args, session, updater);
    if (!display) {
      session.unknownSpawn = true;
      return originalSpawnLog.call(this, command, args, env, stdio);
    }
    return spawnKnown(session, command, args, env, stdio, display);
  };
  updater.spawnLog = spawn;
  updater.autoRunAppAfterInstall = false;
  const restoreUpdater = () => {
    if (updater.spawnLog === spawn) updater.spawnLog = originalSpawnLog;
    restoreProperty(updater, "autoRunAppAfterInstall", autorun);
  };
  session.restoreUpdater = restoreUpdater;
  try {
    const result = originalQuit.call(updater, false, false);
    session.quitAndInstallCalled = updater.quitAndInstallCalled === true || updater._quitAndInstallCalled === true || updater.__quitAndInstallCalled === true || session.knownSpawn;
    if (!session.quitAndInstallCalled) throw new Error("official updater did not trigger quitAndInstall");
    if (!session.knownAttempted || session.unknownSpawn) throw new Error("official updater installer command was not safely identified");
    session.finished = true;
    // Keep the wrapper installed while the official updater finishes any
    // asynchronous fallback spawn.  The host process is quitting; failure
    // paths below restore both hooks synchronously.
    if (currentSession === session) currentSession = null;
    return result;
  } catch (error) {
    cancelInternal(session, error.message);
    restoreUpdater();
    if (currentSession === session) currentSession = null;
    throw new Error("official update hand-off failed: " + error.message);
  }
}

module.exports = { prepare, commit, cancel, quitAndInstall };
