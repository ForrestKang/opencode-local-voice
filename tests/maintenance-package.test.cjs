"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cache = require("../shared/maintenance-package.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cache-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "download"), maintenance = path.join(root, "maintenance");
  for (const name of cache.REQUIRED_FILES) { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name === "VERSION" ? "0.2.1\n" : "fixture:" + name); }
  return { root, source, maintenance };
}
test("source installation remains verifiable after its downloaded directory is removed", t => {
  const { source, maintenance } = fixture(t), saved = cache.ensurePackage(source, maintenance);
  fs.rmSync(source, { recursive: true, force: true });
  assert.equal(cache.verifyPackage(saved.packageRoot, saved.manifestSha256).featureVersion, "0.2.1");
  assert.equal(fs.readFileSync(path.join(saved.packageRoot, "shared/update-launcher.pyw"), "utf8"), "fixture:shared/update-launcher.pyw");
});
test("stable cache is reused and corrupt immutable caches are rejected", t => {
  const { source, maintenance } = fixture(t), first = cache.ensurePackage(source, maintenance), second = cache.ensurePackage(source, maintenance);
  assert.equal(first.packageRoot, second.packageRoot);
  fs.writeFileSync(path.join(first.packageRoot, "shared/update-recovery.cjs"), "corrupt");
  assert.throws(() => cache.ensurePackage(source, maintenance), /hash mismatch/);
});
test("malformed or escaping manifests cannot populate the maintenance cache", t => {
  const { source, maintenance } = fixture(t);
  fs.writeFileSync(path.join(source, "CONTENTS.sha256"), "a".repeat(64) + "  ../private.txt\n");
  assert.throws(() => cache.ensurePackage(source, maintenance), /unsafe package manifest path/);
  assert.equal(fs.existsSync(maintenance), false);
});
test("private credential files including stt_api_key are rejected in maintenance manifests", t => {
  const { source, maintenance } = fixture(t);
  fs.writeFileSync(path.join(source, "CONTENTS.sha256"), "a".repeat(64) + "  shared/stt_api_key\n");
  assert.throws(() => cache.ensurePackage(source, maintenance), /private data/);
  assert.equal(fs.existsSync(maintenance), false);
});
test("pruneCache keeps active package and removes stale versions and staging dirs", t => {
  const { source, maintenance } = fixture(t);
  const active = cache.ensurePackage(source, maintenance);
  const oldVer = path.join(maintenance, "cache", "0.2.0", "oldhash");
  const staleHash = path.join(maintenance, "cache", "0.2.1", "stalehash");
  const staging = path.join(maintenance, "cache", ".staging-leftover");
  for (const dir of [oldVer, staleHash, staging]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dummy.txt"), "old");
  }
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(staleHash, past, past);
  const result = cache.pruneCache(maintenance, { keepPackageRoots: [active.packageRoot], activeVersion: "0.2.1", keepPerVersion: 1 });
  assert.equal(fs.existsSync(active.packageRoot), true);
  assert.equal(fs.existsSync(oldVer), false);
  assert.equal(fs.existsSync(staleHash), false);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(result.removed.length, 3);
});
test("feature-update pruneBackups keeps latest applied + earliest stock original and strips duplicate ledger archive", t => {
  const feature = require("../shared/feature-update.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-prune-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const makeTx = (name, appVersion, sourceHash, state, iso, withDupLedger = false) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.asar.before"), Buffer.alloc(1024, 1));
    if (withDupLedger) {
      const ledgerDir = path.join(dir, "asar-ledger", "windows", appVersion, sourceHash);
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.writeFileSync(path.join(ledgerDir, "app.asar.original"), Buffer.alloc(1024, 2));
      fs.writeFileSync(path.join(ledgerDir, "manifest.json"), "{}");
    }
    fs.writeFileSync(path.join(dir, "feature-manifest.json"), JSON.stringify({
      schema: 1, featureVersion: "0.2.1", app: "C:\\App", appVersion,
      sourceAsarSha256: sourceHash, patchedAsarSha256: "f".repeat(64),
      createdAt: iso, appliedAt: iso, state,
    }));
    return dir;
  };
  const oldVer = makeTx("v0.2.1-oldver", "1.19.4", "1".repeat(64), "applied", "2026-01-01T00:00:00.000Z");
  const stockOrig = makeTx("v0.2.1-stock", "1.19.5", "a".repeat(64), "applied", "2026-02-01T00:00:00.000Z", true);
  const middle = makeTx("v0.2.1-mid", "1.19.5", "b".repeat(64), "applied", "2026-02-02T00:00:00.000Z");
  const latest = makeTx("v0.2.1-latest", "1.19.5", "c".repeat(64), "applied", "2026-02-03T00:00:00.000Z", true);
  const failed = makeTx("v0.2.1-fail", "1.19.5", "d".repeat(64), "apply-failed", "2026-02-04T00:00:00.000Z");

  const dry = feature.pruneBackups(root, { currentAppVersion: "1.19.5", keepApplied: 1, dryRun: true });
  assert.equal(dry.removed.length, 3);
  assert.equal(fs.existsSync(middle), true);

  const realRun = feature.pruneBackups(root, { currentAppVersion: "1.19.5", keepApplied: 1 });
  assert.equal(realRun.removed.length, 3);
  assert.equal(fs.existsSync(stockOrig), true);
  assert.equal(fs.existsSync(latest), true);
  assert.equal(fs.existsSync(oldVer), false);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(failed), false);
  // Duplicate app.asar.original in kept transactions must be stripped while app.asar.before & manifest stay intact.
  assert.equal(fs.existsSync(path.join(latest, "app.asar.before")), true);
  assert.equal(fs.existsSync(path.join(latest, "asar-ledger", "windows", "1.19.5", "c".repeat(64), "app.asar.original")), false);
  assert.equal(fs.existsSync(path.join(latest, "asar-ledger", "windows", "1.19.5", "c".repeat(64), "manifest.json")), true);
});
