"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const feature = require("../shared/feature-update.cjs"), patcher = require("../shared/patch-package.cjs");
function archive(text, version = "1.18.33") {
  const data = Buffer.from(JSON.stringify({ version, text })), header = Buffer.from(JSON.stringify({ files: { "package.json": { size: data.length, offset: "0" } } }));
  const out = Buffer.alloc(16 + header.length + data.length); out.writeUInt32LE(4, 0); out.writeUInt32LE(header.length + 8, 4); out.writeUInt32LE(header.length + 4, 8); out.writeUInt32LE(header.length, 12); header.copy(out, 16); data.copy(out, 16 + header.length); return out;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "oc-feature-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = { app: path.join(root, "app"), runtime: path.join(root, "runtime"), home: path.join(root, "home"), source: path.join(root, "source"), patched: path.join(root, "new.asar"), backupRoot: path.join(root, "backups"), python: process.execPath };
  for (const key of ["app", "runtime", "home", "source"]) fs.mkdirSync(args[key]);
  args.input = path.join(args.app, "app.asar"); fs.writeFileSync(args.input, archive("accepted")); fs.writeFileSync(args.patched, archive("candidate"));
  for (const name of new Set(Object.values(feature.FILES))) fs.writeFileSync(path.join(args.source, name), "new " + name);
  for (const name of ["voice_server.py", "stt_server.py", "voice_cli.py", "desktop-bridge.cjs"]) fs.writeFileSync(path.join(args.runtime, name), "old " + name);
  fs.writeFileSync(path.join(args.home, "config.json"), '{"language":"auto"}'); fs.writeFileSync(path.join(args.home, "token"), "unchanged-token");
  return { args, hooks: { checkClosed() {}, stop() { return { state: "not_running" }; } } };
}
function directoryLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return null;
  } catch (error) {
    return error;
  }
}
test("feature upgrade backs up accepted archive/runtime and restore preserves newly edited settings", t => {
  const { args, hooks } = fixture(t), before = fs.readFileSync(args.input);
  const applied = feature.apply(args, hooks); assert.equal(applied.state, "applied");
  assert.equal(fs.readFileSync(path.join(args.runtime, "stt_server.py"), "utf8"), "new voice_server.py");
  fs.writeFileSync(path.join(args.home, "config.json"), '{"text_mode":"ai"}'); fs.writeFileSync(path.join(args.home, "rewrite_api_key"), "encrypted fixture");
  const restored = feature.restore({ ...args, transaction: applied.transaction }, hooks);
  assert.equal(restored.state, "restored"); assert.deepEqual(fs.readFileSync(args.input), before);
  assert.equal(fs.readFileSync(path.join(args.home, "config.json"), "utf8"), '{"language":"auto"}');
  assert.equal(fs.readFileSync(path.join(restored.preservedNewSettings, "home", "config.json"), "utf8"), '{"text_mode":"ai"}');
  assert.equal(fs.readFileSync(path.join(restored.preservedNewSettings, "home", "rewrite_api_key"), "utf8"), "encrypted fixture");
  assert.equal(fs.existsSync(path.join(args.runtime, "voice_text.py")), false); assert.equal(fs.existsSync(path.join(args.home, "rewrite_api_key")), false);
  assert.equal(fs.readFileSync(path.join(args.home, "token"), "utf8"), "unchanged-token");
});
test("feature deployment failure rolls back the whole runtime without changing the accepted archive", t => {
  const { args, hooks } = fixture(t), before = fs.readFileSync(args.input);
  assert.throws(() => feature.apply(args, { ...hooks, afterFile(name) { if (name === "voice_text.py") throw new Error("injected deployment failure"); } }), /injected deployment failure/);
  assert.deepEqual(fs.readFileSync(args.input), before); assert.equal(fs.readFileSync(path.join(args.runtime, "voice_server.py"), "utf8"), "old voice_server.py");
  assert.equal(fs.existsSync(path.join(args.runtime, "voice_text.py")), false);
});
test("stop failure does not create a feature transaction or change any deployment target", t => {
  const { args } = fixture(t), beforeArchive = fs.readFileSync(args.input), beforeRuntime = fs.readFileSync(path.join(args.runtime, "voice_server.py"));
  let serviceStopped = false;
  assert.throws(() => feature.apply(args, {
    checkClosed() {},
    stop() { serviceStopped = true; throw new Error("injected stop failure after service shutdown"); },
  }), /injected stop failure/);
  assert.equal(serviceStopped, true);
  assert.equal(fs.existsSync(args.backupRoot), false, "stop failure must not create a backup root or transaction");
  assert.deepEqual(fs.readFileSync(args.input), beforeArchive);
  assert.deepEqual(fs.readFileSync(path.join(args.runtime, "voice_server.py")), beforeRuntime);
});
test("backup preparation failure removes the incomplete transaction and leaves the accepted archive untouched", t => {
  const { args } = fixture(t);
  let serviceStopped = false;
  const originalStop = () => { serviceStopped = true; };
  fs.mkdirSync(path.join(args.runtime, "voice_text.py"));
  assert.throws(() => feature.apply(args, { checkClosed() {}, stop: originalStop }), /refusing non-file/);
  assert.equal(serviceStopped, true);
  assert.equal(fs.existsSync(args.backupRoot), true, "the caller-owned backup root may remain, but no transaction is valid");
  assert.deepEqual(fs.readdirSync(args.backupRoot), [], "incomplete feature transaction was removed");
  assert.equal(feature.apply({ ...args, dryRun: true }, { checkClosed() {}, stop() { assert.fail("dry run must not stop"); } }).state, "dry-run");
});
test("restore failure recovers the upgraded runtime and exact candidate archive", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks), before = fs.readFileSync(args.input);
  assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, { ...hooks, afterRestoreRuntime() { throw new Error("injected restore failure"); } }), /injected restore failure/);
  assert.deepEqual(fs.readFileSync(args.input), before); assert.equal(fs.readFileSync(path.join(args.runtime, "voice_text.py"), "utf8"), "new voice_text.py");
});
test("restore preparation failure leaves the applied manifest and archive retryable", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks), patched = fs.readFileSync(args.input);
  fs.rmSync(path.join(args.runtime, "voice_server.py")); fs.mkdirSync(path.join(args.runtime, "voice_server.py"));
  assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, hooks), /refusing non-file/);
  assert.deepEqual(fs.readFileSync(args.input), patched);
  assert.equal(JSON.parse(fs.readFileSync(path.join(applied.transaction, "feature-manifest.json"), "utf8")).state, "applied");
  assert.deepEqual(fs.readdirSync(applied.transaction).filter(name => name.startsWith("before-restore-")), []);
});
test("restore stop failure leaves no restore snapshot and keeps the applied transaction retryable", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks), before = fs.readFileSync(args.input);
  let serviceStopped = false;
  assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, {
    checkClosed() {},
    stop() { serviceStopped = true; throw new Error("injected restore stop failure after service shutdown"); },
  }), /injected restore stop failure/);
  assert.equal(serviceStopped, true);
  assert.deepEqual(fs.readFileSync(args.input), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(applied.transaction, "feature-manifest.json"), "utf8")).state, "applied");
  assert.deepEqual(fs.readdirSync(applied.transaction).filter(name => name.startsWith("before-restore-")), []);
});
test("restore refuses corrupt snapshots, changed app hashes and mismatched target paths before stopping services", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks);
  const guarded = { checkClosed() { assert.fail("must validate before checking/stopping"); }, stop() { assert.fail("must not stop"); } };
  fs.writeFileSync(args.input, archive("other")); assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, guarded), /version\/hash/);
  fs.copyFileSync(args.patched, args.input); fs.writeFileSync(path.join(applied.transaction, "before", "runtime", "voice_server.py"), "corrupt");
  assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, guarded), /backup is corrupt/);
  const other = path.join(args.app, "different.asar"); fs.copyFileSync(args.input, other);
  assert.throws(() => feature.restore({ ...args, input: other, transaction: applied.transaction }, guarded), /path mismatch/);
});
test("dry run and cross-version refusal leave runtime/config/app unchanged", t => {
  const { args, hooks } = fixture(t), before = patcher.sha256(fs.readFileSync(args.input));
  assert.equal(feature.apply({ ...args, dryRun: true }, hooks).state, "dry-run"); assert.equal(fs.existsSync(args.backupRoot), false);
  fs.writeFileSync(args.patched, archive("new", "1.18.34")); assert.throws(() => feature.apply(args, hooks), /same application version/);
  assert.equal(patcher.sha256(fs.readFileSync(args.input)), before);
});

test("feature apply rejects backup roots inside deployment targets before dry-run validation can write", t => {
  const { args } = fixture(t);
  for (const target of [args.app, args.runtime, args.home]) {
    let stopped = false;
    assert.throws(() => feature.apply({ ...args, backupRoot: path.join(target, "nested-backups"), dryRun: true }, {
      checkClosed() { assert.fail("internal backup root must be rejected before checking the app"); },
      stop() { stopped = true; assert.fail("internal backup root must be rejected before stopping the service"); },
    }), /backup root must be outside target directories/);
    assert.equal(stopped, false);
    assert.equal(fs.existsSync(path.join(target, "nested-backups")), false);
  }
  assert.equal(fs.existsSync(args.backupRoot), false);
});

test("feature apply rejects a linked backup-root parent before stopping, including dry-run", t => {
  const { args } = fixture(t), link = path.join(path.dirname(args.backupRoot), "linked-backups");
  const linkError = directoryLink(path.dirname(args.backupRoot), link);
  if (linkError) return t.skip("directory links unavailable: " + linkError.message);
  try {
    let stopped = false;
    assert.throws(() => feature.apply({ ...args, backupRoot: path.join(link, "nested"), dryRun: true }, {
      checkClosed() { assert.fail("linked backup root must be rejected before checking the app"); },
      stop() { stopped = true; assert.fail("linked backup root must be rejected before stopping the service"); },
    }), /backup root must not contain a linked path component/);
    assert.equal(stopped, false);
    assert.equal(fs.existsSync(path.join(path.dirname(args.backupRoot), "nested")), false);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

test("feature apply rejects a non-directory backup root before stopping", t => {
  const { args } = fixture(t), invalid = path.join(path.dirname(args.backupRoot), "backup-file");
  fs.writeFileSync(invalid, "caller-owned marker");
  let stopped = false;
  assert.throws(() => feature.apply({ ...args, backupRoot: invalid, dryRun: true }, {
    checkClosed() { assert.fail("invalid backup root must be rejected before checking the app"); },
    stop() { stopped = true; assert.fail("invalid backup root must be rejected before stopping the service"); },
  }), /backup root path component must be a directory/);
  assert.equal(stopped, false);
  assert.equal(fs.readFileSync(invalid, "utf8"), "caller-owned marker");
});

test("feature restore rejects a transaction path through a linked parent before stopping", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks);
  const link = path.join(path.dirname(applied.transaction), "linked-transaction-parent");
  const linkError = directoryLink(path.dirname(applied.transaction), link);
  if (linkError) return t.skip("directory links unavailable: " + linkError.message);
  try {
    let stopped = false;
    assert.throws(() => feature.restore({ ...args, transaction: path.join(link, path.basename(applied.transaction)) }, {
      checkClosed() { assert.fail("linked transaction must be rejected before checking the app"); },
      stop() { stopped = true; assert.fail("linked transaction must be rejected before stopping the service"); },
    }), /feature transaction must not contain a linked path component/);
    assert.equal(stopped, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(applied.transaction, "feature-manifest.json"), "utf8")).state, "applied");
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

test("stale candidate source hash is rejected before shutting down services", t => {
  const { args } = fixture(t);
  const before = fs.readFileSync(args.input);
  assert.throws(() => feature.apply({ ...args, expectedSourceHash: "a".repeat(64) }, {
    checkClosed() { assert.fail("must reject before checking/stopping"); }, stop() { assert.fail("must not stop"); },
  }), /changed since candidate generation/);
  assert.deepEqual(fs.readFileSync(args.input), before);
  assert.equal(fs.existsSync(args.backupRoot), false);
});

test("a concurrent official update survives failure without cross-version rollback or lost settings", t => {
  const { args, hooks } = fixture(t);
  const newer = archive("official update", "1.18.34");
  const userConfig = '{"language":"en","user_edit":"preserved"}';
  assert.throws(() => feature.apply(args, { ...hooks, afterFile(name) {
    if (name === "voice_text.py") { fs.writeFileSync(args.input, newer); fs.writeFileSync(path.join(args.home, "config.json"), userConfig); }
  } }), /changed since candidate generation/);
  assert.deepEqual(fs.readFileSync(args.input), newer);
  assert.equal(fs.readFileSync(path.join(args.home, "config.json"), "utf8"), userConfig);
  assert.equal(fs.readFileSync(path.join(args.runtime, "voice_server.py"), "utf8"), "old voice_server.py");
});

test("an application reopened during deployment prevents ASAR replacement", t => {
  const { args, hooks } = fixture(t), before = fs.readFileSync(args.input);
  let opened = false;
  assert.throws(() => feature.apply(args, { ...hooks,
    checkClosed() { if (opened) throw new Error("app reopened"); },
    afterFile(name) { if (name === "voice_text.py") opened = true; },
  }), /app reopened/);
  assert.deepEqual(fs.readFileSync(args.input), before);
  assert.equal(fs.readFileSync(path.join(args.runtime, "voice_server.py"), "utf8"), "old voice_server.py");
});

test("an official update during restore is preserved rather than rolled back across versions", t => {
  const { args, hooks } = fixture(t), applied = feature.apply(args, hooks);
  const official = archive("new official application", "1.18.34");
  assert.throws(() => feature.restore({ ...args, transaction: applied.transaction }, { ...hooks,
    afterRestoreRuntime() { fs.writeFileSync(args.input, official); },
  }), /archive changed during feature restore/);
  assert.deepEqual(fs.readFileSync(args.input), official);
  assert.equal(fs.readFileSync(path.join(args.runtime, "voice_text.py"), "utf8"), "new voice_text.py");
});
