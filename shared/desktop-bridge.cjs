"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { pathToFileURL } = require("node:url");

const SERVICE = "opencode-local-voice";
const PROTOCOL = 1;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function voiceError(code, message) { return Object.assign(new Error(message), { code }); }
function safeResult(error) { return { error: String(error.message || error), code: error.code || "VOICE_ERROR" }; }
function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id); }

function trustedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "oc:" && url.hostname === "renderer") return true;
    if (url.protocol === "file:") {
      url.search = ""; url.hash = "";
      // In the installed archive this module lives at out/main. Bind file
      // access to its sibling renderer, rather than matching arbitrary paths.
      return url.href === pathToFileURL(path.resolve(__dirname, "../renderer/index.html")).href;
    }
    const dev = process.env.ELECTRON_RENDERER_URL;
    return !!dev && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.origin === new URL(dev).origin;
  } catch (_) { return false; }
}
function trustedSender(event) {
  return !!(event && event.sender && event.senderFrame && event.senderFrame === event.sender.mainFrame &&
    trustedUrl(event.senderFrame.url) && trustedUrl(event.sender.getURL()));
}
function allowMedia(webContents, permission, details = {}) {
  if (permission !== "media" || !webContents || !trustedUrl(webContents.getURL())) return false;
  if (details.requestingUrl && !trustedUrl(details.requestingUrl)) return false;
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  return types.length > 0 && types.every(type => type === "audio" || type === "microphone");
}

function createClient(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const voiceHome = options.voiceHome || process.env.OPENCODE_VOICE_HOME || path.join(home, ".config", "opencode", "local-voice");
  const base = path.join(home, ".config", "opencode");
  const configuredPython = options.python || process.env.OPENCODE_VOICE_PYTHON || path.join(base, "whisper-venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  // A Windows venv's console launcher can allocate a terminal for its child
  // even with windowsHide. Use the matching windowless interpreter from the
  // same environment; never fall back to an unrelated global Python.
  const python = platform === "win32" && /^python(?:\d+(?:\.\d+)*)?\.exe$/i.test(path.basename(configuredPython))
    ? path.join(path.dirname(configuredPython), path.basename(configuredPython).replace(/^python/i, "pythonw")) : configuredPython;
  const server = options.server || process.env.OPENCODE_VOICE_SERVER || path.join(base, "whisper", "stt_server.py");
  const spawn = options.spawn || childProcess.spawn;
  const requestImpl = options.request || http.request;
  const startupTimeout = options.startupTimeout || 12000;
  const jobTimeout = options.jobTimeout || 180000;
  let processHandle = null, starting = null, startupFailure = null;
  const cancelled = new Map(), activeJobs = new Set();
  function configOnDisk() {
    let config = {};
    const filename = path.join(voiceHome, "config.json");
    if (fs.existsSync(filename)) {
      try { config = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
      catch (_) { throw voiceError("CONFIG_INVALID", "语音配置文件损坏，请修复 config.json 后重试"); }
    }
    const port = config.port === undefined ? Number(process.env.OPENCODE_STT_LOCAL_PORT || 47832) : config.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw voiceError("CONFIG_INVALID", "语音服务端口无效");
    return { ...config, port };
  }
  function readToken() {
    try {
      const token = fs.readFileSync(path.join(voiceHome, "token"), "utf8").trim();
      if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error("invalid");
      return token;
    } catch (_) { throw voiceError("TOKEN_MISSING", "语音服务凭据不存在或损坏，请先运行安装器"); }
  }
  function request(method, route, body, authenticated = true, timeout = 5000) {
    return new Promise((resolve, reject) => {
      let payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const headers = payload ? { "Content-Length": payload.length, "Content-Type": Buffer.isBuffer(body) ? "audio/wav" : "application/json" } : {};
      let settings;
      try { settings = configOnDisk(); if (authenticated) headers.Authorization = "Bearer " + readToken(); }
      catch (error) { reject(error); return; }
      let settled = false, timer, req;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      try {
        req = requestImpl({ host: "127.0.0.1", port: settings.port, path: route, method, headers, agent: false }, response => {
          const chunks = []; let size = 0;
          response.on("data", chunk => { size += chunk.length; if (size > 1024 * 1024) { req.destroy(); finish(voiceError("BAD_RESPONSE", "语音服务响应过大")); } else chunks.push(Buffer.from(chunk)); });
          response.on("error", error => finish(error));
          response.on("aborted", () => finish(voiceError("BAD_RESPONSE", "语音服务连接提前关闭")));
          response.on("end", () => {
            if (settled) return;
            let result;
            try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch (_) { finish(voiceError("BAD_RESPONSE", "端口上的服务没有返回有效语音协议")); return; }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              const message = typeof result.error === "string" ? result.error : (result.error && result.error.message) || "语音服务请求失败";
              finish(voiceError(result.code || "HTTP_" + response.statusCode, message));
            } else finish(null, result);
          });
        });
        req.on("error", error => finish(error));
        timer = setTimeout(() => { req.destroy(); finish(voiceError("SERVICE_TIMEOUT", "语音服务请求超时")); }, timeout);
        req.end(payload || undefined);
      } catch (error) { finish(error); }
    });
  }
  async function probe() {
    const nonce = crypto.randomBytes(24).toString("hex");
    const response = await request("GET", "/health?challenge=" + nonce, null, false, 1500);
    let token;
    try { token = readToken(); } catch (_) { throw voiceError("SERVICE_IDENTITY", "端口已被其他服务占用，或本地凭据不匹配"); }
    const expected = crypto.createHmac("sha256", token).update(nonce).digest("hex");
    const proof = typeof response.proof === "string" ? response.proof : "";
    if (response.service !== SERVICE || response.protocol !== PROTOCOL || !/^[0-9a-f]{64}$/.test(proof) ||
      !crypto.timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"))) {
      throw voiceError("SERVICE_IDENTITY", "本地端口上的服务身份不匹配，未发送录音或凭据");
    }
    return response;
  }
  function boot() {
    if (processHandle && processHandle.exitCode === null && !startupFailure) return;
    if (!fs.existsSync(python) || !fs.existsSync(server)) throw voiceError("SERVICE_NOT_INSTALLED", "本地语音服务未完整安装，请运行安装器");
    startupFailure = null;
    let logFd;
    try {
      fs.mkdirSync(voiceHome, { recursive: true, mode: 0o700 });
      logFd = fs.openSync(path.join(voiceHome, "service.log"), "a", 0o600);
      // Retain detachment: libuv otherwise kills Windows children on parent
      // exit. pythonw prevents console allocation through the venv launcher.
      processHandle = spawn(python, [server, "--serve"], { windowsHide: true, detached: true,
        stdio: ["ignore", logFd, logFd], env: { ...process.env, OPENCODE_VOICE_HOME: voiceHome } });
      processHandle.on("error", error => { startupFailure = voiceError("SERVICE_START_FAILED", "语音服务启动失败：" + error.code); });
      processHandle.on("exit", code => { if (code && !startupFailure) startupFailure = voiceError("SERVICE_START_FAILED", "语音服务退出，错误码 " + code); });
      processHandle.unref?.();
    } catch (error) { startupFailure = voiceError("SERVICE_START_FAILED", "语音服务无法启动：" + (error.code || error.message)); throw startupFailure; }
    finally { if (logFd !== undefined) fs.closeSync(logFd); }
  }
  async function ensure() {
    if (starting) return starting;
    starting = (async () => {
      try { return await probe(); }
      catch (error) {
        if (!["ECONNREFUSED", "ECONNRESET", "SERVICE_TIMEOUT"].includes(error.code)) throw error;
      }
      boot();
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        if (startupFailure) {
          // Another client may win a simultaneous bind. Trust its HMAC proof,
          // rather than treating our losing child as a failure of the service.
          try { return await probe(); }
          catch (error) { if (error.code === "SERVICE_IDENTITY") throw error; throw startupFailure; }
        }
        await delay(100);
        try { return await probe(); }
        catch (error) { if (!["ECONNREFUSED", "ECONNRESET", "SERVICE_TIMEOUT"].includes(error.code)) throw error; }
      }
      throw voiceError("SERVICE_START_TIMEOUT", "语音服务未及时就绪，请检查服务日志");
    })();
    try { return await starting; } finally { starting = null; }
  }
  function isCancelled(id) {
    for (const [key, stamp] of cancelled) if (Date.now() - stamp > 300000) cancelled.delete(key);
    return cancelled.has(id);
  }
  async function call(method, route, body) { await ensure(); return request(method, route, body); }
  async function cancel(id) {
    if (!validId(id)) throw voiceError("INVALID_JOB", "转写任务 ID 无效");
    cancelled.set(id, Date.now());
    // Cancellation may race service/window shutdown. Verify the existing
    // service without restarting a daemon just to cancel a vanished job.
    await probe();
    return request("DELETE", "/v1/jobs/" + id);
  }
  async function transcribe(bytes, mime = "audio/wav", id = crypto.randomUUID(), progress = () => {}) {
    if (!validId(id)) throw voiceError("INVALID_JOB", "转写任务 ID 无效");
    if (mime !== "audio/wav") throw voiceError("INVALID_AUDIO", "语音服务需要 WAV 格式");
    const audio = Buffer.from(bytes);
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw voiceError("AUDIO_TOO_LARGE", "录音为空或超过大小限制");
    await ensure();
    if (isCancelled(id)) return { error: "转写已取消", code: "CANCELLED" };
    // The id travels in the URL as well as the explicit header; request-local
    // headers avoid global mutable ids when several windows submit at once.
    const savedRequest = requestImpl;
    const settings = configOnDisk();
    const deadline = Date.now() + jobTimeout;
    activeJobs.add(id);
    try {
    try { progress({ id, state: "submitting" }); } catch (_) {}
    const created = await new Promise((resolve, reject) => {
      let req, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { if (req) req.destroy(); finish(voiceError("SERVICE_TIMEOUT", "录音提交超时")); }, 10000);
      try {
        req = savedRequest({ host: "127.0.0.1", port: settings.port, path: "/v1/jobs", method: "POST", agent: false,
          headers: { Authorization: "Bearer " + readToken(), "X-Job-Id": id, "Content-Type": "audio/wav", "Content-Length": audio.length } }, response => {
          let data = "";
          response.on("data", chunk => { data += chunk; if (data.length > 65536) { req.destroy(); finish(voiceError("BAD_RESPONSE", "提交响应过大")); } });
          response.on("aborted", () => finish(voiceError("SUBMIT_INTERRUPTED", "录音提交中断")));
          response.on("error", error => finish(error));
          response.on("end", () => {
            try { const result = JSON.parse(data); if (response.statusCode !== 202 && response.statusCode !== 200) finish(voiceError(result.code || "SUBMIT_FAILED", typeof result.error === "string" ? result.error : "录音提交失败")); else finish(null, result); }
            catch (_) { finish(voiceError("BAD_RESPONSE", "无效语音服务响应")); }
          });
        });
        req.on("error", error => finish(error)); req.end(audio);
      } catch (error) { finish(error); }
    }).catch(async error => {
      if (!["SERVICE_TIMEOUT", "SUBMIT_INTERRUPTED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error.code) || isCancelled(id)) throw error;
      // An acknowledgement can be lost after the server accepted the audio.
      // Recover that same job, without uploading or recognizing it twice.
      try { progress({ id, state: "recovering" }); } catch (_) {}
      await ensure();
      try { const accepted = await request("GET", "/v1/jobs/" + id); if (accepted.id === id) return accepted; }
      catch (_) { /* Preserve the submission error if no accepted job is proven. */ }
      throw error;
    });
    if (created.id !== id) throw voiceError("BAD_RESPONSE", "语音任务标识不匹配");
    let previous = "";
    while (Date.now() < deadline) {
      if (isCancelled(id)) return { error: "转写已取消", code: "CANCELLED" };
      const job = await request("GET", "/v1/jobs/" + id);
      if (job.state !== previous) { previous = job.state; try { progress({ id, state: job.state, timings: job.timings,
        raw_text: job.raw_text, local_text: job.local_text }); } catch (_) {} }
      if (job.state === "done") return { text: job.text || "", raw_text: job.raw_text ?? job.text ?? "",
        local_text: job.local_text ?? job.text ?? "", processing_warning: job.processing_warning || null, timings: job.timings || {}, id };
      if (job.state === "error") return { error: typeof job.error === "string" ? job.error : (job.error && job.error.message) || "识别失败", code: job.code || "INFERENCE_FAILED", id };
      if (job.state === "cancelled") return { error: "转写已取消", code: "CANCELLED", id };
      await delay(200);
    }
    await cancel(id).catch(() => {});
    return { error: "转写超时，后台任务已取消，可以重试保存的录音", code: "JOB_TIMEOUT", id };
    } catch (error) {
      // Submission may have succeeded before the connection failed. Always
      // leave a cancellation tombstone, including failures during polling.
      await cancel(id).catch(() => {});
      throw error;
    } finally { activeJobs.delete(id); }
  }
  async function textCall(route, body) { await ensure(); return request("POST", route, body, true, 75000); }
  return { ensure, transcribe, cancel, getConfig: () => call("GET", "/v1/config"), saveConfig: patch => call("PATCH", "/v1/config", patch),
    previewText: (text, config, key) => textCall("/v1/text", { text, config: config || {}, ...(key !== undefined ? { rewrite_api_key: key } : {}) }),
    testRewrite: (config, key) => textCall("/v1/rewrite/test", { config: config || {}, ...(key !== undefined ? { rewrite_api_key: key } : {}) }),
    useLocal: id => { if (!validId(id)) throw voiceError("INVALID_JOB", "任务标识无效"); return call("POST", "/v1/jobs/" + id + "/use-local", {}); },
    status: () => call("GET", "/v1/status"), warmup: () => call("POST", "/v1/warmup", {}), voiceHome,
    close: () => { for (const id of activeJobs) cancel(id).catch(() => {}); } };
}

function install(electron, options = {}) {
  if (global.__ocVoiceV2) return global.__ocVoiceV2;
  const client = createClient(options), owners = new Map();
  const { ipcMain, app } = electron;
  const handler = (name, fn) => {
    ipcMain.removeHandler(name);
    ipcMain.handle(name, async (event, ...args) => {
      if (!trustedSender(event)) return { error: "语音接口只允许受信任的主页面调用", code: "UNTRUSTED_SENDER" };
      try { return await fn(event, ...args); } catch (error) { return safeResult(error); }
    });
  };
  handler("oc-voice:config", () => client.getConfig());
  handler("oc-voice:save-config", (_, patch) => client.saveConfig(patch));
  handler("oc-voice:status", () => client.status());
  handler("oc-voice:warmup", () => client.warmup());
  handler("oc-voice:preview-text", (_, text, config, key) => {
    if (typeof text !== "string" || text.length > 10000) throw voiceError("INVALID_TEXT", "预览文字最多 10000 个字符");
    return client.previewText(text, config, key);
  });
  handler("oc-voice:test-rewrite", (_, config, key) => client.testRewrite(config, key));
  handler("oc-voice:transcribe", async (event, bytes, mime, id) => {
    if (!validId(id) || owners.has(id)) throw voiceError("INVALID_JOB", "转写任务标识无效或重复");
    const owner = event.sender.id; owners.set(id, owner);
    const destroyed = () => { client.cancel(id).catch(() => {}); };
    event.sender.once("destroyed", destroyed);
    try { return await client.transcribe(bytes, mime, id, progress => { if (!event.sender.isDestroyed()) event.sender.send("oc-voice:progress", progress); }); }
    finally { owners.delete(id); event.sender.removeListener("destroyed", destroyed); }
  });
  handler("oc-voice:cancel", (event, id) => {
    if (owners.get(id) !== event.sender.id) throw voiceError("JOB_OWNER", "只能取消本页面创建的任务");
    return client.cancel(id);
  });
  handler("oc-voice:use-local", (event, id) => {
    if (owners.get(id) !== event.sender.id) throw voiceError("JOB_OWNER", "只能使用本页面创建的任务结果");
    return client.useLocal(id);
  });
  app.once("will-quit", () => client.close());
  global.__ocVoiceV2 = client;
  return client;
}

module.exports = { install, createClient, trustedUrl, trustedSender, allowMedia, validId };
