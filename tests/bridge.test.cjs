"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { install, createClient, trustedSender, allowMedia } = require("../shared/desktop-bridge.cjs");

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-bridge-"));
  const token = crypto.randomBytes(32).toString("base64url"), events = [], jobs = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"); events.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
    const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/health") return json(200, overrides.wrong ? { service: "other", protocol: 1, proof: "0".repeat(64) } : { service: "opencode-local-voice", protocol: 1, proof: crypto.createHmac("sha256", token).update(url.searchParams.get("challenge")).digest("hex") });
    if (req.headers.authorization !== "Bearer " + token) return json(401, { error: "unauthorized" });
    if (url.pathname === "/v1/config") return json(200, { beam_size: 1, max_seconds: 120, port: server.address().port });
    if (url.pathname === "/v1/status") return json(200, { model_state: "ready", device: "fake" });
    if (req.method === "POST" && ["/v1/text", "/v1/rewrite/test"].includes(url.pathname)) {
      let data = ""; req.on("data", chunk => { data += chunk; }); req.on("end", () => { const body = JSON.parse(data); events.at(-1).body = body; json(200, url.pathname === "/v1/text" ? { raw_text: body.text, local_text: "local", text: "preview", processing_warning: null, timings: { local_seconds: 0.01 } } : { ok: true, message: "connected" }); }); return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/use-local")) { const id = url.pathname.split("/")[3]; jobs.set(id, { id, state: "done", text: "local fallback", raw_text: "raw speech", local_text: "local fallback", processing_warning: "AI skipped", timings: { rewrite_seconds: 0.02 } }); return json(200, jobs.get(id)); }
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      const id = req.headers["x-job-id"]; let size = 0;
      req.on("data", data => { size += data.length; }); req.on("end", () => {
        if (overrides.uploadRejected) return json(400, { error: "invalid WAV", code: "invalid_audio" });
        if (!overrides.unacceptedReset) jobs.set(id, { id, state: overrides.busy ? "transcribing" : "done", text: "dictated draft", ...(overrides.metadata ? { raw_text: "raw speech", local_text: "local draft", processing_warning: "AI unavailable" } : {}), timings: { audio_seconds: 1 } });
        if (overrides.lostAck || overrides.unacceptedReset) return req.socket.destroy();
        json(202, { id, state: "queued", size });
      }); return;
    }
    const id = url.pathname.split("/").pop();
    if (req.method === "DELETE") { jobs.set(id, { id, state: "cancelled" }); return json(200, { id, state: "cancelled" }); }
    if (jobs.has(id)) return json(overrides.pollFails ? 500 : 200, overrides.pollFails ? { error: "poll failed" } : jobs.get(id));
    return json(404, { error: "not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ port: server.address().port })); fs.writeFileSync(path.join(directory, "token"), token);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  // A late cancellation can race fixture server teardown. Keep all fallback
  // runtime paths inside the fixture so it cannot spawn the user's real daemon.
  return { client: createClient({ voiceHome: directory, home: directory, jobTimeout: overrides.timeout || 1000 }), directory, events, jobs };
}

test("identity challenge precedes credentials and audio; local job returns timings", async t => {
  const f = await fixture(t); assert.equal((await f.client.getConfig()).beam_size, 1);
  const progress = [], id = crypto.randomUUID();
  const result = await f.client.transcribe(Buffer.alloc(100), "audio/wav", id, state => progress.push(state));
  assert.equal(result.text, "dictated draft"); assert.equal(result.timings.audio_seconds, 1);
  assert.ok(f.events.filter(e => e.path === "/health").every(e => !e.auth)); assert.equal(progress.at(-1).state, "done");
});
test("lost upload acknowledgement resumes the accepted job without another upload or a false error", async t => {
  const f = await fixture(t, { lostAck: true }), progress = [], id = crypto.randomUUID();
  const result = await f.client.transcribe(Buffer.alloc(100), "audio/wav", id, value => progress.push(value.state));
  assert.equal(result.text, "dictated draft"); assert.equal(result.id, id);
  assert.deepEqual(progress, ["submitting", "recovering", "done"]);
  assert.equal(f.events.filter(e => e.method === "POST" && e.path === "/v1/jobs").length, 1);
  assert.equal(f.events.filter(e => e.method === "DELETE").length, 0);
});
test("unaccepted upload failure still cancels its id and preserves the error", async t => {
  const f = await fixture(t, { unacceptedReset: true }), id = crypto.randomUUID();
  await assert.rejects(f.client.transcribe(Buffer.alloc(100), "audio/wav", id), e => e.code === "ECONNRESET");
  assert.equal(f.jobs.get(id).state, "cancelled");
  assert.equal(f.events.filter(e => e.method === "POST" && e.path === "/v1/jobs").length, 1);
});
test("invalid audio is a real failure and does not trigger acknowledgement recovery", async t => {
  const f = await fixture(t, { uploadRejected: true }), id = crypto.randomUUID();
  await assert.rejects(f.client.transcribe(Buffer.alloc(100), "audio/wav", id), e => e.code === "invalid_audio");
  assert.equal(f.events.filter(e => e.method === "GET" && e.path === "/v1/jobs/" + id).length, 0);
});
test("unverified port receives neither bearer token nor audio", async t => {
  const f = await fixture(t, { wrong: true });
  await assert.rejects(f.client.transcribe(Buffer.alloc(100), "audio/wav", crypto.randomUUID()), e => e.code === "SERVICE_IDENTITY");
  assert.equal(f.events.length, 1); assert.equal(f.events[0].path, "/health"); assert.equal(f.events[0].auth, undefined);
});
test("desktop text preview and rewrite connection use authenticated routes and retain metadata", async t => {
  const f = await fixture(t, { metadata: true });
  const result = await f.client.transcribe(Buffer.alloc(100), "audio/wav", crypto.randomUUID());
  assert.deepEqual([result.raw_text, result.local_text, result.processing_warning], ["raw speech", "local draft", "AI unavailable"]);
  const preview = await f.client.previewText("sample", { text_mode: "clean" }, "temporary-fixture-key"); assert.equal(preview.text, "preview");
  assert.deepEqual(f.events.find(e => e.path === "/v1/text").body, { text: "sample", config: { text_mode: "clean" }, rewrite_api_key: "temporary-fixture-key" });
  assert.equal((await f.client.testRewrite({ rewrite_model: "fixture" })).ok, true);
  const wrong = await fixture(t, { wrong: true }); await assert.rejects(wrong.client.previewText("sample", {}), e => e.code === "SERVICE_IDENTITY"); assert.equal(wrong.events.length, 1);
});
test("timeout explicitly cancels the backend job", async t => {
  const f = await fixture(t, { busy: true, timeout: 80 }), id = crypto.randomUUID();
  const result = await f.client.transcribe(Buffer.alloc(100), "audio/wav", id);
  assert.equal(result.code, "JOB_TIMEOUT"); assert.equal(f.jobs.get(id).state, "cancelled");
});
test("cancellation before upload never submits audio", async t => {
  const f = await fixture(t), id = crypto.randomUUID(); await f.client.cancel(id);
  const result = await f.client.transcribe(Buffer.alloc(100), "audio/wav", id); assert.equal(result.code, "CANCELLED");
  assert.ok(!f.events.some(e => e.method === "POST"));
});
test("asynchronous spawn error is a voice error instead of an unhandled child event", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-spawn-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, "python"), server = path.join(directory, "server.py"); fs.writeFileSync(python, ""); fs.writeFileSync(server, "");
  const client = createClient({ voiceHome: directory, python, server, startupTimeout: 500,
    request: () => { const req = new EventEmitter(); req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); req.destroy = () => {}; return req; },
    spawn: () => { const proc = new EventEmitter(); proc.exitCode = null; proc.stderr = new EventEmitter(); setImmediate(() => proc.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))); return proc; } });
  await assert.rejects(client.ensure(), e => e.code === "SERVICE_START_FAILED");
});
test("simultaneous service startup accepts the other client's proven winner", async t => {
  const f = await fixture(t); let probes = 0;
  const python = path.join(f.directory, "python"), server = path.join(f.directory, "server.py"); fs.writeFileSync(python, ""); fs.writeFileSync(server, "");
  const client = createClient({ voiceHome: f.directory, python, server,
    request: (...args) => {
      if (++probes > 2) return http.request(...args);
      const req = new EventEmitter(); req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); req.destroy = () => {}; return req;
    },
    spawn: () => { const proc = new EventEmitter(); proc.exitCode = null; setImmediate(() => proc.emit("error", Object.assign(new Error("other client won"), { code: "EADDRINUSE" }))); return proc; },
  });
  assert.equal((await client.ensure()).service, "opencode-local-voice"); assert.equal(probes, 3);
});
test("IPC and microphone permission reject foreign pages, subframes and video capture", () => {
  const frame = { url: "oc://renderer/index.html" }, sender = { mainFrame: frame, getURL: () => frame.url };
  assert.equal(trustedSender({ sender, senderFrame: frame }), true);
  assert.equal(trustedSender({ sender, senderFrame: { url: frame.url } }), false);
  assert.equal(allowMedia(sender, "media", { mediaTypes: ["audio"], requestingUrl: frame.url }), true);
  assert.equal(allowMedia(sender, "media", { mediaTypes: ["audio", "video"] }), false);
  assert.equal(allowMedia(sender, "media", {}), false);
  assert.equal(allowMedia({ getURL: () => "https://attacker.invalid" }, "media", { mediaTypes: ["audio"] }), false);
  assert.equal(allowMedia({ getURL: () => "file:///tmp/foreign/out/renderer/index.html" }, "media", { mediaTypes: ["audio"] }), false);
});
for (const platform of ["win32", "darwin", "linux"]) {
  test(`cold startup on ${platform} keeps shared service lifetime without a Windows console`, async t => {
    const f = await fixture(t); let probes = 0, launch, unrefCalls = 0;
    const python = path.join(f.directory, "python.exe"), windowless = path.join(f.directory, "pythonw.exe"), server = path.join(f.directory, "server.py");
    fs.writeFileSync(python, ""); fs.writeFileSync(server, "");
    fs.writeFileSync(windowless, "");
    const client = createClient({ voiceHome: f.directory, python, server, platform,
      request: (...args) => {
        if (++probes > 1) return http.request(...args);
        const req = new EventEmitter(); req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); req.destroy = () => {}; return req;
      },
      spawn: (file, args, options) => {
        launch = { file, args, options };
        const proc = new EventEmitter(); proc.exitCode = null; proc.unref = () => { unrefCalls++; }; return proc;
      }
    });
    assert.equal((await client.ensure()).service, "opencode-local-voice");
    assert.equal(launch.file, platform === "win32" ? windowless : python); assert.deepEqual(launch.args, [server, "--serve"]);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.detached, true);
    assert.equal(launch.options.stdio[0], "ignore");
    assert.equal(typeof launch.options.stdio[1], "number");
    assert.equal(launch.options.stdio[1], launch.options.stdio[2]);
    assert.equal(unrefCalls, 1);
    client.close(); assert.equal((await client.status()).model_state, "ready");
  });
}
test("Windows refuses a missing windowless interpreter instead of launching a console", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-windowless-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, "python.exe"), server = path.join(directory, "server.py");
  fs.writeFileSync(python, ""); fs.writeFileSync(server, "");
  const client = createClient({ voiceHome: directory, platform: "win32", python, server,
    request: () => { const req = new EventEmitter(); req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))); req.destroy = () => {}; return req; },
    spawn: () => { assert.fail("A console interpreter must not be started"); } });
  await assert.rejects(client.ensure(), e => e.code === "SERVICE_NOT_INSTALLED");
});

test("cancelling after the backend has exited never starts another daemon", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-cancel-exited-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const python = path.join(directory, "pythonw.exe"), server = path.join(directory, "server.py");
  for (const file of [python, server]) fs.writeFileSync(file, "fixture\n");
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ port: 47832 }));
  fs.writeFileSync(path.join(directory, "token"), crypto.randomBytes(32).toString("base64url"));
  let spawns = 0;
  const client = createClient({ voiceHome: directory, home: directory, python, server, platform: "win32",
    request: () => { const req = new EventEmitter(); req.end = () => setImmediate(() => req.emit("error", Object.assign(new Error("backend exited"), { code: "ECONNREFUSED" }))); req.destroy = () => {}; return req; },
    spawn: () => { spawns++; throw new Error("cancellation must not start a service"); } });
  await assert.rejects(client.cancel(crypto.randomUUID()), e => e.code === "ECONNREFUSED");
  assert.equal(spawns, 0);
});
test("polling transport failure cancels the accepted job", async t => {
  const f = await fixture(t, { pollFails: true }), id = crypto.randomUUID();
  await assert.rejects(f.client.transcribe(Buffer.alloc(100), "audio/wav", id), /poll failed/);
  assert.equal(f.jobs.get(id).state, "cancelled");
});
test("one IPC window cannot cancel another window's job", async t => {
  const f = await fixture(t, { busy: true }), handlers = new Map(), app = new EventEmitter();
  delete global.__ocVoiceV2; t.after(() => { delete global.__ocVoiceV2; });
  install({ app, ipcMain: { removeHandler: name => handlers.delete(name), handle: (name, fn) => handlers.set(name, fn) } }, { voiceHome: f.directory, home: f.directory });
  const sender = id => { const value = new EventEmitter(); value.id = id; value.mainFrame = { url: "oc://renderer/index.html" }; value.getURL = () => value.mainFrame.url; value.isDestroyed = () => false; value.send = () => {}; return value; };
  const one = sender(1), two = sender(2), id = crypto.randomUUID();
  const event = value => ({ sender: value, senderFrame: value.mainFrame });
  const pending = handlers.get("oc-voice:transcribe")(event(one), Buffer.alloc(100), "audio/wav", id);
  while (!f.jobs.has(id)) await new Promise(resolve => setTimeout(resolve, 5));
  const refused = await handlers.get("oc-voice:cancel")(event(two), id); assert.equal(refused.code, "JOB_OWNER");
  const refusedLocal = await handlers.get("oc-voice:use-local")(event(two), id); assert.equal(refusedLocal.code, "JOB_OWNER");
  assert.equal(f.jobs.get(id).state, "transcribing");
  await handlers.get("oc-voice:cancel")(event(one), id); assert.equal((await pending).code, "CANCELLED");
});
for (const shutdownEvent of ["destroyed", "will-quit"]) {
  test(`desktop ${shutdownEvent} cancels only its in-flight transcription and releases the owner listener`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { busy: true }), handlers = new Map(), app = new EventEmitter();
    delete global.__ocVoiceV2; t.after(() => { delete global.__ocVoiceV2; });
    install({ app, ipcMain: { removeHandler: name => handlers.delete(name), handle: (name, fn) => handlers.set(name, fn) } }, { voiceHome: f.directory, home: f.directory });
    const owner = new EventEmitter(); owner.id = 101; owner.mainFrame = { url: "oc://renderer/index.html" };
    owner.getURL = () => owner.mainFrame.url; owner.isDestroyed = () => shutdownEvent === "destroyed"; owner.send = () => {};
    const id = crypto.randomUUID(), pending = handlers.get("oc-voice:transcribe")({ sender: owner, senderFrame: owner.mainFrame }, Buffer.alloc(100), "audio/wav", id);
    const deadline = Date.now() + 2000;
    while (!f.jobs.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.jobs.has(id));
    if (shutdownEvent === "destroyed") owner.emit("destroyed"); else app.emit("will-quit");
    assert.equal((await pending).code, "CANCELLED");
    // The client tombstone suppresses insertion before the asynchronous DELETE
    // finishes. Observe the backend acknowledgement instead of assuming order.
    const cancelledDeadline = Date.now() + 2000;
    while (f.jobs.get(id).state !== "cancelled" && Date.now() < cancelledDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.jobs.get(id).state, "cancelled");
    assert.equal(owner.listenerCount("destroyed"), 0);
  });
}

test("IPC preview enforces size and sender checks; job owner can finish with local result", async t => {
  const f = await fixture(t, { busy: true }), handlers = new Map(), app = new EventEmitter();
  delete global.__ocVoiceV2; t.after(() => { delete global.__ocVoiceV2; });
  install({ app, ipcMain: { removeHandler: name => handlers.delete(name), handle: (name, fn) => handlers.set(name, fn) } }, { voiceHome: f.directory, home: f.directory });
  const sender = new EventEmitter(); sender.id = 3; sender.mainFrame = { url: "oc://renderer/index.html" }; sender.getURL = () => sender.mainFrame.url; sender.isDestroyed = () => false; sender.send = () => {};
  const event = { sender, senderFrame: sender.mainFrame };
  assert.equal((await handlers.get("oc-voice:preview-text")(event, "x".repeat(10001))).code, "INVALID_TEXT");
  assert.equal((await handlers.get("oc-voice:preview-text")({ sender, senderFrame: {} }, "x")).code, "UNTRUSTED_SENDER");
  const id = crypto.randomUUID(), pending = handlers.get("oc-voice:transcribe")(event, Buffer.alloc(100), "audio/wav", id);
  while (!f.jobs.has(id)) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await handlers.get("oc-voice:use-local")(event, id)).text, "local fallback");
  assert.equal((await pending).local_text, "local fallback");
});
test("closing a client cancels only its own jobs while the shared service stays usable", async t => {
  const f = await fixture(t, { busy: true }), other = createClient({ voiceHome: f.directory, home: f.directory });
  const id = crypto.randomUUID(), otherId = crypto.randomUUID();
  const pending = f.client.transcribe(Buffer.alloc(100), "audio/wav", id);
  const otherPending = other.transcribe(Buffer.alloc(100), "audio/wav", otherId);
  while (!f.jobs.has(id) || !f.jobs.has(otherId)) await new Promise(resolve => setTimeout(resolve, 5));
  f.client.close();
  assert.equal((await pending).code, "CANCELLED"); assert.equal(f.jobs.get(otherId).state, "transcribing");
  assert.equal((await other.status()).model_state, "ready");
  await other.cancel(otherId); assert.equal((await otherPending).code, "CANCELLED");
});
