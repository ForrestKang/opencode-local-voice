"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-tui-build-"));
let compiled;
try {
  const root = path.resolve(__dirname, "..");
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json", "--noEmit", "false", "--rootDir", ".", "--outDir", buildDirectory], { cwd: root, encoding: "utf8" });
  compiled = fs.readFileSync(path.join(buildDirectory, "extras/voice-input.js"), "utf8")
    .replace(/import \{ ([^}]+) \} from "([^"]+)";/g, 'const { $1 } = require("$2");')
    .replace("const require = createRequire(import.meta.url)", "const bridgeRequire = createRequire(__filename)")
    .replace("require(bridgeFile)", "bridgeRequire(bridgeFile)").replace("export default", "exports.default =");
} finally { fs.rmSync(buildDirectory, { recursive: true, force: true }); }
async function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-voice-tui-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recordings = [], appended = [], cancellations = [], controller = new AbortController(); let finishJob;
  const client = {
    getConfig: async () => { if (options.abortOnConfig) controller.abort(); return { max_seconds: 120, warmup_on_record: true }; }, status: async () => ({ state: "fake" }), warmup: async () => ({}),
    transcribe: async (audio, mime, id) => {
      assert.equal(audio.toString("ascii", 0, 4), "RIFF"); assert.equal(audio.readUInt32LE(24), 16000); assert.equal(mime, "audio/wav");
      if (options.pending) return new Promise(resolve => { finishJob = resolve; });
      if (options.abortOnResult) controller.abort();
      return { text: "TUI draft" };
    },
    cancel: async id => { cancellations.push(id); finishJob?.({ error: "cancelled", code: "CANCELLED" }); },
  };
  const spawn = (_, args) => {
    recordings.push(args); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      if (options.missingFfmpeg) { child.emit("error", new Error("ENOENT")); return; }
      if (args.includes("-list_devices")) child.stderr.emit("data", Buffer.from('"Fake Microphone" (audio)\n'));
      else child.stdout.emit("data", Buffer.alloc(3200));
      child.emit("close", args.includes("-list_devices") ? 1 : 0);
    }); return child;
  };
  const schema = () => { const value = {}; for (const name of ["optional", "default", "describe", "int", "min", "max"]) value[name] = () => value; return value; };
  const tool = definition => definition; tool.schema = { enum: schema, number: schema, string: schema };
  const load = name => {
    if (name === "@opencode-ai/plugin") return { tool };
    if (name === "node:child_process") return { spawn };
    if (name === "node:module") return { createRequire: () => () => ({ createClient: () => client }) };
    if (name === "node:os") return { homedir: () => home };
    return require(name);
  };
  const module = { exports: {} }; vm.runInNewContext(compiled, { module, exports: module.exports, require: load, __filename: __filename,
    process: { platform: options.platform || "win32", env: {} }, Buffer, setTimeout, clearTimeout, console });
  const plugin = await module.exports.default({ client: { tui: { appendPrompt: async value => { if (options.appendFails) throw new Error("append API unavailable"); appended.push(value); } } } });
  return { execute: args => plugin.tool.voice_input.execute({ seconds: 1, action: "record", ...args }, { abort: controller.signal }), recordings, appended, cancellations, controller };
}
test("TUI records in memory and appends only to the draft", async t => {
  const f = await fixture(t); assert.match(await f.execute({}), /Transcribed and appended/);
  assert.equal(f.recordings.length, 2); assert.equal(f.appended[0].body.text, "TUI draft"); assert.equal(f.appended[0].throwOnError, true);
  assert.ok(f.recordings[1].includes("pipe:1"));
});
test("TUI switches/status do not capture and disabled state persists", async t => {
  const f = await fixture(t); await f.execute({ action: "status" }); await f.execute({ action: "off" });
  assert.match(await f.execute({}), /disabled/); await f.execute({ action: "toggle" });
  assert.equal(f.recordings.length, 0); assert.equal(f.appended.length, 0);
});
test("TUI abort cancels an active backend job", async t => {
  const f = await fixture(t, { pending: true }); const pending = f.execute({ mic: "Fake Microphone" });
  while (!f.recordings.length) await new Promise(resolve => setTimeout(resolve, 1));
  await new Promise(resolve => setTimeout(resolve, 20)); f.controller.abort();
  assert.match(await pending, /cancelled/); assert.equal(f.cancellations.length, 1); assert.equal(f.appended.length, 0);
});
test("TUI retains recognized text when host draft API fails", async t => {
  const f = await fixture(t, { appendFails: true, platform: "linux" });
  assert.match(await f.execute({}), /Copy this text into your draft: TUI draft/);
  assert.ok(f.recordings[0].includes("pulse"));
});

test("TUI abort during configuration does not start microphone discovery or recording", async t => {
  const f = await fixture(t, { abortOnConfig: true });
  assert.match(await f.execute({}), /cancelled/);
  assert.equal(f.recordings.length, 0); assert.equal(f.appended.length, 0);
});

test("TUI abort racing a completed transcript does not append cancelled text", async t => {
  const f = await fixture(t, { abortOnResult: true });
  assert.match(await f.execute({ mic: "Fake Microphone" }), /cancelled/);
  assert.equal(f.appended.length, 0); assert.equal(f.cancellations.length, 1);
});
test("TUI missing FFmpeg becomes a recoverable tool error", async t => {
  const f = await fixture(t, { missingFfmpeg: true, platform: "darwin" });
  assert.match(await f.execute({}), /FFmpeg failed to start/); assert.equal(f.appended.length, 0);
});
