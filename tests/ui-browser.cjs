"use strict";
const { chromium } = require("playwright-core");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const output = path.resolve("test-results"); fs.mkdirSync(output, { recursive: true });
const results = [], consoleErrors = [];
const html = `<!doctype html><meta charset="utf-8"><title>Isolated voice regression fixture</title>
<style>:root{--v2-surface-surface-raised:#faf8fa;--v2-surface-surface-base:#fff;--v2-text-text-base:#302936;--v2-icon-icon-muted:#766479;--v2-border-border-base:#d9ceda}body{font:14px system-ui;background:#f7f4f8;color:#302936;padding:80px}form[data-component]{margin:auto;max-width:650px;border:1px solid #d9ceda;border-radius:16px;padding:18px;background:white}[contenteditable]{min-height:70px;outline:none}#toolbar{display:flex;justify-content:flex-end;align-items:center;gap:6px;min-height:40px}button[data-action]{border:0;border-radius:6px;background:#a18aab;color:white;width:28px;height:28px}</style>
<button id="fixture-open-settings">OpenCode 设置</button><dialog id="fixture-native-settings" style="width:760px;height:580px;background:var(--v2-surface-surface-raised);color:var(--v2-text-text-base);padding:0"><div style="display:flex;height:100%" data-component="tabs-v2" data-variant="settings"><nav role="tablist" aria-orientation="vertical" style="width:150px;flex:none;padding:15px"><button role="tab" data-value="general" aria-controls="fixture-general" aria-selected="true">通用</button><button role="tab" data-value="shortcuts" aria-controls="fixture-shortcuts" aria-selected="false">快捷键</button><button role="tab" data-value="voice-input" aria-controls="fixture-voice" aria-selected="false">语音输入</button></nav><div id="fixture-native-panel" style="overflow:auto;flex:1;padding:20px"></div></div><button id="fixture-close-settings" style="position:absolute;right:8px;top:8px">关闭</button></dialog>
<form data-component="prompt-input-v2"><div data-component="prompt-input" contenteditable="true">Existing draft <span contenteditable="false" data-mention="1">@file.ts</span> </div><div id="toolbar"><button type="submit" data-action="prompt-submit">↑</button></div></form>
<script>window.submissions=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions++});document.getElementById('fixture-open-settings').onclick=()=>document.getElementById('fixture-native-settings').showModal();document.getElementById('fixture-close-settings').onclick=()=>document.getElementById('fixture-native-settings').close();document.querySelectorAll('[role=tab]').forEach(tab=>{tab.onclick=()=>{document.querySelectorAll('[role=tab]').forEach(item=>item.setAttribute('aria-selected',item===tab?'true':'false'));const panel=window.fixturePanel||document.getElementById('fixture-native-panel');panel.replaceChildren();panel.setAttribute('role','tabpanel');panel.id=tab.getAttribute('aria-controls');window.fixturePanel=panel;if(tab.dataset.value==='voice-input')panel.appendChild(document.createElement('oc-voice-settings'));else panel.textContent=tab.textContent;};});document.querySelector('[data-value=general]').click()</script>`;

async function main() {
  const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.OC_VOICE_TEST_BROWSER || undefined }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  const page = await context.newPage();
  page.on("pageerror", error => consoleErrors.push(error.message));
  async function check(name, action) { await action(); results.push({ name, status: "PASS" }); }
  try {
    await page.addInitScript(() => {
      localStorage.setItem("oc-voice-microphone", "synthetic-device");
      window.calls = { capture: 0, transcription: 0, warmup: 0, cancel: [], saves: [], local: [] };
      window.voiceMode = "ok"; window.transcript = "Recognized speech."; window.captureStreams = [];
      const config = { backend: "auto", device: "auto", model_path: "/local/test-model", language: "auto", beam_size: 1, cpu_threads: 4, max_seconds: 120, idle_seconds: 1800, warmup_on_record: true, initial_prompt: "" };
      const listeners = new Set();
      window.ocMic = {
        getConfig: async () => ({ ...config }),
        saveConfig: async patch => { window.calls.saves.push(patch); Object.assign(config, patch); return { ...config }; },
        status: async () => ({ model_state: "ready", backend: "fake", device: "synthetic" }),
        warmup: async () => { window.calls.warmup++; return { id: "warmup-test", state: "queued" }; },
        cancel: async id => { window.calls.cancel.push(id); return { id, state: "cancelled" }; },
        onProgress: callback => { listeners.add(callback); return () => listeners.delete(callback); },
        useLocal: async id => { window.calls.local.push(id); window.aiResolve?.(); return { id, state: "done" }; },
        transcribe: async (bytes, mime, id) => {
          window.calls.transcription++; const view = new DataView(bytes); window.wav = { mime, rate: view.getUint32(24, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true), bytes: bytes.byteLength };
          listeners.forEach(listener => listener({ id, state: "loading" }));
          const mode = window.voiceMode;
          if (mode === "cold") { listeners.forEach(listener => listener({ id, state: "submitting" })); await new Promise(resolve => setTimeout(resolve, 60)); listeners.forEach(listener => listener({ id, state: "loading" })); await new Promise(resolve => setTimeout(resolve, 700)); listeners.forEach(listener => listener({ id, state: "transcribing" })); }
          await new Promise(resolve => setTimeout(resolve, mode === "slow" ? 600 : 40));
          if (mode === "error") return { error: "Synthetic service failure", code: "TEST_FAILURE" };
          if (mode === "ai-slow") { listeners.forEach(listener => listener({ id, state: "rewriting", raw_text: "raw speech", local_text: "local fallback" })); await new Promise(resolve => { window.aiResolve = resolve; }); return { text: "local fallback", raw_text: "raw speech", local_text: "local fallback", processing_warning: "AI skipped" }; }
          return { text: window.transcript, raw_text: window.rawTranscript || window.transcript, local_text: window.localTranscript || window.transcript, processing_warning: window.processingWarning || null, timings: { audio_seconds: 1 } };
        },
      };
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.calls.capture++; window.lastConstraints = constraints;
        if (window.voiceMode === "denied") throw new DOMException("Denied", "NotAllowedError");
        if (window.voiceMode === "permission-delayed") await new Promise(resolve => { window.resolvePendingCapture = resolve; });
        const ctx = new AudioContext(), oscillator = ctx.createOscillator(), destination = ctx.createMediaStreamDestination();
        oscillator.frequency.value = 330; oscillator.connect(destination); oscillator.start(); await ctx.resume();
        const stream = destination.stream;
        stream.getTracks().forEach(track => { const stop = track.stop.bind(track); track.stop = () => { stop(); oscillator.stop(); ctx.close(); }; });
        window.captureStreams.push(stream); return stream;
      };
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "synthetic-device", label: "Synthetic microphone" }];
      navigator.clipboard.writeText = async text => { window.copiedText = text; };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/session-one`);
    // The native dialog service registers window capture before the voice
    // script, even when the event's propagation to document is stopped.
    await page.evaluate(() => {
      window.nativeWindowKeys = [];
      window.addEventListener("keydown", e => {
        if (window.nativeWindowIntercept && ["Enter", "Escape"].includes(e.key)) { window.nativeWindowKeys.push(e.key); e.preventDefault(); e.stopPropagation(); }
      }, true);
    });
    await page.addScriptTag({ path: path.resolve("shared/oc-mic.js") });
    const state = value => page.waitForFunction(expected => document.getElementById("oc-mic-controls")?.dataset.state === expected, value);
    const editor = page.locator('[data-component="prompt-input"][contenteditable]');
    async function record() { await page.locator("#oc-mic-btn").click(); await state("recording"); await page.waitForTimeout(500); }
    await check("one toolbar microphone, without a separate settings button or dialog", async () => {
      await page.waitForSelector("#oc-mic-controls"); assert.equal(await page.locator("#oc-mic-controls").count(), 1);
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-oc-mic-version"), fs.readFileSync(path.resolve("VERSION"), "utf8").trim());
      assert.equal(await page.locator("#oc-mic-settings, dialog#oc-voice-settings").count(), 0);
      await page.screenshot({ path: path.join(output, "ui-idle.png") });
    });
    await check("microphone preference from native settings is honored by capture", async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem("oc-voice-microphone")), "synthetic-device");
      assert.equal(await page.locator("#oc-mic-controls").count(), 1);
    });
    await check("plain Space retains ordinary editing behavior", async () => {
      await page.evaluate(() => { const editor = document.querySelector('[data-component="prompt-input"][contenteditable]'); editor.focus(); const range = document.createRange(); range.setStart(editor.firstChild, 8); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); }); await page.keyboard.press("Space");
      assert.match((await editor.textContent()).replace(/\u00a0/g, " "), /^Existing  draft/); assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "idle");
    });
    await check("Enter finishes after host rerender drops microphone focus onto the page", async () => {
      await record(); await page.evaluate(() => { document.activeElement.blur(); });
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      await page.keyboard.press("Enter"); await page.waitForFunction(() => document.getElementById("oc-mic-controls").dataset.state === "idle", null, { timeout: 1000 });
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
    });
    await check("Esc cancels after the host replaces the focused toolbar", async () => {
      const before = await editor.textContent(), calls = await page.evaluate(() => window.calls.transcription);
      await record(); await page.evaluate(() => { const old = document.getElementById("toolbar"), next = old.cloneNode(true); next.querySelector("#oc-mic-controls").remove(); old.replaceWith(next); });
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
      await page.waitForFunction(() => document.getElementById("oc-mic-controls")?.parentElement.id === "toolbar");
      await page.keyboard.press("Escape"); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      assert.equal(await editor.textContent(), before); assert.equal(await page.evaluate(() => window.calls.transcription), calls);
    });
    await check("voice shortcuts run before native document capture handlers", async () => {
      await page.evaluate(() => {
        window.hostKeyCount = 0; window.hostKeyHandler = e => { if (["Enter", "Escape"].includes(e.key)) { window.hostKeyCount++; e.preventDefault(); e.stopImmediatePropagation(); } };
        document.addEventListener("keydown", window.hostKeyHandler, true);
      });
      await record(); await editor.focus(); await page.keyboard.press("Enter"); await state("idle");
      await record(); await page.keyboard.press("Escape"); await state("idle");
      assert.equal(await page.evaluate(() => window.hostKeyCount), 0);
      await page.evaluate(() => document.removeEventListener("keydown", window.hostKeyHandler, true));
    });
    await check("earlier native window capture stopPropagation still permits Enter/Esc", async () => {
      await page.evaluate(() => { window.nativeWindowIntercept = true; });
      await record(); await page.keyboard.press("Enter"); await state("idle");
      await record(); await page.keyboard.press("Escape"); await state("idle");
      assert.deepEqual(await page.evaluate(() => window.nativeWindowKeys), ["Enter", "Escape"]);
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      await page.evaluate(() => { window.nativeWindowIntercept = false; });
    });
    await check("shortcut uses the current form immediately after whole-composer replacement", async () => {
      await record(); await page.evaluate(() => {
        const old = document.querySelector("form"), next = old.cloneNode(true); next.querySelector("#oc-mic-controls").remove(); old.replaceWith(next);
        next.querySelector('[contenteditable="true"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      await state("idle"); assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
    });
    await check("host compositionend propagation cannot leave shortcuts permanently disabled", async () => {
      await record(); await editor.dispatchEvent("compositionstart");
      await page.evaluate(() => { const editor = document.querySelector('[data-component="prompt-input"][contenteditable]'); editor.addEventListener("compositionend", e => e.stopImmediatePropagation(), { once: true }); });
      await editor.dispatchEvent("compositionend"); await page.keyboard.press("Escape"); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
    });
    await check("modal settings and unrelated fields retain their own Enter/Esc behavior", async () => {
      await record(); await page.evaluate(() => {
        const dialog = document.getElementById("fixture-native-settings"), input = document.createElement("input"); input.id = "recording-modal-probe"; dialog.appendChild(input); dialog.showModal(); input.focus();
      });
      await page.locator("#recording-modal-probe").dispatchEvent("keydown", { key: "Enter", bubbles: true });
      await page.locator("#recording-modal-probe").dispatchEvent("keydown", { key: "Escape", bubbles: true });
      await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "recording");
      await page.evaluate(() => { document.getElementById("fixture-native-settings").close(); document.getElementById("recording-modal-probe").remove(); const input = document.createElement("input"); input.id = "unrelated-input-probe"; document.body.appendChild(input); input.focus(); });
      await page.keyboard.press("Enter"); await page.keyboard.press("Escape");
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "recording");
      await page.evaluate(() => document.getElementById("unrelated-input-probe").remove()); await page.keyboard.press("Escape"); await state("idle");
    });
    await check("synthetic capture, Enter transcription, WAV and draft preservation", async () => {
      await record(); await page.keyboard.press("Enter"); await state("idle");
      assert.match(await editor.textContent(), /Recognized speech/); assert.equal(await page.locator("[data-mention]").count(), 1);
      assert.deepEqual(await page.evaluate(() => [window.wav.rate, window.wav.channels, window.wav.bits, window.submissions]), [16000, 1, 16, 0]);
      assert.equal(await page.evaluate(() => window.lastConstraints.audio.deviceId.exact), "synthetic-device");
      assert.equal(await page.evaluate(() => window.captureStreams[0].getTracks()[0].readyState), "ended");
    });
    await check("failed recognition retries retained audio without recapture", async () => {
      await page.evaluate(() => { window.voiceMode = "error"; }); await record(); await page.keyboard.press("Enter"); await state("error");
      const captures = await page.evaluate(() => window.calls.capture); assert.equal(await page.locator("#oc-mic-retry").isVisible(), true);
      await page.evaluate(() => { window.voiceMode = "ok"; }); await page.locator("#oc-mic-retry").click(); await state("idle");
      assert.equal(await page.evaluate(() => window.calls.capture), captures);
    });
    await check("first cold transcription shows model preparation until success, with the microphone stopped", async () => {
      await page.evaluate(() => { window.voiceMode = "cold"; }); await record(); await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".oc-mic-status").textContent === "准备识别模型");
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "busy");
      assert.equal(await page.locator("#oc-mic-retry").isVisible(), false); assert.equal(await page.locator("#oc-mic-cancel").isVisible(), true);
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      await state("idle"); assert.match(await editor.textContent(), /Recognized speech/); await page.evaluate(() => { window.voiceMode = "ok"; });
    });
    await check("busy cancellation invokes backend and suppresses late insertion", async () => {
      const before = await editor.textContent(); await page.evaluate(() => { window.voiceMode = "slow"; }); await record(); await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.wav && document.querySelector("#oc-mic-controls").dataset.state === "busy");
      await page.waitForTimeout(100); await page.locator("#oc-mic-cancel").click(); await state("idle"); await page.waitForTimeout(700);
      assert.equal(await editor.textContent(), before); assert.ok((await page.evaluate(() => window.calls.cancel)).length > 0);
    });
    await check("microphone permission error remains recoverable", async () => {
      await page.evaluate(() => { window.voiceMode = "denied"; }); await page.locator("#oc-mic-btn").click(); await state("error");
      assert.match(await page.locator(".oc-mic-status").textContent(), /权限/); assert.equal(await page.locator("#oc-mic-btn").isEnabled(), true);
    });
    await check("Esc releases synthetic microphone", async () => {
      await page.evaluate(() => { window.voiceMode = "ok"; }); await record(); await page.keyboard.press("Escape"); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
    });
    await check("visible stop button finishes recording, releases tracks and inserts only a draft", async () => {
      const before = await editor.textContent(), transcriptions = await page.evaluate(() => window.calls.transcription);
      await page.evaluate(() => { window.voiceMode = "ok"; window.transcript = " button-finish"; });
      await record(); assert.equal(await page.locator("#oc-mic-cancel").isVisible(), true);
      assert.equal(await page.locator("#oc-mic-btn").getAttribute("aria-label"), "停止并转写（Enter）");
      await page.screenshot({ path: path.join(output, "v0.2.0-recording-buttons.png") });
      await page.locator("#oc-mic-btn").click(); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      assert.equal(await page.locator("#oc-mic-wave").isVisible(), false);
      assert.equal(await page.evaluate(() => window.calls.transcription), transcriptions + 1);
      assert.ok((await editor.textContent()).includes("button-finish")); assert.ok((await editor.textContent()).includes(before.trim()));
      assert.equal(await page.evaluate(() => window.submissions), 0);
      await page.evaluate(() => { window.transcript = "Recognized speech."; });
    });
    await check("visible cancel button stops recording without submitting audio or modifying the draft", async () => {
      const before = await editor.textContent(), transcriptions = await page.evaluate(() => window.calls.transcription);
      await record(); await page.locator("#oc-mic-cancel").click(); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      assert.equal(await page.locator("#oc-mic-wave").isVisible(), false);
      assert.equal(await page.evaluate(() => window.calls.transcription), transcriptions);
      assert.equal(await editor.textContent(), before);
    });
    await check("cancel during pending microphone permission also stops a late acquired stream", async () => {
      const before = await editor.textContent(), streams = await page.evaluate(() => window.captureStreams.length);
      await page.evaluate(() => { window.voiceMode = "permission-delayed"; });
      await page.locator("#oc-mic-btn").click(); await state("requesting");
      await page.waitForFunction(() => typeof window.resolvePendingCapture === "function");
      await page.locator("#oc-mic-cancel").click(); await state("idle");
      await page.evaluate(() => { window.voiceMode = "ok"; window.resolvePendingCapture(); });
      await page.waitForFunction(count => window.captureStreams.length === count + 1 && window.captureStreams.at(-1).getTracks()[0].readyState === "ended", streams);
      assert.equal(await editor.textContent(), before);
    });
    await check("pagehide during recording releases audio tracks and preserves the draft", async () => {
      const before = await editor.textContent(), transcriptions = await page.evaluate(() => window.calls.transcription);
      await record(); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide"))); await state("idle");
      assert.equal(await page.evaluate(() => window.captureStreams.at(-1).getTracks()[0].readyState), "ended");
      assert.equal(await page.evaluate(() => window.calls.transcription), transcriptions);
      assert.equal(await editor.textContent(), before);
    });
    await check("pagehide during transcription cancels the job and rejects a late result", async () => {
      const before = await editor.textContent(), cancelled = await page.evaluate(() => window.calls.cancel.length);
      await page.evaluate(() => { window.voiceMode = "slow"; }); await record(); await page.keyboard.press("Enter");
      await page.waitForTimeout(100); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide"))); await state("idle");
      await page.waitForTimeout(700); assert.ok(await page.evaluate(count => window.calls.cancel.length > count, cancelled));
      assert.equal(await editor.textContent(), before); await page.evaluate(() => { window.voiceMode = "ok"; });
    });
    await check("IME, modifiers and repeated Enter/Esc do not trigger recording shortcuts", async () => {
      await record(); await editor.dispatchEvent("compositionstart");
      await editor.dispatchEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }); await editor.dispatchEvent("keydown", { key: "Escape", bubbles: true, isComposing: true });
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "recording"); await editor.dispatchEvent("compositionend");
      await editor.dispatchEvent("keydown", { key: "Enter", bubbles: true, shiftKey: true }); await editor.dispatchEvent("keydown", { key: "Escape", bubbles: true, ctrlKey: true });
      await editor.dispatchEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 });
      await page.locator("#fixture-open-settings").dispatchEvent("keydown", { key: "Enter", bubbles: true }); await page.locator("#fixture-open-settings").dispatchEvent("keydown", { key: "Escape", bubbles: true });
      await editor.dispatchEvent("keydown", { key: "Enter", bubbles: true, repeat: true }); await editor.dispatchEvent("keydown", { key: "Escape", bubbles: true, repeat: true });
      assert.equal(await page.locator("#oc-mic-controls").getAttribute("data-state"), "recording"); await page.keyboard.press("Escape"); await state("idle");
    });
    await check("local fallback button finishes AI processing without another capture", async () => {
      await page.evaluate(() => { window.voiceMode = "ai-slow"; }); await record(); const captures = await page.evaluate(() => window.calls.capture);
      await page.keyboard.press("Enter"); await page.locator("#oc-mic-use-local").waitFor({ state: "visible" }); await page.locator("#oc-mic-use-local").click(); await state("idle");
      assert.equal(await page.evaluate(() => window.calls.capture), captures); assert.equal(await page.evaluate(() => window.calls.local.length), 1); assert.match(await editor.textContent(), /local fallback$/);
    });
    await check("restoring raw/local result changes only the inserted speech and preserves mentions", async () => {
      const before = await editor.textContent(); await page.evaluate(() => { window.voiceMode = "ok"; window.transcript = "optimized result"; window.rawTranscript = "raw result"; window.localTranscript = "local result"; });
      await record(); await page.keyboard.press("Enter"); await state("idle");
      assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.restoreOriginal())).ok, true); assert.equal(await editor.textContent(), before + " raw result");
      await page.evaluate(() => { const dialog = document.getElementById("fixture-native-settings"), input = document.createElement("input"); input.id = "modal-input-probe"; input.value = "unchanged settings field"; dialog.appendChild(input); dialog.showModal(); input.focus(); });
      assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.restoreLocal())).ok, true); assert.equal(await editor.textContent(), before + " local result"); assert.equal(await page.locator("[data-mention]").count(), 1);
      assert.equal(await page.locator("#modal-input-probe").inputValue(), "unchanged settings field"); assert.equal(await page.evaluate(() => document.activeElement.id), "modal-input-probe");
      await page.evaluate(() => { document.getElementById("fixture-native-settings").close(); });
      await editor.focus(); await page.keyboard.press("End"); await page.keyboard.type("!"); const changed = await editor.textContent();
      assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.restoreOriginal())).ok, false); assert.equal(await editor.textContent(), changed);
    });
    await check("explicit conversion affects the selected ordinary text only", async () => {
      const before = await editor.textContent(); await page.evaluate(() => {
        const editor = document.querySelector('[data-component="prompt-input"][contenteditable]'), node = document.createTextNode("中文 词语"); editor.appendChild(node); editor.focus();
        const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.perform("spaceToComma"))).ok, true); assert.equal(await editor.textContent(), before + "中文，词语"); assert.equal(await page.locator("[data-mention]").count(), 1);
      await page.evaluate(() => { const node = document.querySelector("[data-mention]"); const range = document.createRange(); range.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(range); });
      const unchanged = await editor.textContent(); assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.perform("insertComma"))).ok, false); assert.equal(await editor.textContent(), unchanged);
    });
    await check("route change cancels active job and protects new draft", async () => {
      const before = await editor.textContent(); await page.evaluate(() => { window.voiceMode = "slow"; }); await record(); await page.keyboard.press("Enter"); await page.waitForTimeout(100);
      await page.evaluate(() => { history.pushState({}, "", "/session-two"); document.body.appendChild(document.createElement("span")); });
      await state("idle"); await page.waitForTimeout(700); assert.equal(await editor.textContent(), before);
      assert.equal(await page.evaluate(() => window.ocVoiceDraftActions.getLastResult()), null);
    });
    await check("composition preserves result for explicit copy", async () => {
      await page.evaluate(() => { window.voiceMode = "ok"; window.transcript = "Recognized speech."; }); await record(); await editor.dispatchEvent("compositionstart"); await page.locator("#oc-mic-btn").click(); await state("result");
      await page.locator("#oc-mic-btn").click(); await state("idle"); assert.equal(await page.evaluate(() => window.copiedText), "Recognized speech."); await editor.dispatchEvent("compositionend");
    });
    await check("remount stays unique and no automatic submission or page errors", async () => {
      await page.addScriptTag({ path: path.resolve("shared/oc-mic.js") }); await page.waitForTimeout(150);
      assert.equal(await page.locator("#oc-mic-controls").count(), 1); assert.equal(await page.evaluate(() => window.submissions), 0); assert.deepEqual(consoleErrors, []);
    });
    await check("voice result adjacent to a final file mention can be restored without touching the mention", async () => {
      await page.evaluate(() => { const editor = document.querySelector('[data-component="prompt-input"][contenteditable]'); editor.replaceChildren(document.createTextNode("prefix ")); const mention = document.createElement("span"); mention.contentEditable = "false"; mention.dataset.mention = "1"; mention.textContent = "@final.ts"; editor.appendChild(mention); window.finalMention = mention; window.transcript = "finaltail"; window.rawTranscript = "rawtail"; window.localTranscript = "localtail"; });
      await record(); await page.keyboard.press("Enter"); await state("idle");
      assert.equal((await page.evaluate(() => window.ocVoiceDraftActions.restoreOriginal())).ok, true); assert.equal((await editor.textContent()).replace(/\u00a0/g, " "), "prefix @final.ts rawtail");
      assert.equal(await page.evaluate(() => window.finalMention === document.querySelector("[data-mention]")), true); assert.equal(await page.evaluate(() => window.submissions), 0);
    });
  } finally {
    fs.writeFileSync(path.join(output, "ui-report.json"), JSON.stringify({ synthetic: true, real_microphone: false,
      browserVersion: browser.version(), playwrightVersion: require("playwright-core/package.json").version, results, consoleErrors }, null, 2));
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
