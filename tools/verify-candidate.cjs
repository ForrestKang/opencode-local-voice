"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict"), cp = require("node:child_process");
const patcher = require("../shared/patch-package.cjs");
const [source, output, reportPath] = process.argv.slice(2);
assert.ok(source && output && reportPath, "Usage: node tools/verify-candidate.cjs ORIGINAL_ASAR OUTPUT_ASAR REPORT");
const before = fs.readFileSync(source), original = patcher.inspectAsarBuffer(before);
const options = { platform: "windows", bridgeSource: fs.readFileSync(path.resolve(__dirname, "../shared/desktop-bridge.cjs"), "utf8"), micSource: fs.readFileSync(path.resolve(__dirname, "../shared/oc-mic.js"), "utf8") };
const result = patcher.patchAsar(before, options); patcher.writeAtomic(output, result.buffer);
const readback = fs.readFileSync(output), inspected = patcher.inspectAsarBuffer(readback);
assert.equal(patcher.sha256(readback), result.outputHash); assert.equal(inspected.version, original.version);
const reapplied = patcher.patchAsar(readback, options); assert.equal(reapplied.outputHash, result.outputHash, "Repatch must be idempotent");
const entryText = name => patcher.readEntry(readback, inspected.dataStart, patcher.getEntry(inspected.header, name), name).toString("utf8");
assert.equal(entryText("out/main/oc-voice-bridge.cjs"), options.bridgeSource);
assert.equal(entryText("out/renderer/oc-voice-v2.js"), options.micSource);
assert.equal(entryText("out/main/oc-voice-update.cjs"), fs.readFileSync(path.resolve(__dirname, "../shared/update-bridge.cjs"), "utf8"));
assert.ok(entryText("out/renderer/oc-voice-native-settings.js").includes(fs.readFileSync(path.resolve(__dirname, "../shared/native-voice-settings.js"), "utf8")));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oc-candidate-syntax-")), checked = [];
try {
  for (const name of ["out/main/index.js", "out/preload/index.js", "out/main/oc-voice-bridge.cjs", "out/main/oc-voice-update.cjs", "out/renderer/oc-voice-v2.js", "out/renderer/oc-voice-native-settings.js", result.nativeSettings.v2, result.nativeSettings.legacy]) {
    const sourceText = patcher.readEntry(readback, inspected.dataStart, patcher.getEntry(inspected.header, name), name).toString("utf8");
    const filename = path.join(temporary, String(checked.length) + (name.endsWith(".cjs") ? ".cjs" : ".mjs"));
    fs.writeFileSync(filename, sourceText); cp.execFileSync(process.execPath, ["--check", filename], { windowsHide: true }); checked.push(name);
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
assert.equal(patcher.sha256(fs.readFileSync(source)), patcher.sha256(before), "Installed archive changed during read-only generation");
const report = { passed: true, createdAt: new Date().toISOString(), appVersion: inspected.version, sourceAsarSha256: patcher.sha256(before), candidateAsarSha256: result.outputHash, sourceUnchanged: true, idempotent: true, packedFiles: inspected.packed, integrityHashedFiles: inspected.hashed, syntaxChecked: checked, productionSourcesReadback: true, candidate: path.resolve(output) };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
