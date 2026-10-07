"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const patcher = require("../shared/patch-package.cjs");
const support = require("../shared/install-support.cjs");
const bridgeSource = fs.readFileSync(path.join(__dirname, "../shared/desktop-bridge.cjs"), "utf8");
const micSource = fs.readFileSync(path.join(__dirname, "../shared/oc-mic.js"), "utf8");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const {makeAsar,makeStandardAsar,baseFiles,nativeV2Fixture,nativeLegacyFixture,nativeUpdaterFixture}=require("./fixtures/asar.cjs");

function tempDir() { return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "oc-voice-patch-test-")); }
function writeFixtureArchive(filename, files, version = "1.2.3") {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, makeAsar(files, version));
}

test("ASAR patch validates syntax, hashes, scoped media gates, and preserves untouched files", () => {
  const source = makeAsar(baseFiles());
  const result = patcher.patchAsar(source, { platform: "windows", bridgeSource, micSource });
  assert.notEqual(result.inputHash, result.outputHash);
  const parsed = patcher.inspectAsarBuffer(result.buffer);
  assert.equal(parsed.version, "1.2.3");
  assert.ok(parsed.hashed >= 5);
  const main = entryText(parsed, result.buffer, "out/main/index.js");
  assert.equal((main.match(/allowMedia\(webContents,permission,details\)/g) || []).length, 2);
  assert.match(main, /isTrustedRendererUrl\(details\.requestingUrl\)/);
  assert.match(main, /webContents\.id===webContentsId/);
  assert.doesNotMatch(main, /new Set\(\[[^\]]*["']media["']/);
  assert.doesNotMatch(main, /new Set\(\[[^\]]*["']local-network-access["']/);
  assert.equal(entryText(parsed, result.buffer, "out/renderer/keep.js"), "module.exports=17;\n");
  assert.deepEqual(result.nativeSettings, {
    v2: "out/renderer/assets/index-native-settings.js",
    legacy: "out/renderer/assets/dialog-settings-native.js",
  });
  const nativeV2 = entryText(parsed, result.buffer, result.nativeSettings.v2);
  const nativeLegacy = entryText(parsed, result.buffer, result.nativeSettings.legacy);
  const nativeUi = entryText(parsed, result.buffer, "out/renderer/oc-voice-native-settings.js");
  assert.match(nativeUi, /new URL\("\.\/assets\/native-ui-row\.css",import\.meta\.url\)/);
  assert.match(nativeUi, /some\(link=>link\.href===__ocVoiceNativeStyleHref\)/);
  assert.equal(entryText(parsed, result.buffer, "out/renderer/assets/native-ui-row.css"), '[data-slot="switch-control"]{border-radius:12px}');
  for (const [source, variant, panelClass] of [[nativeV2, "v2", "settings-v2-panel"], [nativeLegacy, "legacy", "no-scrollbar"]]) {
    assert.equal((source.match(/value:\"voice-input\"/g) || []).length, 2, variant);
    assert.equal((source.match(/value:\"shortcuts\"/g) || []).length, 2, variant);
    assert.equal((source.match(/createComponent\(__ocVoiceNativePanel,\{\}\)/g) || []).length, 1, variant);
    assert.doesNotMatch(source, /document\.createElement\(\"oc-voice-settings\"\)/);
    assert.match(source, new RegExp("class:\\\"" + panelClass + "\\\""));
    assert.match(source, new RegExp("oc-voice-native-settings-" + variant + ":trigger:start"));
    assert.match(source, /__ocVoiceInputIcon/);
    assert.match(source, /__ocVoiceInputLabel/);
  }
});

test("patching a patched archive is byte-identical", () => {
  const once = patcher.patchAsar(makeAsar(baseFiles()), { platform: "linux", bridgeSource, micSource });
  const twice = patcher.patchAsar(once.buffer, { platform: "linux", bridgeSource, micSource });
  assert.deepEqual(twice.buffer, once.buffer);
});

test("Windows automatic recovery requires a unique native prompt and a verified updater layout", () => {
  const missing = baseFiles();
  delete missing["out/renderer/assets/prompt-native.js"];
  assert.throws(() => patcher.patchAsar(makeAsar(missing), { platform: "windows", bridgeSource, micSource }), /prompt module candidate count is 0/);
  const duplicated = baseFiles();
  duplicated["out/renderer/assets/prompt-copy.js"] = duplicated["out/renderer/assets/prompt-native.js"];
  assert.throws(() => patcher.patchAsar(makeAsar(duplicated), { platform: "windows", bridgeSource, micSource }), /prompt module candidate count is 2/);
  const changed = baseFiles();
  changed["out/main/index.js"] = changed["out/main/index.js"].replace("await input.stop()", "await input.differentStop()");
  assert.throws(() => patcher.patchAsar(makeAsar(changed), { platform: "windows", bridgeSource, micSource }), /unsupported OpenCode updater layout/);
});

test("upstream ASAR Pickle padding of zero through three bytes is supported", () => {
  const seen = new Set();
  for (let digits = 1; digits <= 12 && seen.size < 4; digits += 1) {
    const version = "1.2.3";
    const source = makeStandardAsar(baseFiles(), version, "x".repeat(digits));
    const padding = source.readUInt32LE(4) - source.readUInt32LE(12) - 8;
    if (seen.has(padding)) continue;
    seen.add(padding);
    const before = Buffer.from(source);
    const original = patcher.inspectAsarBuffer(source);
    assert.equal(original.version, version);
    assert.equal(entryText(original, source, "out/renderer/keep.js"), "module.exports=17;\n");
    const patched = patcher.patchAsar(source, { platform: "windows", bridgeSource, micSource });
    const parsed = patcher.inspectAsarBuffer(patched.buffer);
    assert.equal(parsed.dataStart % 4, 0, "emitted archive uses standard Pickle alignment");
    assert.equal(patched.buffer.readUInt32LE(8), patched.buffer.readUInt32LE(4) - 4);
    assert.equal(entryText(parsed, patched.buffer, "out/renderer/keep.js"), "module.exports=17;\n");
    assert.deepEqual(source, before, "generation does not write to its input");
    assert.deepEqual(patcher.patchAsar(patched.buffer, { platform: "windows", bridgeSource, micSource }).buffer, patched.buffer);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test("ASAR headers reject inconsistent, excessive, truncated or nonzero padding", () => {
  let source;
  for (let digits = 1; digits <= 12; digits += 1) {
    source = makeStandardAsar(baseFiles(), "1.2." + "3".repeat(digits));
    if (source.readUInt32LE(4) > source.readUInt32LE(12) + 8) break;
  }
  const dataStart = 8 + source.readUInt32LE(4);
  assert.ok(dataStart > 16 + source.readUInt32LE(12));
  const nonzero = Buffer.from(source);
  nonzero[16 + source.readUInt32LE(12)] = 1;
  assert.throws(() => patcher.inspectAsarBuffer(nonzero), /padding is not zero-filled/);
  const inconsistent = Buffer.from(source);
  inconsistent.writeUInt32LE(inconsistent.readUInt32LE(8) - 4, 8);
  assert.throws(() => patcher.inspectAsarBuffer(inconsistent), /malformed ASAR header/);
  const excessive = Buffer.from(source);
  excessive.writeUInt32LE(excessive.readUInt32LE(4) + 4, 4);
  excessive.writeUInt32LE(excessive.readUInt32LE(8) + 4, 8);
  assert.throws(() => patcher.inspectAsarBuffer(excessive), /malformed ASAR header/);
  assert.throws(() => patcher.inspectAsarBuffer(source.subarray(0, dataStart - 1)), /header extends beyond input/);
  const compact = makeAsar(baseFiles());
  assert.equal(patcher.inspectAsarBuffer(compact).version, "1.2.3", "previous compact backups remain readable");
});
test("native settings patch is idempotent and preserves the native tabs", () => {
  const v2 = patcher.patchNativeSettingsSource(nativeV2Fixture, "v2");
  assert.equal(patcher.patchNativeSettingsSource(v2, "v2"), v2);
  assert.match(v2, /TabsV2\.List/);
  assert.match(v2, /value:\"general\"/);
  assert.match(v2, /value:\"shortcuts\"/);
  assert.match(v2, /createComponent\(__ocVoiceNativePanel,\{\}\)/);
  const legacy = patcher.patchNativeSettingsSource(nativeLegacyFixture, "legacy");
  assert.equal(patcher.patchNativeSettingsSource(legacy, "legacy"), legacy);
  assert.match(legacy, /Tabs\.List/);
  assert.match(legacy, /value:\"general\"/);
});
test("native settings candidate discovery fails closed for missing, duplicate, and unknown layouts", () => {
  const missing = baseFiles();
  delete missing["out/renderer/assets/index-native-settings.js"];
  assert.throws(() => patcher.patchAsar(makeAsar(missing), { platform: "windows", bridgeSource, micSource }), /v2 module candidate count is 0/);
  const duplicate = baseFiles();
  duplicate["out/renderer/assets/index-native-settings-copy.js"] = nativeV2Fixture;
  assert.throws(() => patcher.patchAsar(makeAsar(duplicate), { platform: "windows", bridgeSource, micSource }), /v2 module candidate count is 2/);
  const unknown = baseFiles();
  unknown["out/renderer/assets/index-native-settings.js"] = nativeV2Fixture.replace("createComponent(TabsV2.List", "createComponent(Unknown.List");
  assert.throws(() => patcher.patchAsar(makeAsar(unknown), { platform: "windows", bridgeSource, micSource }), /v2 module candidate count is 0/);
});

test("native UI rejects missing controls, missing or ambiguous styles, and malformed source", () => {
  const options = { platform: "windows", bridgeSource, micSource };
  const missingBinding = baseFiles();
  missingBinding["out/renderer/assets/index-native-settings.js"] = nativeV2Fixture.replace("createSignal,", "");
  assert.throws(() => patcher.patchAsar(makeAsar(missingBinding), options), /missing createSignal/);
  const missingAsset = baseFiles();
  delete missingAsset["out/renderer/assets/native-ui-controls.js"];
  assert.throws(() => patcher.patchAsar(makeAsar(missingAsset), options), /native UI dependency is missing/);
  const missingStyle = baseFiles();
  delete missingStyle["out/renderer/assets/native-ui-row.css"];
  assert.throws(() => patcher.patchAsar(makeAsar(missingStyle), options), /stylesheet candidate count is 0/);
  const ambiguousStyle = baseFiles();
  ambiguousStyle["out/renderer/assets/duplicate-ui-row.css"] = ambiguousStyle["out/renderer/assets/native-ui-row.css"];
  assert.throws(() => patcher.patchAsar(makeAsar(ambiguousStyle), options), /stylesheet candidate count is 2/);
  assert.throws(() => patcher.patchAsar(makeAsar(baseFiles()), {
    ...options, nativeSettingsSource: "function __ocVoiceNativeSettingsV2(props){const broken=;}"
  }), /syntax|SyntaxError|JavaScript/);
});

test("legacy marker migration removes only its own line and keeps following source", () => {
  const result = patcher.patchAsar(makeAsar(baseFiles({ legacy: true })), { platform: "macos", bridgeSource, micSource });
  const parsed = patcher.inspectAsarBuffer(result.buffer);
  const main = entryText(parsed, result.buffer, "out/main/index.js");
  assert.doesNotMatch(main, /oc-stt-v4/);
  assert.match(main, /const codeAfterLegacyMarker=42;/);
  assert.match(main, /oc-voice-v2:start/);
});

test("unknown Electron permission source layouts fail closed", () => {
  assert.throws(() => patcher.patchAsar(makeAsar(baseFiles({ unknown: true })), { platform: "windows", bridgeSource, micSource }), /unsupported renderer permission layout/);
  assert.throws(() => patcher.patchAsar(makeAsar(baseFiles({ broadUnknown: true })), { platform: "windows", bridgeSource, micSource }), /global media\/network access/);
});

test("manifest apply and restore are version/hash bound, and replacement failure keeps source intact", () => {
  const root = tempDir();
  try {
    const app = path.join(root, "OpenCode");
    const resources = path.join(app, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const installed = path.join(resources, "app.asar");
    const candidate = path.join(root, "candidate.asar");
    const backupRoot = path.join(root, "backups");
    const originalBuffer = makeAsar(baseFiles());
    fs.writeFileSync(installed, originalBuffer);
    fs.writeFileSync(candidate, patcher.patchAsar(originalBuffer, { platform: "windows", bridgeSource, micSource }).buffer);

    assert.throws(() => support.applyAsar({ platform: "windows", app, input: installed, patched: candidate,
      backupRoot: path.join(app, "backup-inside-app") }), /backup root must be outside the application directory/);
    assert.throws(() => support.applyAsar({ platform: "windows", app, input: installed, patched: candidate,
      backupRoot: installed }), /backup root must not be the application archive/);
    const linkedParent = path.join(root, "linked-backups");
    let linkedCreated = false;
    try {
      fs.symlinkSync(root, linkedParent, process.platform === "win32" ? "junction" : "dir");
      linkedCreated = true;
    } catch (_) {}
    try {
      if (linkedCreated) {
        assert.throws(() => support.applyAsar({ platform: "windows", app, input: installed, patched: candidate,
          backupRoot: path.join(linkedParent, "ledger") }), /linked path component/);
      }
    } finally { try { fs.rmSync(linkedParent, { recursive: true, force: true }); } catch (_) {} }

    const originalHash = sha256(fs.readFileSync(installed));
    assert.throws(() => support.atomicReplaceFile(candidate, installed, { beforeCommit() { throw new Error("fixture injected failure"); } }), /fixture injected failure/);
    assert.equal(sha256(fs.readFileSync(installed)), originalHash);

    const manifest = support.applyAsar({ platform: "windows", app, input: installed, patched: candidate, backupRoot });
    assert.equal(manifest.state, "applied");
    assert.notEqual(sha256(fs.readFileSync(installed)), originalHash);
    const restored = support.restoreAsar({ platform: "windows", app, input: installed, backupRoot });
    assert.equal(restored.state, "restored");
    assert.equal(sha256(fs.readFileSync(installed)), originalHash);

    const newVersion = path.join(root, "new-version.asar");
    writeFixtureArchive(newVersion, baseFiles(), "1.2.4");
    fs.copyFileSync(newVersion, installed);
    assert.throws(() => support.restoreAsar({ platform: "windows", app, input: installed, backupRoot }), /cross-version restore/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed final manifest commits roll back both apply and restore archives", () => {
  const root = tempDir();
  const originalRename = fs.renameSync;
  try {
    const app = path.join(root, "OpenCode");
    const resources = path.join(app, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const installed = path.join(resources, "app.asar");
    const candidate = path.join(root, "candidate.asar");
    const backupRoot = path.join(root, "backups");
    const original = makeAsar(baseFiles());
    const patched = patcher.patchAsar(original, { platform: "windows", bridgeSource, micSource }).buffer;
    fs.writeFileSync(installed, original);
    fs.writeFileSync(candidate, patched);

    let manifestRenames = 0;
    fs.renameSync = function (source, destination) {
      if (path.basename(destination) === "manifest.json" && ++manifestRenames === 2) {
        throw new Error("fixture final apply manifest commit failure");
      }
      return originalRename.call(fs, source, destination);
    };
    assert.throws(() => support.applyAsar({ platform: "windows", app, input: installed, patched: candidate, backupRoot }),
      /fixture final apply manifest commit failure/);
    fs.renameSync = originalRename;
    assert.deepEqual(fs.readFileSync(installed), original, "apply failure left the candidate installed");
    let manifest = support.listManifests(backupRoot, "windows")[0].manifest;
    assert.equal(manifest.state, "apply-failed");

    support.applyAsar({ platform: "windows", app, input: installed, patched: candidate, backupRoot });
    assert.deepEqual(fs.readFileSync(installed), patched);
    manifestRenames = 0;
    fs.renameSync = function (source, destination) {
      if (path.basename(destination) === "manifest.json" && ++manifestRenames === 1) {
        throw new Error("fixture final restore manifest commit failure");
      }
      return originalRename.call(fs, source, destination);
    };
    assert.throws(() => support.restoreAsar({ platform: "windows", app, input: installed, backupRoot }),
      /fixture final restore manifest commit failure/);
    fs.renameSync = originalRename;
    assert.deepEqual(fs.readFileSync(installed), patched, "restore failure left the app restored but untracked");
    manifest = support.listManifests(backupRoot, "windows")[0].manifest;
    assert.equal(manifest.state, "restore-failed");
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("separate app paths do not overwrite each other's same-source manifests", () => {
  const root = tempDir();
  try {
    const source = makeAsar(baseFiles());
    const candidate = patcher.patchAsar(source, { platform: "linux", bridgeSource, micSource }).buffer;
    const backupRoot = path.join(root, "backups");
    const apps = [path.join(root, "AppA"), path.join(root, "AppB")];
    for (let i = 0; i < apps.length; i += 1) {
      fs.mkdirSync(path.join(apps[i], "resources"), { recursive: true });
      const installed = path.join(apps[i], "resources", "app.asar");
      const candidatePath = path.join(root, `candidate-${i}.asar`);
      fs.writeFileSync(installed, source);
      fs.writeFileSync(candidatePath, candidate);
      support.applyAsar({ platform: "linux", app: apps[i], input: installed, patched: candidatePath, backupRoot });
    }
    for (const app of apps) {
      const installed = path.join(app, "resources", "app.asar");
      support.restoreAsar({ platform: "linux", app, input: installed, backupRoot });
      assert.deepEqual(fs.readFileSync(installed), source);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("macOS manifest binds a full-bundle backup and refuses a different app version", () => {
  const root = tempDir();
  try {
    const app = path.join(root, "OpenCode.app");
    const originalBundle = path.join(root, "backups", "mac-original", "OpenCode.app");
    const candidate = path.join(root, "stage", "OpenCode.app");
    for (const bundle of [app, originalBundle, candidate]) {
      fs.mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
      fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "original plist\n");
      fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "OpenCode"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
    }
    const source = makeAsar(baseFiles());
    const patched = patcher.patchAsar(source, { platform: "macos", bridgeSource, micSource }).buffer;
    const originalAsar = path.join(app, "Contents", "Resources", "app.asar");
    const savedAsar = path.join(originalBundle, "Contents", "Resources", "app.asar");
    const candidateAsar = path.join(candidate, "Contents", "Resources", "app.asar");
    fs.writeFileSync(originalAsar, source);
    fs.writeFileSync(savedAsar, source);
    fs.writeFileSync(candidateAsar, patched);
    const backupRoot = path.join(root, "manifests");
    const prepared = support.prepareBundleManifest({ app, candidate, input: originalAsar, patched: candidateAsar,
      originalBundle, backupRoot, fuseBefore: "Enabled", fuseAfter: "Disabled" });
    assert.equal(prepared.fuseBefore, "Enabled");
    assert.equal(prepared.fuseAfter, "Disabled");
    assert.match(prepared.originalBundleTreeSha256, /^[0-9a-f]{64}$/);
    assert.match(prepared.candidateBundleTreeSha256, /^[0-9a-f]{64}$/);
    assert.equal(support.findBundleBackup({ app, input: candidateAsar, backupRoot }).originalBundle, originalBundle);
    const stagedRestore = path.join(root, "restore-stage", "OpenCode.app");
    fs.cpSync(originalBundle, stagedRestore, { recursive: true });
    assert.equal(support.verifyBundle({ bundle: stagedRestore, digest: prepared.originalBundleTreeSha256 }).sha256,
      prepared.originalBundleTreeSha256);

    const infoPlist = path.join(originalBundle, "Contents", "Info.plist");
    const originalPlist = fs.readFileSync(infoPlist);
    fs.writeFileSync(infoPlist, "tampered plist\n");
    assert.throws(() => support.findBundleBackup({ app, input: candidateAsar, backupRoot }), /bundle backup tree does not match/);
    fs.writeFileSync(infoPlist, originalPlist);

    const machO = path.join(originalBundle, "Contents", "MacOS", "OpenCode");
    const originalMachO = fs.readFileSync(machO);
    fs.writeFileSync(machO, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9, 9, 9]));
    assert.throws(() => support.findBundleBackup({ app, input: candidateAsar, backupRoot }), /bundle backup tree does not match/);
    fs.writeFileSync(machO, originalMachO);

    fs.writeFileSync(path.join(stagedRestore, "Contents", "Info.plist"), "tampered staged restore\n");
    assert.throws(() => support.verifyBundle({ bundle: stagedRestore, digest: prepared.originalBundleTreeSha256 }), /staged macOS bundle tree/);

    fs.copyFileSync(candidateAsar, originalAsar);
    assert.equal(support.setBundleState({ app, input: originalAsar, backupRoot, state: "applied" }).manifest.state, "applied");
    fs.copyFileSync(savedAsar, originalAsar);
    assert.equal(support.setBundleState({ app, input: originalAsar, backupRoot, state: "restored" }).manifest.state, "restored");

    const upgradedAsar = path.join(root, "upgraded.asar");
    writeFixtureArchive(upgradedAsar, baseFiles(), "1.2.4");
    assert.throws(() => support.findBundleBackup({ app, input: upgradedAsar, backupRoot }), /cross-version restore/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("UI preview uses its own backup ledger and restores an existing voice patch", () => {
  const root = tempDir();
  try {
    const app = path.join(root, "app"), input = path.join(app, "resources", "app.asar");
    const original = makeAsar(baseFiles());
    const installedVoice = patcher.patchAsar(original, { platform: "windows", bridgeSource, micSource }).buffer;
    const preview = patcher.patchAsar(installedVoice, { platform: "windows", bridgeSource, micSource: micSource + "\n// UI preview build\n" }).buffer;
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, original);
    const installedFile = path.join(root, "installed.asar"), previewFile = path.join(root, "preview.asar");
    fs.writeFileSync(installedFile, installedVoice); fs.writeFileSync(previewFile, preview);
    const regularRoot = path.join(root, "regular-backups"), previewRoot = path.join(root, "ui-preview-backups");
    const args = { platform: "windows", app, input };
    support.applyAsar({ ...args, patched: installedFile, backupRoot: regularRoot });
    assert.throws(() => support.applyAsar({ ...args, patched: previewFile, backupRoot: regularRoot }), /already has this patch/);
    assert.equal(sha256(fs.readFileSync(input)), sha256(installedVoice));
    const applied = support.applyAsar({ ...args, patched: previewFile, backupRoot: previewRoot });
    assert.equal(applied.sourceAsarSha256, sha256(installedVoice));
    assert.equal(sha256(fs.readFileSync(input)), sha256(preview));
    support.restoreAsar({ ...args, backupRoot: previewRoot });
    assert.equal(sha256(fs.readFileSync(input)), sha256(installedVoice));
    support.restoreAsar({ ...args, backupRoot: regularRoot });
    assert.equal(sha256(fs.readFileSync(input)), sha256(original));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function entryText(parsed, buffer, name) {
  return patcher.readEntry(buffer, parsed.dataStart, patcher.getEntry(parsed.header, name), name).toString("utf8");
}
