/* OpenCode Local Voice browser transport. Pair only with a service on this machine. */
;(function (root) {
  "use strict"
  function failure(code, message) { return Object.assign(new Error(message), { code: code }) }
  function createBrowserTransport(connection) {
    if (!connection || !connection.token) throw failure("PAIRING_REQUIRED", "请先生成并安装本机 Web 接入脚本")
    var endpoint = new URL(connection.url || "http://127.0.0.1:47832")
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== "/") throw failure("INVALID_ENDPOINT", "语音服务地址必须是本机 loopback HTTP 地址")
    var base = endpoint.origin, token = connection.token, listeners = new Set(), cancelled = new Set()
    function idValid(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(id) }
    async function request(method, route, data, publicRequest, extraHeaders, timeout) {
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort() }, timeout || 12000)
      var headers = Object.assign({}, extraHeaders || {})
      if (!publicRequest) headers.Authorization = "Bearer " + token
      var body = data
      if (data && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) { body = JSON.stringify(data); headers["Content-Type"] = "application/json" }
      try {
        var response = await fetch(base + route, { method: method, headers: headers, body: body, signal: controller.signal, credentials: "omit", cache: "no-store" })
        var result = await response.json()
        if (!response.ok) throw failure(result.code || "HTTP_" + response.status, typeof result.error === "string" ? result.error : "语音服务请求失败")
        return result
      } catch (error) {
        if (error.code) throw error
        throw failure("LOCAL_SERVICE_UNAVAILABLE", "无法连接本机语音服务，请先启动服务并允许浏览器访问本地网络")
      } finally { clearTimeout(timer) }
    }
    async function ensure() {
      if (!root.crypto || !root.crypto.subtle) throw failure("SECURE_CONTEXT_REQUIRED", "Web 语音输入需要 localhost 或 HTTPS 安全上下文")
      var bytes = root.crypto.getRandomValues(new Uint8Array(24)), nonce = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0") }).join("")
      var response = await request("GET", "/health?challenge=" + nonce, null, true)
      var key = await root.crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      var signature = new Uint8Array(await root.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce)))
      var proof = Array.from(signature).map(function (b) { return b.toString(16).padStart(2, "0") }).join("")
      if (response.service !== "opencode-local-voice" || response.protocol !== 1 || response.proof !== proof) throw failure("SERVICE_IDENTITY", "本地语音服务身份不匹配，未发送录音或凭据")
      return response
    }
    async function call(method, route, data) { await ensure(); return request(method, route, data) }
    async function cancel(id) {
      if (!idValid(id)) throw failure("INVALID_JOB", "任务标识无效")
      cancelled.add(id)
      var cleanup = setTimeout(function () { cancelled.delete(id) }, 300000)
      cleanup.unref?.()
      return call("DELETE", "/v1/jobs/" + id)
    }
    async function transcribe(audio, mime, id) {
      if (!idValid(id)) throw failure("INVALID_JOB", "任务标识无效")
      if (mime !== "audio/wav" || !audio || !audio.byteLength || audio.byteLength > 10 * 1024 * 1024) throw failure("INVALID_AUDIO", "录音格式或大小无效")
      await ensure()
      if (cancelled.has(id)) return { error: "已取消", code: "CANCELLED" }
      var deadline = Date.now() + 180000, previous = "", finished = false
      try {
        listeners.forEach(function (listener) { try { listener({ id: id, state: "submitting" }) } catch (_) {} })
        var created
        try { created = await request("POST", "/v1/jobs", audio, false, { "Content-Type": "audio/wav", "X-Job-Id": id }) }
        catch (error) {
          if (error.code !== "LOCAL_SERVICE_UNAVAILABLE" || cancelled.has(id)) throw error
          listeners.forEach(function (listener) { try { listener({ id: id, state: "recovering" }) } catch (_) {} })
          await ensure()
          try { var accepted = await request("GET", "/v1/jobs/" + id); if (accepted.id === id) created = accepted }
          catch (_) { /* No accepted job was proven; retain the upload error. */ }
          if (!created) throw error
        }
        if (created.id !== id) throw failure("BAD_RESPONSE", "任务标识不匹配")
        while (Date.now() < deadline) {
          if (cancelled.has(id)) return { error: "已取消", code: "CANCELLED" }
          var job = await request("GET", "/v1/jobs/" + id)
          if (job.state !== previous) { previous = job.state; listeners.forEach(function (listener) { try { listener({ id: id, state: job.state, timings: job.timings, raw_text: job.raw_text, local_text: job.local_text }) } catch (_) {} }) }
          if (job.state === "done") { finished = true; return { text: job.text, raw_text: job.raw_text ?? job.text ?? "", local_text: job.local_text ?? job.text ?? "", processing_warning: job.processing_warning || null, timings: job.timings, id: id } }
          if (job.state === "error" || job.state === "cancelled") { finished = true; return { error: typeof job.error === "string" ? job.error : "转写失败", code: job.code || (job.state === "cancelled" ? "CANCELLED" : "INFERENCE_FAILED") } }
          await new Promise(function (resolve) { setTimeout(resolve, 200) })
        }
        throw failure("JOB_TIMEOUT", "转写超时，可以重试保留的录音")
      } finally { if (!finished) await cancel(id).catch(function () {}) }
    }
    return { getConfig: function () { return call("GET", "/v1/config") }, saveConfig: function (patch) { return call("PATCH", "/v1/config", patch) },
      status: function () { return call("GET", "/v1/status") }, warmup: function () { return call("POST", "/v1/warmup", {}) },
      transcribe: transcribe, cancel: cancel, ensure: ensure,
      useLocal: function (id) { if (!idValid(id)) throw failure("INVALID_JOB", "任务标识无效"); return call("POST", "/v1/jobs/" + id + "/use-local", {}) },
      previewText: async function (text, config, key) { await ensure(); return request("POST", "/v1/text", Object.assign({ text: text, config: config || {} }, key !== undefined ? { rewrite_api_key: key } : {}), false, {}, 75000) },
      testRewrite: async function (config, key) { await ensure(); return request("POST", "/v1/rewrite/test", Object.assign({ config: config || {} }, key !== undefined ? { rewrite_api_key: key } : {}), false, {}, 75000) },
      onProgress: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } } }
  }
  root.createOcVoiceTransport = createBrowserTransport
  if (root.__OC_VOICE_CONNECTION) root.ocVoiceTransport = createBrowserTransport(root.__OC_VOICE_CONNECTION)
})(typeof window !== "undefined" ? window : globalThis)
