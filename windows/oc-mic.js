/* oc-mic-v0.1.2; oc-mic-v3 compatible patch entry */
;(function () {
  "use strict"
  if (window.__ocMicInstalled) return
  window.__ocMicInstalled = true
  var state = "idle", token = 0, stream = null, recorder = null, chunks = []
  var limitTimer = null, clockTimer = null, startTime = 0, jobRoute = "", errorText = "", resultText = ""
  var ui = null, signature = "", pending = false, currentForm = null, composing = false
  var waveCtx = null, waveSource = null, analyser = null, waveFrame = 0, waveHistory = [], waveSample = 0, waveLevel = 0
  var markedRow = null, markedAnchor = null
  var editorSelector = '[data-component="prompt-input"][contenteditable], textarea:not([hidden])'
  var formSelector = 'form[data-component="prompt-input-v2"], form[data-component="prompt-input"]'
  var svgHead = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  var MIC = svgHead + '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>'
  var STOP = svgHead + '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>'
  var SPIN = svgHead + '<path d="M20 12a8 8 0 1 1-5.5-7.6"/></svg>'
  function log(s) { console.log("[oc-mic] " + s) }
  function visible(el) { return !!(el && el.isConnected && el.getClientRects().length) }
  function locate() {
    var forms = document.querySelectorAll(formSelector)
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i], send = form.querySelector('[data-action="prompt-submit"]'), editor = form.querySelector(editorSelector)
      // The framework can replace a disabled send button with a tooltip wrapper
      // while recording. Our row CSS briefly hides the new, unmarked wrapper;
      // still locate it so mount() can move the submit marker without cancelling.
      if (visible(form) && send && (visible(send) || active()) && visible(editor) && send.parentElement && send.parentElement.closest(formSelector) === form) {
        var wrapper = send.closest('[data-component="tooltip-v2-trigger"]')
        var anchor = wrapper && wrapper.closest(formSelector) === form ? wrapper : send
        return { form: form, send: send, anchor: anchor, editor: editor, toolbar: anchor.parentElement }
      }
    }
    return null
  }
  function injectStyle() {
    if (document.getElementById("oc-mic-style")) return
    var s = document.createElement("style"); s.id = "oc-mic-style"
    s.textContent = `
#oc-mic-controls{display:inline-flex;align-items:center;flex:0 0 auto;gap:0;margin-inline-end:6px;height:28px;max-width:46%;border-radius:6px;color:var(--v2-icon-icon-muted,var(--icon-base,currentColor));font-family:inherit;font-size:12px;line-height:1.3}
#oc-mic-controls button{width:28px;height:28px;min-width:28px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;border:0;border-radius:6px;padding:0;background:transparent;color:inherit;box-shadow:none;cursor:pointer}
#oc-mic-controls button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
#oc-mic-controls button:focus-visible{outline:2px solid var(--v2-border-border-focus,var(--border-focus,#9c8597));outline-offset:2px}
#oc-mic-controls button:disabled{cursor:default;opacity:.7}
#oc-mic-controls svg{display:block;width:16px;height:16px;flex:none}
#oc-mic-controls [hidden]{display:none!important}
#oc-mic-controls .oc-mic-status{min-width:0;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;padding-inline:8px 4px}
#oc-mic-controls .oc-mic-wave{display:none;min-width:24px;height:40px;flex:1 1 0;max-width:100%}
#oc-mic-controls[data-state="recording"],#oc-mic-controls[data-state="busy"],#oc-mic-controls[data-state="requesting"]{flex:1 1 0;min-width:0;max-width:none;height:40px;gap:10px;background:none}
#oc-mic-controls[data-state="recording"] .oc-mic-wave{display:block}
#oc-mic-controls[data-state="recording"] .oc-mic-status{font-size:11px;max-width:40px;padding:0;flex:none}
#oc-mic-controls[data-state="busy"] .oc-mic-status,#oc-mic-controls[data-state="requesting"] .oc-mic-status{flex:1;text-align:center;max-width:none}
#oc-mic-controls[data-state="recording"] button,#oc-mic-controls[data-state="busy"] button,#oc-mic-controls[data-state="requesting"] button{width:32px;height:32px;min-width:32px;border-radius:50%;background:color-mix(in srgb,currentColor 7%,transparent)}
[data-oc-mic-row="active"] > :not(#oc-mic-controls):not([data-oc-mic-submit-anchor]){display:none!important}
[data-oc-mic-row="active"] > [data-oc-mic-submit-anchor]{opacity:.45;pointer-events:none}
#oc-mic-controls[data-state="error"],#oc-mic-controls[data-state="result"]{color:var(--v2-text-text-critical,var(--icon-critical-base,#b65864))}
#oc-mic-controls[data-state="busy"] #oc-mic-btn svg,#oc-mic-controls[data-state="requesting"] #oc-mic-btn svg{animation:oc-mic-spin 1.1s linear infinite}
#oc-mic-controls .oc-mic-cancel{font-size:17px;font-weight:400;opacity:.75}
#oc-mic-controls.oc-mic-compact[data-state="recording"] .oc-mic-status{display:none}
#oc-mic-controls.oc-mic-compact[data-state="error"] .oc-mic-status{max-width:120px}
#oc-mic-controls .oc-mic-a11y{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes oc-mic-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){#oc-mic-controls svg{animation:none!important}}
`
    document.head.appendChild(s)
  }
  function actionButton(id, label, icon) {
    var b = document.createElement("button"); b.type = "button"; b.id = id
    b.setAttribute("aria-label", label); b.title = label
    b.setAttribute("data-component", "icon-button-v2"); b.setAttribute("data-size", "normal"); b.setAttribute("data-variant", "ghost-muted")
    b.innerHTML = icon; return b
  }
  function makeUi() {
    var root = document.createElement("div"); root.id = "oc-mic-controls"; root.setAttribute("data-oc-mic-version", "0.1.2")
    var status = document.createElement("span"); status.className = "oc-mic-status"; status.setAttribute("aria-hidden", "true")
    var live = document.createElement("span"); live.className = "oc-mic-a11y"; live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite")
    var cancel = actionButton("oc-mic-cancel", "取消录音", "×"); cancel.className = "oc-mic-cancel"
    var btn = actionButton("oc-mic-btn", "语音输入", MIC)
    var wave = document.createElement("canvas"); wave.id = "oc-mic-wave"; wave.className = "oc-mic-wave"; wave.setAttribute("aria-hidden", "true")
    root.append(cancel, wave, status, btn, live)
    btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); if (state === "recording") stopRecording(); else if (state === "idle" || state === "error") startRecording(); else if (state === "result") copyResult() })
    cancel.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); cancelRecording() })
    ui = { root: root, status: status, cancel: cancel, btn: btn, live: live, wave: wave }; signature = ""; render()
  }
  function active() { return ["requesting", "recording", "busy"].indexOf(state) !== -1 }
  function clearRow() {
    if (markedRow) markedRow.removeAttribute("data-oc-mic-row")
    if (markedAnchor) markedAnchor.removeAttribute("data-oc-mic-submit-anchor")
    markedRow = markedAnchor = null
  }
  function syncRow(found) {
    if (!found || !active()) { clearRow(); return }
    if (markedRow !== found.toolbar || markedAnchor !== found.anchor) clearRow()
    markedRow = found.toolbar; markedAnchor = found.anchor
    markedRow.setAttribute("data-oc-mic-row", "active"); markedAnchor.setAttribute("data-oc-mic-submit-anchor", "")
  }
  function render() {
    if (!ui) return
    syncRow(locate())
    var next = state + "|" + errorText + "|" + !!resultText
    if (next === signature) return
    signature = next; ui.root.dataset.state = state
    ui.btn.disabled = state === "busy" || state === "requesting"
    ui.cancel.hidden = !(state === "recording" || state === "busy" || state === "requesting" || state === "result")
    var label = "语音输入", text = "", icon = MIC, cancelLabel = "取消录音"
    if (state === "requesting") { label = "正在请求麦克风权限"; text = "等待麦克风"; icon = SPIN }
    if (state === "recording") { label = "停止并转写（Enter）"; text = "00:00"; icon = STOP }
    if (state === "busy") { label = "正在转写"; text = "正在转写"; icon = SPIN; cancelLabel = "取消转写" }
    if (state === "error") { label = "重试语音输入：" + errorText; text = errorText }
    if (state === "result") { label = "复制转写结果"; text = errorText || "请复制转写结果"; cancelLabel = "丢弃转写结果" }
    ui.status.hidden = !text; ui.status.textContent = text; ui.status.title = text
    ui.btn.innerHTML = icon; ui.btn.title = label; ui.btn.setAttribute("aria-label", label)
    ui.cancel.title = cancelLabel; ui.cancel.setAttribute("aria-label", cancelLabel)
    ui.live.textContent = state === "recording" ? "录音开始：Enter 完成并转写，Esc 取消" : label
  }
  function mount() {
    injectStyle()
    if (jobRoute && jobRoute !== location.href && ["requesting", "recording", "busy"].indexOf(state) !== -1) cancelRecording()
    var found = locate()
    if (!found) { if (active()) cancelRecording(); clearRow(); if (ui && ui.root.isConnected) ui.root.remove(); currentForm = null; return }
    if (!ui) makeUi()
    var stale = document.getElementById("oc-mic-btn")
    if (stale && stale !== ui.btn) stale.remove()
    if (ui.root.parentElement !== found.toolbar || ui.root.nextElementSibling !== found.anchor) {
      found.toolbar.insertBefore(ui.root, found.anchor); log("v0.1.2 mounted on prompt toolbar")
    }
    currentForm = found.form
    ui.root.classList.toggle("oc-mic-compact", found.form.clientWidth < 500)
    syncRow(found)
  }
  function stopWaveform() {
    cancelAnimationFrame(waveFrame); waveFrame = 0
    if (waveSource) { try { waveSource.disconnect() } catch (_) {} }
    waveSource = null; analyser = null; waveHistory = []; waveLevel = 0
    if (waveCtx) { var oldCtx = waveCtx; waveCtx = null; try { oldCtx.close().catch(function () {}) } catch (_) {} }
  }
  function startWaveform(acquired, run) {
    stopWaveform()
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    try {
      waveCtx = new AudioCtx(); waveSource = waveCtx.createMediaStreamSource(acquired)
      analyser = waveCtx.createAnalyser(); analyser.fftSize = 1024; waveSource.connect(analyser)
      waveCtx.resume().catch(function () {})
    } catch (e) { log("waveform unavailable: " + e.name); stopWaveform() }
    waveSample = 0
    var samples = analyser ? new Float32Array(analyser.fftSize) : null
    var previousTime = 0, sampleInterval = 160, spacing = 6
    function frame(time) {
      if (run !== token || state !== "recording" || !ui || !ui.root.isConnected) return
      var canvas = ui.wave, box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
      var width = Math.max(1, Math.round(box.width * dpr)), height = Math.max(1, Math.round(box.height * dpr))
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      var count = Math.max(1, Math.floor(box.width / spacing)), context = canvas.getContext("2d")
      var value = 0, elapsed = previousTime ? Math.min(.1, Math.max(0, (time - previousTime) / 1000)) : 1 / 60
      previousTime = time
      if (analyser && samples) {
        analyser.getFloatTimeDomainData(samples)
        for (var i = 0; i < samples.length; i++) value += samples[i] * samples[i]
        value = Math.min(1, Math.sqrt(value / samples.length) * 4.5)
      }
      // A soft attack and longer release follow speech without snapping on each syllable.
      var smoothing = value > waveLevel ? .22 : .48
      waveLevel += (value - waveLevel) * (1 - Math.exp(-elapsed / smoothing))
      if (time - waveSample >= sampleInterval) {
        waveHistory.push(waveLevel); if (waveHistory.length > count) waveHistory.splice(0, waveHistory.length - count)
        waveSample = time
      }
      if (context) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, box.width, box.height)
        var color = getComputedStyle(ui.root).color
        var drift = Math.min(1, (time - waveSample) / sampleInterval) * spacing
        for (var j = 0; j < count; j++) {
          var level = waveHistory[waveHistory.length - count + j] || 0, h = Math.max(3, Math.min(24, level * 21 + 3))
          context.fillStyle = color; context.globalAlpha = j < count - 22 ? .32 : .65
          context.beginPath(); context.roundRect(j * spacing + 2 - drift, (box.height - h) / 2, 2.8, h, 1.4); context.fill()
        }
        context.globalAlpha = 1
      }
      waveFrame = requestAnimationFrame(frame)
    }
    waveFrame = requestAnimationFrame(frame)
  }
  function clearTimers() { clearTimeout(limitTimer); clearInterval(clockTimer); limitTimer = clockTimer = null }
  function release() {
    clearTimers()
    stopWaveform()
    if (stream) stream.getTracks().forEach(function (t) { t.stop() })
    stream = null; recorder = null; chunks = []
  }
  function cancelRecording() {
    token++
    if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; try { if (recorder.state !== "inactive") recorder.stop() } catch (_) {} }
    release(); state = "idle"; errorText = ""; resultText = ""; jobRoute = ""; render()
    if (ui) ui.live.textContent = "语音输入已取消，草稿保持原样"
    log("cancelled; microphone released")
  }
  function messageFor(e) {
    var n = e && e.name, msg = String((e && e.message) || e || "语音输入失败")
    if (n === "NotAllowedError" || n === "PermissionDeniedError") return "麦克风权限未开启"
    if (n === "NotFoundError" || n === "DevicesNotFoundError") return "未找到麦克风"
    if (n === "NotReadableError" || n === "TrackStartError") return "麦克风不可用或被占用"
    if (/local whisper server failed|Failed to fetch|ECONNREFUSED|服务未启动/.test(msg)) return "转写服务暂不可用"
    if (/timeout|超时/i.test(msg)) return "转写超时，请重试"
    if (/expected 16k|decode|EncodingError/i.test(msg)) return "录音格式转换失败"
    if (/未识别|空结果/.test(msg)) return "未识别到语音，请重试"
    if (/录音时间太短/.test(msg)) return "录音时间太短，请重试"
    return "语音输入失败，请重试"
  }
  function fail(e, run) {
    if (run !== token) return
    token++
    if (recorder) { recorder.onstop = null; recorder.ondataavailable = null; try { if (recorder.state !== "inactive") recorder.stop() } catch (_) {} }
    release(); jobRoute = ""; state = "error"; errorText = messageFor(e); render(); log("error category=" + errorText)
  }
  function mimeType() {
    var types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i]
    return ""
  }
  async function startRecording() {
    var found = locate()
    if (!found) return
    var run = ++token; jobRoute = location.href; errorText = ""; resultText = ""; state = "requesting"; render()
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) throw new Error("设备不可用")
      var acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
      if (run !== token || jobRoute !== location.href) { acquired.getTracks().forEach(function (t) { t.stop() }); return }
      stream = acquired; chunks = []
      var mime = mimeType(); recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      var rec = recorder
      rec.ondataavailable = function (e) { if (run === token && e.data && e.data.size) chunks.push(e.data) }
      rec.onstop = function () { finishRecording(run, rec.mimeType) }
      rec.onerror = function (e) { fail(e.error || e, run) }
      rec.start(250); startTime = Date.now(); state = "recording"; render(); startWaveform(acquired, run)
      clockTimer = setInterval(function () { if (state !== "recording" || !ui) return; var sec = Math.floor((Date.now() - startTime) / 1000); ui.status.textContent = String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0") }, 1000)
      limitTimer = setTimeout(stopRecording, 60000); log("recording started")
    } catch (e) { fail(e, run) }
  }
  function stopRecording() {
    if (state !== "recording" || !recorder) return
    clearTimers(); state = "busy"; render()
    stopWaveform()
    try { recorder.stop() } catch (e) { fail(e, token) }
  }
  // The local Windows server accepts exactly 16 kHz, mono, signed 16-bit WAV.
  function encodeWav(audio) {
    var rate = 16000, inputRate = audio.sampleRate, size = Math.max(1, Math.round(audio.length * rate / inputRate))
    var buffer = new ArrayBuffer(44 + size * 2), view = new DataView(buffer)
    function str(off, s) { for (var k = 0; k < s.length; k++) view.setUint8(off + k, s.charCodeAt(k)) }
    str(0, "RIFF"); view.setUint32(4, 36 + size * 2, true); str(8, "WAVE"); str(12, "fmt "); view.setUint32(16, 16, true)
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, size * 2, true)
    var channels = []
    for (var c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
    // Area averaging performs downsampling without discarding all between-sample energy.
    for (var i = 0; i < size; i++) {
      var from = i * inputRate / rate, to = Math.min(audio.length, (i + 1) * inputRate / rate), sum = 0, weight = 0
      for (var j = Math.floor(from); j < Math.ceil(to); j++) {
        var w = Math.min(to, j + 1) - Math.max(from, j)
        if (j >= audio.length || w <= 0) continue
        var value = 0; for (var k = 0; k < channels.length; k++) value += channels[k][j]
        sum += value / channels.length * w; weight += w
      }
      var sample = Math.max(-1, Math.min(1, weight ? sum / weight : 0)); view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true)
    }
    return buffer
  }
  async function toWav(blob) {
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) throw new Error("录音格式转换失败")
    var ctx = new AudioCtx()
    try { return encodeWav(await ctx.decodeAudioData(await blob.arrayBuffer())) } finally { await ctx.close() }
  }
  async function transcribe(bytes) {
    if (!window.ocMic || typeof window.ocMic.transcribe !== "function") throw new Error("服务未启动")
    var timeout
    try { return await Promise.race([window.ocMic.transcribe(bytes, "audio/wav"), new Promise(function (_, reject) { timeout = setTimeout(function () { reject(new Error("转写超时")) }, 490000) })]) } finally { clearTimeout(timeout) }
  }
  async function finishRecording(run, type) {
    if (run !== token) return
    var blob = new Blob(chunks, { type: type || "audio/webm" }); release(); state = "busy"; render()
    try {
      if (blob.size < 1000) throw new Error("录音时间太短")
      var bytes = await toWav(blob)
      if (run !== token) return
      var res = await transcribe(bytes)
      if (run !== token) return
      if (res && res.error) throw new Error(res.error)
      var text = res && typeof res.text === "string" ? res.text.trim() : ""
      if (!text) throw new Error("未识别到语音")
      var found = locate()
      if (jobRoute !== location.href || !found || composing || !insertText(found.editor, text)) {
        resultText = text; errorText = "请复制转写结果"; state = "result"; render(); return
      }
      state = "idle"; jobRoute = ""; render(); if (ui) ui.live.textContent = "语音已填入草稿，请检查后发送"; log("transcript inserted into current draft")
    } catch (e) { fail(e, run) }
  }
  function insertText(editor, text) {
    if (!editor || !visible(editor)) return false
    var existing = editor.tagName === "TEXTAREA" ? editor.value : editor.textContent
    var suffix = (existing && !/\s$/.test(existing) ? " " : "") + text
    editor.focus()
    if (editor.tagName === "TEXTAREA") {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set
      setter.call(editor, existing + suffix); editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: suffix })); editor.setSelectionRange(editor.value.length, editor.value.length); return true
    }
    var sel = window.getSelection(), range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); sel.removeAllRanges(); sel.addRange(range)
    // execCommand dispatches the editor's native input event and preserves mention nodes.
    // Do not replace textContent: OpenCode's input handler owns parsing and draft updates.
    var inserted = false
    try { inserted = document.execCommand("insertText", false, suffix) } catch (_) {}
    if (!inserted && !editor.textContent.endsWith(text)) {
      var node = document.createTextNode(suffix)
      range.insertNode(node); range.setStartAfter(node); range.collapse(true); sel.removeAllRanges(); sel.addRange(range)
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: suffix }))
    }
    return editor.textContent.endsWith(text)
  }
  async function copyResult() {
    if (!resultText) return
    try { await navigator.clipboard.writeText(resultText); resultText = ""; errorText = ""; state = "idle"; render(); if (ui) ui.live.textContent = "转写结果已复制" } catch (_) { if (ui) { ui.btn.title = resultText; ui.live.textContent = "复制失败，转写结果仍保留" } }
  }
  function schedule(records) {
    if (records && records.length && records.every(function (r) { return ui && ui.root.contains(r.target) })) return
    if (pending) return; pending = true
    setTimeout(function () { pending = false; try { mount() } catch (e) { log("mount failed: " + e.name) } }, 80)
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && ["requesting", "recording", "busy"].indexOf(state) !== -1) { e.preventDefault(); e.stopPropagation(); cancelRecording() } }, true)
  // Guard the native submit routes without overwriting framework-owned disabled state.
  document.addEventListener("click", function (e) { if (active() && currentForm && e.target.closest && e.target.closest('[data-action="prompt-submit"]') && currentForm.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  document.addEventListener("keydown", function (e) { if (!active() || e.key !== "Enter" || e.isComposing || e.shiftKey) return; if (state === "recording") { e.preventDefault(); e.stopImmediatePropagation(); stopRecording(); return } if (currentForm && currentForm.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  document.addEventListener("submit", function (e) { if (active() && e.target === currentForm) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  document.addEventListener("compositionstart", function (e) { if (currentForm && currentForm.contains(e.target)) composing = true })
  document.addEventListener("compositionend", function () { composing = false })
  window.addEventListener("pagehide", cancelRecording)
  window.addEventListener("resize", function () { schedule() })
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  setInterval(function () { schedule() }, 2500)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { schedule() }); else schedule()
  log("v0.1.2 script ready")
})()
