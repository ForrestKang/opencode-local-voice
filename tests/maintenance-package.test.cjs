"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cache = require("../shared/maintenance-package.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cache-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "download"), maintenance = path.join(root, "maintenance");
  for (const name of cache.REQUIRED_FILES) { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name === "VERSION" ? "0.2.0\n" : "fixture:" + name); }
  return { root, source, maintenance };
}
test("source installation remains verifiable after its downloaded directory is removed", t => {
  const { source, maintenance } = fixture(t), saved = cache.ensurePackage(source, maintenance);
  fs.rmSync(source, { recursive: true, force: true });
  assert.equal(cache.verifyPackage(saved.packageRoot, saved.manifestSha256).featureVersion, "0.2.0");
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
