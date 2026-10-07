"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");

function fixture(options = {}) {
  const token = crypto.randomBytes(32).toString("base64url"), events = [], jobs = new Map();
  const root = { crypto: options.insecure ? undefined : crypto.webcrypto };
  const fetch = async (address, request) => {
    const url = new URL(address); events.push({ url, ...request });
    if (url.pathname === "/health") return Response.json({ service: options.wrong ? "other" : "opencode-local-voice", protocol: 1,
      proof: crypto.createHmac("sha256", token).update(url.searchParams.get("challenge")).digest("hex") });
    assert.equal(request.headers.Authorization, "Bearer " + token);
    if (url.pathname === "/v1/text") { const body = JSON.parse(request.body); return Response.json({ text: "preview", raw_text: body.text, local_text: "local", processing_warning: null }); }
    if (url.pathname === "/v1/rewrite/test") return Response.json({ ok: true, message: "connected" });
    if (url.pathname.endsWith("/use-local")) return Response.json({ id: url.pathname.split("/")[3], state: "done", text: "local" });
    if (request.method === "POST") {
      const id = request.headers["X-Job-Id"];
      if (!options.unaccepted) jobs.set(id, { id, state: "done", text: "Web draft", raw_text: "raw speech", local_text: "local draft", processing_warning: "AI unavailable", timings: { audio_seconds: 2 } });
      if (options.submitFailed) throw new Error("response lost after upload");
      return Response.json({ id, state: "queued" });
    }
    const id = url.pathname.split("/").pop();
    if (request.method === "DELETE") { jobs.set(id, { id, state: "cancelled" }); return Response.json({ id, state: "cancelled" }); }
    return Response.json(jobs.get(id) || { beam_size: 1 });
  };
  const context = { window: root, URL, ArrayBuffer, Uint8Array, TextEncoder, AbortController, Set, Object, Date, setTimeout, clearTimeout, fetch };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/browser-transport.js"), "utf8"), context);
  return { api: root.createOcVoiceTransport({ url: "http://127.0.0.1:47832", token }), root, events, jobs };
}
test("Web adapter verifies identity before auth and preserves local draft result/progress", async () => {
  const f = fixture(), id = crypto.randomUUID(), progress = [];
  const remove = f.api.onProgress(value => progress.push(value));
  const result = await f.api.transcribe(new Uint8Array(100), "audio/wav", id); remove();
  assert.equal(result.text, "Web draft"); assert.equal(progress[0].state, "submitting"); assert.equal(progress.at(-1).state, "done");
  assert.deepEqual([result.raw_text, result.local_text, result.processing_warning], ["raw speech", "local draft", "AI unavailable"]);
  assert.equal(f.events[0].headers.Authorization, undefined);
  assert.ok(f.events.every(e => e.credentials === "omit" && e.cache === "no-store"));
});
test("Web text tools share desktop routes without persisting temporary preview options", async () => {
  const f = fixture(); assert.equal((await f.api.previewText("sample", { text_mode: "clean" }, "fixture-key")).text, "preview");
  const request = f.events.find(e => e.url.pathname === "/v1/text");
  assert.deepEqual(JSON.parse(request.body), { text: "sample", config: { text_mode: "clean" }, rewrite_api_key: "fixture-key" });
  assert.equal((await f.api.testRewrite({ rewrite_model: "fixture" })).ok, true);
  const id = crypto.randomUUID(); assert.equal((await f.api.useLocal(id)).text, "local");
  assert.ok(!f.events.some(e => e.url.pathname === "/v1/config"));
});
test("Web adapter rejects remote endpoints and foreign service without leaking token/audio", async () => {
  const f = fixture({ wrong: true });
  assert.throws(() => f.root.createOcVoiceTransport({ token: "abc", url: "https://example.com" }), e => e.code === "INVALID_ENDPOINT");
  await assert.rejects(f.api.transcribe(new Uint8Array(100), "audio/wav", crypto.randomUUID()), e => e.code === "SERVICE_IDENTITY");
  assert.equal(f.events.length, 1); assert.equal(f.events[0].headers.Authorization, undefined);
});
test("Web lost acknowledgement recovers the accepted job without duplicate upload", async () => {
  const f = fixture({ submitFailed: true }), id = crypto.randomUUID(), progress = [];
  f.api.onProgress(value => progress.push(value.state));
  assert.equal((await f.api.transcribe(new Uint8Array(100), "audio/wav", id)).text, "Web draft");
  assert.deepEqual(progress, ["submitting", "recovering", "done"]);
  assert.equal(f.jobs.get(id).state, "done"); assert.equal(f.events.filter(e => e.method === "POST").length, 1);
  assert.equal(f.events.filter(e => e.method === "DELETE").length, 0);
});
test("Web unaccepted upload failure still cancels its job id", async () => {
  const f = fixture({ submitFailed: true, unaccepted: true }), id = crypto.randomUUID();
  await assert.rejects(f.api.transcribe(new Uint8Array(100), "audio/wav", id), e => e.code === "LOCAL_SERVICE_UNAVAILABLE");
  assert.equal(f.jobs.get(id).state, "cancelled");
});
test("Web adapter blocks insecure contexts and empty audio", async () => {
  const f = fixture({ insecure: true });
  await assert.rejects(f.api.getConfig(), e => e.code === "SECURE_CONTEXT_REQUIRED");
  await assert.rejects(f.api.transcribe(new Uint8Array(0), "audio/wav", crypto.randomUUID()), e => e.code === "INVALID_AUDIO");
  assert.equal(f.events.length, 0);
});
