"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const patcher = require("../shared/patch-package.cjs");
const { nativeUpdaterFixture } = require("./fixtures/asar.cjs");

function controller(trace, failure) {
  const shim = {
    async prepare(version) { trace.push("prepare:" + version); if (failure === "prepare") throw Object.assign(new Error("prepare failed"), { ocVoiceUpdateNotified: true }); if (failure === "unnotified") throw new Error("unexpected prepare failure"); return { id: "prepared" }; },
    commit(token) { assert.equal(token.id, "prepared"); trace.push("commit"); if (failure === "commit") throw new Error("commit failed"); },
    cancel(token) { assert.equal(token.id, "prepared"); trace.push("cancel"); },
  };
  const context = { autoUpdater: {}, require2: name => name === "electron" ? {} : shim };
  vm.createContext(context);
  vm.runInContext(patcher.patchUpdaterSource(nativeUpdaterFixture) + "\nglobalThis.create = createUpdaterController;", context);
  return context.create({ async stop() { trace.push("stop"); if (failure === "stop") throw new Error("stop failed"); },
    backend: { quitAndInstall() { trace.push("official-update"); } } });
}

test("native updater prepares the recovery process before stopping the backend", async () => {
  const trace = [];
  await controller(trace).install();
  assert.deepEqual(trace, ["prepare:1.2.4", "stop", "commit", "official-update"]);
});

test("notified preparation failure resolves IPC and leaves the native backend ready for retry", async () => {
  const trace = [];
  const instance = controller(trace, "prepare");
  await instance.install();
  await instance.install();
  assert.deepEqual(trace, ["prepare:1.2.4", "prepare:1.2.4"]);
});

test("an unnotified preparation failure is not silently swallowed", async () => {
  const trace = [];
  await assert.rejects(controller(trace, "unnotified").install(), /unexpected prepare failure/);
  assert.deepEqual(trace, ["prepare:1.2.4"]);
});

for (const failure of ["stop", "commit"]) test(failure + " failure cancels the one-time recovery and does not install", async () => {
  const trace = [];
  await assert.rejects(controller(trace, failure).install(), new RegExp(failure + " failed"));
  assert.equal(trace.at(-1), "cancel");
  assert.equal(trace.includes("official-update"), false);
});

test("updater hooks are idempotent and reject unknown or partial layouts", () => {
  const once = patcher.patchUpdaterSource(nativeUpdaterFixture);
  assert.equal(patcher.patchUpdaterSource(once), once);
  assert.ok(once.includes("autoUpdater.autoInstallOnAppQuit = false;"));
  assert.ok(once.includes("autoUpdater.autoDownload = false;"));
  assert.throws(() => patcher.patchUpdaterSource(nativeUpdaterFixture.replace("await input.stop()", "await input.newStop()")), /unsupported OpenCode updater layout/);
  assert.throws(() => patcher.patchUpdaterSource(once.replace("/*oc-voice-update:install:end*/", "")), /partial voice updater hook/);
  assert.throws(() => patcher.patchUpdaterSource(nativeUpdaterFixture + nativeUpdaterFixture), /unsupported OpenCode updater layout/);
});
