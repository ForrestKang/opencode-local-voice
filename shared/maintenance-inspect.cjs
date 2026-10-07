"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), cp = require("node:child_process"), patcher = require("./patch-package.cjs");
function inspectHooks(archive, sourceRoot) {
  const buffer = fs.readFileSync(archive), metadata = patcher.inspectAsarBuffer(buffer);
  function entry(name) {
    const node = patcher.getEntry(metadata.header, name);
    if (!node || node.unpacked || node.link) throw new Error("required packed entry is missing: " + name);
    return patcher.readEntry(buffer, metadata.dataStart, node, name);
  }
  const main = entry("out/main/index.js").toString("utf8");
  for (const marker of ["install:start", "install:end", "call:start", "call:end"]) {
    if (main.split("/*oc-voice-update:" + marker + "*/").length !== 2) throw new Error("update marker must be unique: " + marker);
  }
  for (const method of ["prepare", "commit", "cancel", "quitAndInstall"]) {
    if (!main.includes('require2("./oc-voice-update.cjs").' + method)) throw new Error("update method is missing: " + method);
  }
  const bridge = entry("out/main/oc-voice-update.cjs");
  const expected = fs.readFileSync(path.join(sourceRoot, "shared", "update-bridge.cjs"));
  if (!bridge.equals(expected)) throw new Error("embedded update bridge differs from the verified source");
  const checked = cp.spawnSync(process.execPath, ["--check", "--input-type=module"], { input: main, encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (checked.error || checked.status !== 0) throw new Error("native main script syntax check failed");
  new vm.Script(bridge.toString("utf8"), { filename: "out/main/oc-voice-update.cjs" });
  const renderer = entry("out/renderer/oc-voice-v2.js");
  if (!renderer.equals(fs.readFileSync(path.join(sourceRoot, "shared", "oc-mic.js")))) throw new Error("embedded voice renderer differs from the verified source");
  return { state: "ready", appVersion: metadata.version, asarSha256: patcher.sha256(buffer), updateBridgeSha256: patcher.sha256(bridge), updateHook: true };
}
if (require.main === module) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i];
      if (!["--asar", "--source"].includes(name) || !process.argv[i + 1] || Object.hasOwn(args, name)) throw new Error("invalid inspection argument");
      args[name] = process.argv[i + 1];
    }
    if (!args["--asar"] || !args["--source"]) throw new Error("asar and source paths are required");
    console.log(JSON.stringify(inspectHooks(args["--asar"], args["--source"])));
  } catch (error) { console.error("[maintenance-inspect] " + error.message); process.exitCode = 1; }
}
module.exports = { inspectHooks };
