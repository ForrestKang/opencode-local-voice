"use strict";
// Read an installed ASAR and exercise the native Solid controls in an isolated
// headless browser. The app archive and real desktop process remain untouched.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const assert = require("node:assert/strict"), { chromium } = require("playwright-core");
const patcher = require("../shared/patch-package.cjs");
const output = path.resolve("test-results");
const input = process.env.OC_VOICE_NATIVE_ASAR;
if (!input) throw new Error("Set OC_VOICE_NATIVE_ASAR to a supported OpenCode app.asar; this test reads it without modifying it.");

function textEntry(buffer, parsed, name) {
  return patcher.readEntry(buffer, parsed.dataStart, patcher.getEntry(parsed.header, name), name).toString("utf8");
}

function importPaths(source) {
  const paths = [];
  const pattern = /import\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) paths.push(match[1] || match[2]);
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamic)) paths.push(match[1]);
  return paths;
}

function collectAssetGraph(buffer, parsed, start) {
  const sources = new Map();
  function visit(name) {
    if (sources.has(name)) return;
    const archivePath = "out/renderer/assets/" + name;
    if (!patcher.getEntry(parsed.header, archivePath)) return;
    const source = textEntry(buffer, parsed, archivePath);
    sources.set(name, source);
    for (const specifier of importPaths(source)) {
      if (!specifier.startsWith("./") || !specifier.endsWith(".js")) continue;
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier.slice(2))));
    }
  }
  for (const name of start) visit(name);
  return sources;
}

function runtime(source, externalSources, mainAsset) {
  const boundary = source.indexOf("\nconst OS_NAME = (() => {");
  assert.ok(boundary > 0, "known desktop bootstrap boundary is required");
  const originalExports = source.slice(source.lastIndexOf("\nexport {"));
  const exportMap = new Map([...originalExports.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*,?\s*$/gm)]
    .map(match => [match[2], match[1]]));
  const aliases = new Set();
  for (const importedSource of externalSources) {
    const pattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    for (const match of importedSource.matchAll(pattern)) {
      if (path.posix.basename(match[2]) !== mainAsset) continue;
      for (const item of match[1].split(",")) {
        const parsed = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*$/.exec(item);
        if (parsed) aliases.add(parsed[1]);
      }
    }
  }
  const nativeExports = [...aliases].map(alias => {
    const local = exportMap.get(alias);
    assert.ok(local, "native dependency export " + alias + " exists in the installed main bundle");
    return local + " as " + alias;
  });
  return source.slice(0, boundary) + "\nexport {" + nativeExports.join(",") + "};\n" +
    "export {render$1 as render, splitProps, createComponent, mergeProps, insert, Show, createRenderEffect, setAttribute, classList, template$1 as template, delegateEvents, createSignal, createMemo, startTransition, memo$2 as memo, Tabs$1 as KobalteTabs, Tabs as LegacyTabs};\n" +
    "export {applyThemeCss, oc2ThemeJson};\n";
}

function settingsModule(source, modern, mainAsset, appVersion) {
  const templateStart = source.lastIndexOf("\nvar _tmpl$ = ");
  const exportStart = source.lastIndexOf("\nexport {");
  assert.ok(templateStart > 0 && exportStart > templateStart, "known settings component boundary is required");
  let helpers = "";
  const voiceHelper = source.match(/\/\*oc-voice-native-settings-(?:v2|legacy):helper:start\*\/[\s\S]*?\/\*oc-voice-native-settings-(?:v2|legacy):helper:end\*\//);
  assert.ok(voiceHelper, "managed native voice helper is required");
  if (modern) {
    const begin = source.indexOf("var _tmpl$$a = ");
    const marker = 'delegateEvents(["mousedown"]);';
    const end = source.indexOf(marker, begin);
    assert.ok(begin > 0 && end > begin, "native TabsV2 helper boundary is required");
    helpers = source.slice(begin, end + marker.length);
  }
  return `import {render, splitProps, createComponent, mergeProps, insert, Show, createRenderEffect, setAttribute, classList, template, delegateEvents, createSignal, createMemo, startTransition, memo, ${modern ? "KobalteTabs" : "LegacyTabs"} as Tabs} from "/assets/${mainAsset}";
const labels={"settings.section.desktop":"应用程序","settings.section.server":"服务器","settings.tab.general":"通用","settings.tab.shortcuts":"快捷键","status.popover.tab.servers":"服务器","settings.providers.title":"提供商","settings.models.title":"模型","app.name.desktop":"OpenCode"};
const useLanguage=()=>({t:key=>labels[key]||key,locale:()=>"zh",current:()=>"zh"});
const usePlatform=()=>({version:${JSON.stringify(appVersion)}});
const useDialog=()=>({show:()=>{}});
const useLayout=()=>({route:()=>({type:"draft",draftID:"isolated"})});
const useTabs=()=>({store:[]});
const useServerSync=()=>()=>({session:new Map()});
const useI18n=()=>({t:key=>key});
function Icon(props){const el=document.createElement("span");el.setAttribute("data-slot","icon-svg");el.style.cssText="width:16px;height:16px;display:inline-flex";el.textContent=props.name==="keyboard"?"⌘":"◇";return el}
const Icon$1=Icon;
function placeholder(title){return ()=>{const el=document.createElement("div");el.className="settings-v2-tab-header";el.textContent=title;return el}}
const SettingsGeneral=placeholder("通用"),SettingsGeneralV2=SettingsGeneral,SettingsKeybinds=placeholder("快捷键"),SettingsServers=placeholder("服务器"),SettingsServersV2=SettingsServers,SettingsProviders=placeholder("提供商"),SettingsProvidersV2=SettingsProviders,SettingsModels=placeholder("模型"),SettingsModelsV2=SettingsModels;
function Dialog(props){const shell=document.createElement("div");shell.setAttribute("role","dialog");shell.setAttribute("aria-label","OpenCode 设置");shell.setAttribute("data-component","dialog-v2");shell.setAttribute("data-variant","settings");shell.className="settings-v2-dialog";shell.innerHTML='<div data-slot="dialog-container" style="position:relative;width:900px;max-width:calc(100vw - 48px);height:650px;max-height:calc(100vh - 48px);border:1px solid var(--v2-border-border-base);border-radius:12px;overflow:hidden"><div data-slot="dialog-body" style="height:100%;width:100%"></div></div>';insert(shell.firstChild.firstChild,()=>props.children);return shell}
${helpers}
${voiceHelper[0]}
${source.slice(templateStart, exportStart)}
window.mountNativeSettings=()=>{if(window.disposeNativeSettings)window.disposeNativeSettings();window.disposeNativeSettings=render(()=>createComponent(DialogSettings,{}),document.getElementById("native-root"))};
window.mountNativeSettings();
`;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const original = fs.readFileSync(input), originalHash = patcher.sha256(original);
  const candidate = patcher.patchAsar(original, { platform: "windows",
    bridgeSource: fs.readFileSync(path.resolve("shared/desktop-bridge.cjs"), "utf8"),
    micSource: fs.readFileSync(path.resolve("shared/oc-mic.js"), "utf8") });
  const parsed = patcher.inspectAsarBuffer(candidate.buffer);
  const nativeModule = textEntry(candidate.buffer, parsed, "out/renderer/oc-voice-native-settings.js");
  const nativeAssetImports = [...nativeModule.matchAll(/from\s+["']\.\/assets\/([^"']+)["']/g)].map(match => match[1]);
  const graph = collectAssetGraph(candidate.buffer, parsed, nativeAssetImports);
  const assets = Object.keys(parsed.header.files.out.files.renderer.files.assets.files);
  const mainAsset = assets.find(name => /^main-.*\.js$/.test(name) && textEntry(candidate.buffer, parsed, "out/renderer/assets/" + name).includes("\nconst OS_NAME = (() => {"));
  const settingsAssets = assets.filter(name => /\.js$/.test(name)).filter(name => {
    const node = patcher.getEntry(parsed.header, "out/renderer/assets/" + name);
    return !node.unpacked && textEntry(candidate.buffer, parsed, "out/renderer/assets/" + name).includes("const DialogSettings = (props) => {");
  });
  assert.equal(settingsAssets.length, 2);
  assert.ok(mainAsset, "native main runtime module is present");
  const css = assets.find(name => /^main-.*\.css$/.test(name));
  const tabsCssAsset = assets.find(name => name.endsWith(".css") && name !== css && textEntry(candidate.buffer, parsed, "out/renderer/assets/" + name).includes('[data-component="tabs-v2"]'));
  assert.ok(tabsCssAsset, "native v2 tabs stylesheet is required");
  const rowSwitchPattern = /\[data-component="switch"\]\s*\{\s*position:\s*relative;\s*display:\s*flex;\s*align-items:\s*center;\s*gap:\s*8px;\s*cursor:\s*default;/;
  const rowCssAsset = assets.find(name => name.endsWith(".css") && rowSwitchPattern.test(textEntry(candidate.buffer, parsed, "out/renderer/assets/" + name)));
  assert.ok(rowCssAsset, "native Switch stylesheet is required");
  const mainSource = textEntry(candidate.buffer, parsed, "out/renderer/assets/" + mainAsset);
  graph.set(mainAsset, mainSource);
  const externalSources = [nativeModule, ...graph.values()];
  const runtimeSource = runtime(mainSource, externalSources, mainAsset);
  const resources = new Map([
    ["/oc-voice-native-settings.js", nativeModule],
    ["/native.css", textEntry(candidate.buffer, parsed, "out/renderer/assets/" + css)],
    ["/voice.js", fs.readFileSync(path.resolve("shared/oc-mic.js"), "utf8")],
    ["/theme.js", `import {applyThemeCss,oc2ThemeJson} from "/assets/${mainAsset}";window.setNativeTheme=mode=>applyThemeCss(oc2ThemeJson,"oc-2",mode);window.setNativeTheme("light");`],
    ["/favicon.ico", ""],
  ]);
  for (const [name, source] of graph) {
    resources.set("/assets/" + name, name === mainAsset ? runtimeSource : source);
    resources.set("/" + path.posix.basename(name), source);
  }
  for (const name of assets.filter(name => name.endsWith(".css"))) {
    const source = textEntry(candidate.buffer, parsed, "out/renderer/assets/" + name);
    resources.set("/assets/" + name, source);
    resources.set("/" + name, source);
  }
  for (const name of assets.filter(name => /\.(?:ttf|woff2?)$/i.test(name))) {
    resources.set("/assets/" + name, patcher.readEntry(candidate.buffer, parsed.dataStart, patcher.getEntry(parsed.header, "out/renderer/assets/" + name), name));
  }
  const results = [], errors = [];
  const themeDiagnostics = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (!resources.has(pathname)) { res.writeHead(404); return res.end(); }
    const mime = pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".woff2") ? "font/woff2" : pathname.endsWith(".woff") ? "font/woff" : pathname.endsWith(".ttf") ? "font/ttf" : "text/html; charset=utf-8";
    res.setHeader("Content-Type", mime);
    res.end(resources.get(pathname));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.OC_VOICE_TEST_BROWSER || undefined });
  try {
    for (const asset of settingsAssets) {
      const source = textEntry(candidate.buffer, parsed, "out/renderer/assets/" + asset), modern = source.includes("const TabsV2 = Object.assign(");
      const variant = modern ? "v2" : "legacy";
      const voiceContract = /import \{__ocVoiceNativePanel\} from "\.\.\/oc-voice-native-settings\.js";/.test(source);
      assert.ok(voiceContract, variant + " settings imports the native component module");
      resources.set("/settings.js", settingsModule(source, modern, mainAsset, candidate.version));
      const tabsCssLink = modern ? `<link rel="stylesheet" href="/assets/${tabsCssAsset}">` : "";
      resources.set("/", `<!doctype html><html lang="zh" data-color-scheme="light"><meta charset="utf-8"><link rel="stylesheet" href="/native.css">${tabsCssLink}<style>body{font-family:var(--v2-font-family-sans);background:var(--v2-background-bg-deep);min-height:100vh;margin:0}#native-root{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none}#native-root>.settings-v2-dialog{pointer-events:auto}.settings-v2-dialog{position:relative!important}</style><div id="native-root"></div><script type="module" src="/theme.js"></script><script type="module" src="/settings.js"></script></html>`);
      const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", error => errors.push({ variant, error: error.message }));
      page.on("console", message => { if (message.type() === "error") errors.push({ variant, console: message.text() }); });
      page.on("requestfailed", request => errors.push({ variant, request: request.url(), failure: request.failure()?.errorText }));
      page.on("response", response => { if (response.status() >= 400) errors.push({ variant, response: response.url(), status: response.status() }); });
      await page.addInitScript(() => {
        window.calls = { saves: [], saveKeyStates: [], reads: 0, warmups: 0, permissions: 0, previews: [], rewriteTests: [], draftActions: [] }; window.configEvents = []; window.settingsMode = "ok";
        const config = { backend: "auto", device: "auto", model_path: "/local/test-model", language: "auto", beam_size: 1, cpu_threads: 4, max_seconds: 120, idle_seconds: 1800, warmup_on_record: true, initial_prompt: "OpenCode", text_mode: "clean", punctuation_mode: "auto", space_mode: "preserve", vocabulary_preset: "coding", vocabulary: [], replacements: [], prompt_template: "{text}", rewrite_base_url: "", rewrite_model: "", rewrite_prompt: "", rewrite_timeout: 15, rewrite_key_configured: false };
        window.fakeVoiceConfig = config;
        window.ocMic = {
          getConfig: async () => { window.calls.reads++; if (window.settingsMode === "error") throw new Error("ECONNREFUSED"); if (window.settingsMode === "slow") await new Promise(resolve => setTimeout(resolve, 250)); return { ...config }; },
          saveConfig: async patch => {
            if (window.settingsMode === "save-error") return { error: "合成测试：配置写入失败", code: "TEST_SAVE" };
            const safePatch = { ...patch };
            if (Object.prototype.hasOwnProperty.call(safePatch, "rewrite_api_key")) {
              window.calls.saveKeyStates.push(safePatch.rewrite_api_key === "" ? "clear" : "set");
              config.rewrite_key_configured = safePatch.rewrite_api_key !== "";
              delete safePatch.rewrite_api_key;
            } else window.calls.saveKeyStates.push("omit");
            window.calls.saves.push(safePatch); Object.assign(config, safePatch); return { ...config };
          },
          previewText: async (text, overrides, key) => {
            window.calls.previews.push({ text, overrides: { ...overrides }, hasKey: typeof key === "string" && key.length > 0 });
            return { raw_text: text, local_text: text.replace(/\s+/g, " ").trim(), text: overrides.text_mode === "ai" ? "AI 示例结果" : text.replace(/\s+/g, " ").trim(), processing_warning: "", timings: { local_processing_ms: 4, total_ms: 4 } };
          },
          testRewrite: async (overrides, key) => {
            window.calls.rewriteTests.push({ overrides: { ...overrides }, hasKey: typeof key === "string" && key.length > 0, fixedText: "固定连接测试句" });
            return { ok: true, message: "连接测试成功" };
          },
          status: async () => ({ backend: "fake", device: "cuda", model_state: "ready" }),
          warmup: async () => { window.calls.warmups++; return { id: "warmup-test", state: "queued" }; },
        };
        window.lastVoiceResult = null;
        window.ocVoiceDraftActions = {
          perform: action => { window.calls.draftActions.push(action); return { ok: true }; },
          getLastResult: () => window.lastVoiceResult,
          restoreOriginal: () => { window.calls.draftActions.push("restoreOriginal"); return { ok: true }; },
          restoreLocal: () => { window.calls.draftActions.push("restoreLocal"); return { ok: true }; },
        };
        window.addEventListener("oc-voice-settings-updated", event => window.configEvents.push({ detail: event.detail, microphone: localStorage.getItem("oc-voice-microphone") }));
        navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "synthetic-device", label: "Synthetic microphone" }];
        navigator.mediaDevices.getUserMedia = async () => { window.calls.permissions++; throw new Error("settings must not request permission"); };
      });
      async function check(name, action) { await action(); results.push({ variant, name, status: "PASS" }); }
      const tab = value => page.locator(`[role="tab"][data-value="${value}"]`);
      const ready = () => page.waitForFunction(() => document.getElementById("oc-voice-settings-save") && !document.getElementById("oc-voice-settings-save").disabled);
      const panel = () => page.locator("#oc-voice-settings[data-oc-voice-native='true']");
      const select = name => page.locator(`[data-testid="oc-voice-${name}"]`);
      const textArea = name => page.locator(`textarea[data-testid="oc-voice-${name}"], [data-testid="oc-voice-${name}"] textarea, textarea#oc-voice-${name}`).first();
      const clickOption = async name => {
        const option = page.getByRole("option", { name });
        await option.waitFor();
        const box = await option.boundingBox();
        assert.ok(box, "native option is present: " + name);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await check("native settings tabs include voice beside general and shortcuts", async () => {
        await tab("general").waitFor();
        assert.deepEqual(await page.locator('[role="tab"]').evaluateAll(nodes => nodes.map(node => node.dataset.value)), ["general", "shortcuts", "voice-input", "servers", "providers", "models"]);
        assert.equal(await panel().count(), 0);
      });
      await check("voice panel uses native row, list, select, switch, input and button controls", async () => {
        await tab("shortcuts").click(); await tab("shortcuts").press("ArrowDown"); await ready();
        assert.equal(await tab("voice-input").getAttribute("aria-selected"), "true");
        const id = await tab("voice-input").getAttribute("aria-controls");
        assert.equal(await page.locator(`[id="${id}"] #oc-voice-settings`).count(), 1);
        assert.equal(await page.locator(`[id="${id}"]`).getAttribute("aria-labelledby"), await tab("voice-input").getAttribute("id"));
        assert.equal(await tab("general").getAttribute("aria-selected"), "false");
        const nav = await page.locator('[role="tablist"]').boundingBox(), content = await page.locator(`[id="${id}"]`).boundingBox();
        assert.ok(nav.x + nav.width <= content.x + 1, "native navigation remains beside the content panel");
        assert.equal(await panel().getAttribute("data-oc-voice-native"), "true");
        assert.ok(await panel().locator('[data-component="settings-v2-list"]').count() >= 3);
        assert.ok(await panel().locator('[data-slot="text-input-v2-input"]').count() >= 4);
        assert.ok(await panel().locator('[data-slot="switch-control"]').count() >= 1);
        assert.ok(await select("language").count() === 1);
        assert.match(await select("microphone").innerText(), /系统默认麦克风/);
        assert.ok(await panel().locator("#oc-voice-settings-save").getAttribute("data-component") || await panel().locator("#oc-voice-settings-save").evaluate(node => node.tagName) === "BUTTON");
        await page.waitForFunction(file => Array.from(document.styleSheets).some(sheet => sheet.href && new URL(sheet.href).pathname.endsWith(file)), rowCssAsset);
        assert.equal(await page.evaluate(() => window.calls.permissions), 0, "opening settings must not request microphone permission");
        assert.match(await select("language").innerText(), /自动检测/);
        await page.mouse.move(15, 15);
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-light.png`) });
        await page.evaluate(() => window.setNativeTheme("dark"));
        await page.waitForTimeout(100);
        const darkInputStyle = await page.evaluate(() => {
          const input = document.querySelector("#oc-voice-max-seconds");
          const wrapper = input?.closest('[data-component="text-input-v2"]');
          const matched = [];
          const scan = rules => { for (const rule of rules) { if (rule.cssRules) scan(rule.cssRules); if (rule.selectorText && input?.matches(rule.selectorText) && /background|color|appearance/.test(rule.cssText)) matched.push({ selector: rule.selectorText, cssText: rule.cssText.slice(0, 500) }); } };
          for (const sheet of document.styleSheets) { try { scan(sheet.cssRules); } catch (_) {} }
          const inputStyle = input && getComputedStyle(input), wrapperStyle = wrapper && getComputedStyle(wrapper), rootStyle = getComputedStyle(document.documentElement);
          const ancestors = []; for (let node = input; node && ancestors.length < 6; node = node.parentElement) { const cs = getComputedStyle(node); ancestors.push({ tag: node.tagName, id: node.id, classes: String(node.className || ""), component: node.getAttribute("data-component"), slot: node.getAttribute("data-slot"), background: cs.backgroundColor, color: cs.color, colorScheme: cs.colorScheme }); }
          return { scheme: document.documentElement.dataset.colorScheme, inputHtml: input?.outerHTML, parentHtml: input?.parentElement?.outerHTML.slice(0, 600), colorScheme: inputStyle?.colorScheme, inputBackground: inputStyle?.backgroundColor, inputColor: inputStyle?.color, wrapperBackground: wrapperStyle?.backgroundColor, wrapperColor: wrapperStyle?.color, tokens: { bgBase: rootStyle.getPropertyValue('--v2-background-bg-base').trim(), bgLayer: rootStyle.getPropertyValue('--v2-background-bg-layer-01').trim(), textBase: rootStyle.getPropertyValue('--v2-text-text-base').trim(), textMuted: rootStyle.getPropertyValue('--v2-text-text-muted').trim() }, ancestors, matched };
        });
        const darkTextFieldStyle = await page.evaluate(() => {
          const field = document.querySelector("#oc-voice-rewrite-prompt") || [...document.querySelectorAll("textarea")].find(node => node.getAttribute("data-testid") === "oc-voice-rewrite-prompt");
          const rootStyle = getComputedStyle(document.documentElement), ancestors = [];
          for (let node = field; node && ancestors.length < 7; node = node.parentElement) { const cs = getComputedStyle(node); ancestors.push({ tag: node.tagName, id: node.id, classes: String(node.className || ""), component: node.getAttribute("data-component"), slot: node.getAttribute("data-slot"), testid: node.getAttribute("data-testid"), background: cs.backgroundColor, color: cs.color, colorScheme: cs.colorScheme }); }
          const matched = [];
          const scan = rules => { for (const rule of rules) { if (rule.cssRules) scan(rule.cssRules); if (field && rule.selectorText) { try { if (field.matches(rule.selectorText) && /background|color|appearance/.test(rule.cssText)) matched.push({ selector: rule.selectorText, cssText: rule.cssText.slice(0, 400) }); } catch (_) {} } } };
          for (const sheet of document.styleSheets) { try { scan(sheet.cssRules); } catch (_) {} }
          const style = field && getComputedStyle(field);
          return { found: !!field, html: field?.outerHTML, background: style?.backgroundColor, color: style?.color, colorScheme: style?.colorScheme, tokens: { bgBase: rootStyle.getPropertyValue('--v2-background-bg-base').trim(), textBase: rootStyle.getPropertyValue('--v2-text-text-base').trim() }, ancestors, matched };
        });
        themeDiagnostics.push({ variant, darkInputStyle, darkTextFieldStyle });
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-dark.png`), animations: "disabled" });
        await page.evaluate(() => window.setNativeTheme("light"));
        await page.waitForTimeout(100);
        const backendTrigger = select("backend").locator('[data-component="select-v2"]');
        const backendBeforeClick = await backendTrigger.innerText();
        assert.match(backendBeforeClick, /自动选择/);
        const backendTriggerBox = await backendTrigger.boundingBox();
        await backendTrigger.click();
        const fasterOption = page.getByRole("option", { name: "faster-whisper" });
        await fasterOption.waitFor();
        const backendTriggerAfterOpen = await backendTrigger.boundingBox();
        assert.ok(Math.abs(backendTriggerAfterOpen.x - backendTriggerBox.x) < 1 && Math.abs(backendTriggerAfterOpen.y - backendTriggerBox.y) < 1, "opening a portal must not shift the native settings dialog");
        const menuBox = await page.locator('[data-slot="select-v2-content"][data-expanded]').boundingBox();
        assert.ok(menuBox && (menuBox.x + menuBox.width <= backendTriggerBox.x || backendTriggerBox.x + backendTriggerBox.width <= menuBox.x || menuBox.y + menuBox.height <= backendTriggerBox.y || backendTriggerBox.y + backendTriggerBox.height <= menuBox.y), "native backend menu must not overlap its trigger");
        assert.equal(await backendTrigger.innerText(), backendBeforeClick, "opening the native Select must not select an option");
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-model-dropdown.png`) });
        await backendTrigger.press("Escape");
        assert.equal(await backendTrigger.innerText(), backendBeforeClick, "opening and dismissing the native Select must not change its value");
        await page.setViewportSize({ width: 1180, height: 570 });
        const deviceTrigger = select("device").locator('[data-component="select-v2"]');
        await deviceTrigger.scrollIntoViewIfNeeded();
        const deviceTriggerBox = await deviceTrigger.boundingBox();
        await deviceTrigger.click();
        const cpuOption = page.getByRole("option", { name: "CPU", exact: true });
        await cpuOption.waitFor();
        const deviceMenu = await page.locator('[data-slot="select-v2-content"][data-expanded]').boundingBox();
        assert.ok(deviceMenu && (deviceMenu.x + deviceMenu.width <= deviceTriggerBox.x || deviceTriggerBox.x + deviceTriggerBox.width <= deviceMenu.x || deviceMenu.y + deviceMenu.height <= deviceTriggerBox.y || deviceTriggerBox.y + deviceTriggerBox.height <= deviceMenu.y), "native device menu must not overlap its trigger near the viewport edge");
        const listbox = page.locator('[data-slot="select-v2-listbox"]');
        const listMetrics = await listbox.evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY }));
        assert.ok(listMetrics.clientHeight > 0 && (listMetrics.scrollHeight <= listMetrics.clientHeight || listMetrics.overflowY === "auto" || listMetrics.overflowY === "scroll"), "native device options remain accessible when viewport space is limited");
        await cpuOption.click();
        assert.match(await deviceTrigger.innerText(), /^CPU$/);
        await page.setViewportSize({ width: 1180, height: 860 });
      });
      await check("native language and microphone selectors update the saved values", async () => {
        await select("language").click();
        await clickOption("English");
        const micSelect = select("microphone");
        await micSelect.click();
        await clickOption("Synthetic microphone");
        await page.keyboard.press("Escape");
        await page.locator("#oc-voice-settings .settings-v2-tab-title").click();
        assert.equal(await page.locator("#oc-voice-runtime").textContent(), "模型已就绪 · GPU / CUDA");
      });
      await check("save and reopen preserve settings, microphone event follows storage commit", async () => {
        await page.locator("[data-oc-voice-advanced]").evaluate(node => { node.open = true; });
        assert.ok(await page.locator("#oc-voice-beam-size").isVisible());
        await page.locator("#oc-voice-beam-size").fill("2");
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 1);
        assert.equal(await page.evaluate(() => window.calls.saves[0].beam_size), 2);
        assert.equal(await page.evaluate(() => window.calls.saves[0].language), "en");
        assert.equal(await page.evaluate(() => window.configEvents.at(-1).microphone), "synthetic-device");
        await tab("general").click(); assert.equal(await panel().count(), 0);
        await tab("voice-input").click(); await ready();
        assert.equal(await page.locator("#oc-voice-beam-size").inputValue(), "2");
        assert.equal(await page.locator("#oc-voice-max-seconds").isDisabled(), false);
        assert.equal(await page.evaluate(() => localStorage.getItem("oc-voice-microphone")), "synthetic-device");
        await page.locator("[data-oc-voice-advanced]").evaluate(node => { node.open = true; });
        assert.ok(await page.locator("#oc-voice-cpu-threads").isVisible());
        await page.locator("[data-oc-voice-advanced]").scrollIntoViewIfNeeded();
        assert.equal(await page.locator("#oc-voice-beam-size").inputValue(), "2");
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-advanced.png`) });
        await page.locator("[data-oc-voice-advanced]").evaluate(node => { node.open = false; });
        await panel().scrollIntoViewIfNeeded();
        await page.locator(".settings-v2-tab-body").evaluate(node => { node.scrollTop = 0; });
        await page.evaluate(() => window.mountNativeSettings()); await tab("voice-input").click(); await ready();
        assert.equal(await page.locator("#oc-voice-beam-size").inputValue(), "2");
        assert.equal(await panel().count(), 1);
      });
      await check("read and write errors recover without enabling an invalid save", async () => {
        await page.evaluate(() => { window.settingsMode = "error"; });
        await page.locator("#oc-voice-settings-reload").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent);
        assert.equal(await page.locator("#oc-voice-settings-save").isDisabled(), true);
        await page.evaluate(() => { window.settingsMode = "ok"; });
        await page.locator("#oc-voice-settings-reload").click(); await ready();
        await page.locator("#oc-voice-model-path").fill("");
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("已下载模型"));
        assert.equal(await page.evaluate(() => window.calls.saves.length), 1);
        await page.locator("#oc-voice-model-path").fill("/local/test-model");
        await page.evaluate(() => { window.settingsMode = "save-error"; });
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("配置写入失败"));
        assert.equal(await page.locator("#oc-voice-settings-save").isEnabled(), true);
      });
      await check("text settings default locally and explain only fixed Enter/Esc actions", async () => {
        await page.evaluate(() => { window.settingsMode = "ok"; });
        await page.locator("#oc-voice-settings-reload").click(); await ready();
        assert.match(await select("text-mode").innerText(), /轻度整理/);
        assert.match(await select("punctuation-mode").innerText(), /自动/);
        await select("punctuation-mode").click();
        await page.getByRole("option", { name: "保持原标点" }).waitFor();
        await page.keyboard.press("Escape");
        assert.match(await select("punctuation-mode").innerText(), /自动/, "the none option is accurately labeled without changing default");
        assert.match(await select("space-mode").innerText(), /保持空格/);
        assert.match(await select("vocabulary-preset").innerText(), /编程词表/);
        assert.equal(await page.locator("#oc-voice-rewrite-base-url").count(), 0, "AI-only fields stay hidden by default");
        assert.equal(await page.locator("[data-oc-voice-section='text-tools']").evaluate(node => node.open), false, "text tools start collapsed");
        assert.match(await panel().innerText(), /Enter 结束录音；Esc 取消/);
        assert.doesNotMatch(await panel().innerText(), /快捷键配置|设置快捷键|全局快捷键/);
        await select("text-mode").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-text-processing.png`), animations: "disabled" });
      });
      await check("custom templates validate and persist without sample or preview controls", async () => {
        await select("text-mode").click(); await clickOption("自定义模板");
        const template = textArea("prompt-template");
        await template.waitFor();
        await template.fill("整理：");
        const savesBefore = await page.evaluate(() => window.calls.saves.length);
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("{text}"));
        assert.equal(await page.evaluate(() => window.calls.saves.length), savesBefore, "invalid template is stopped locally");
        await template.fill("整理以下语音并保留原意：{text}");
        assert.equal(await page.locator('#oc-voice-preview-sample, #oc-voice-preview-run, [data-testid="oc-voice-preview-result"]').count(), 0);
        assert.equal(await page.evaluate(() => window.calls.previews.length), 0, "settings never run sample processing");
        assert.equal(await page.evaluate(() => window.calls.rewriteTests.length), 0);
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 2);
        assert.equal(await page.evaluate(() => window.calls.saves.at(-1).text_mode), "custom");
        await tab("general").click(); await tab("voice-input").click(); await ready();
        assert.match(await select("text-mode").innerText(), /自定义模板/);
        assert.equal(await textArea("prompt-template").inputValue(), "整理以下语音并保留原意：{text}", "custom template survives closing and reopening settings");
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-template.png`), animations: "disabled" });
      });
      await check("vocabulary editor strictly imports and exports only vocabulary data", async () => {
        const details = page.locator("[data-oc-voice-section='vocabulary']");
        assert.equal(await details.evaluate(node => node.open), false);
        await details.evaluate(node => { node.open = true; });
        await textArea("vocabulary-list").fill("OpenCode\nWhisper");
        await textArea("replacements-list").fill("开代码 => OpenCode");
        const savesBeforeInvalidRule = await page.evaluate(() => window.calls.saves.length);
        await textArea("replacements-list").fill("缺少规则分隔符");
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("错误写法"));
        assert.equal(await page.evaluate(() => window.calls.saves.length), savesBeforeInvalidRule, "malformed correction rules are rejected locally");
        await textArea("replacements-list").fill("开代码 => OpenCode");
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          page.locator("#oc-voice-vocabulary-export").click(),
        ]);
        const exportPath = path.join(output, `native-settings-${variant}-vocabulary-export.json`);
        await download.saveAs(exportPath);
        const exported = JSON.parse(fs.readFileSync(exportPath, "utf8"));
        assert.deepEqual(Object.keys(exported).sort(), ["replacements", "schema", "version", "vocabulary", "vocabulary_preset"]);
        assert.deepEqual(exported.vocabulary, ["OpenCode", "Whisper"]);
        assert.deepEqual(exported.replacements, [{ from: "开代码", to: "OpenCode" }]);
        assert.equal(JSON.stringify(exported).includes("rewrite_api_key"), false);
        const imported = { schema: "opencode-local-voice/vocabulary", version: 1, vocabulary_preset: "coding", vocabulary: ["SolidJS", "Whisper.cpp"], replacements: [{ from: "固体 JS", to: "SolidJS" }] };
        const fileInput = page.locator('[data-testid="oc-voice-vocabulary-file"]');
        await fileInput.setInputFiles({ name: "vocabulary.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
        await page.getByText("词表已导入；保存后生效").waitFor();
        assert.equal(await textArea("vocabulary-list").inputValue(), "SolidJS\nWhisper.cpp");
        assert.equal(await textArea("replacements-list").inputValue(), "固体 JS => SolidJS");
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => window.calls.saves.length === 3);
        assert.deepEqual(await page.evaluate(() => window.calls.saves.at(-1).vocabulary), imported.vocabulary);
        assert.deepEqual(await page.evaluate(() => window.calls.saves.at(-1).replacements), imported.replacements);
        await tab("general").click(); await tab("voice-input").click(); await ready();
        await details.evaluate(node => { node.open = true; });
        assert.equal(await textArea("vocabulary-list").inputValue(), "SolidJS\nWhisper.cpp", "imported vocabulary survives closing and reopening settings");
        assert.equal(await textArea("replacements-list").inputValue(), "固体 JS => SolidJS");
        await details.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-vocabulary.png`), animations: "disabled" });
        await fileInput.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...imported, rewrite_api_key: "NEVER-EXPORT-OR-IMPORT" })) });
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("不支持的字段"));
        const oversized = Buffer.from(JSON.stringify(imported) + " ".repeat(66000));
        await fileInput.setInputFiles({ name: "too-large.json", mimeType: "application/json", buffer: oversized });
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("不能超过 64 KB"));
        assert.equal(await textArea("vocabulary-list").inputValue(), "SolidJS\nWhisper.cpp", "rejected imports do not replace current edits");
      });
      await check("vocabulary and correction limits reject invalid edits before saving", async () => {
        const vocab = textArea("vocabulary-list"), rules = textArea("replacements-list");
        const originalVocab = await vocab.inputValue(), originalRules = await rules.inputValue();
        const before = await page.evaluate(() => window.calls.saves.length);
        const invalidEdits = [
          [vocab, Array.from({ length: 101 }, (_, index) => "term" + index).join("\n"), "100 项"],
          [vocab, "x".repeat(81), "80 个字符"],
          [vocab, Array.from({ length: 100 }, (_, index) => "x".repeat(42) + index).join("\n"), "4096"],
          [rules, "bad => good\nbad => another", "不能重复"],
          [rules, "x".repeat(81) + " => good", "80 个字符"],
        ];
        for (const [field, value, message] of invalidEdits) {
          await vocab.fill(originalVocab); await rules.fill(originalRules);
          await field.fill(value); await page.locator("#oc-voice-settings-save").click();
          await page.waitForFunction(message => document.getElementById("oc-voice-settings-error").textContent.includes(message), message);
          assert.equal(await page.evaluate(() => window.calls.saves.length), before, "invalid edits never reach the backend");
        }
        await vocab.fill(originalVocab); await rules.fill(originalRules);
        assert.equal(await textArea("prompt-template").getAttribute("maxlength"), "6000");
      });
      await check("AI runs only by explicit buttons and its write-only key never returns", async () => {
        const testsBefore = await page.evaluate(() => window.calls.rewriteTests.length);
        const previewsBefore = await page.evaluate(() => window.calls.previews.length);
        await select("text-mode").click(); await clickOption("AI 改写");
        await page.locator("#oc-voice-rewrite-base-url").waitFor();
        assert.equal(await page.evaluate(() => window.calls.rewriteTests.length), testsBefore, "selecting AI does not contact the endpoint");
        await page.locator("#oc-voice-rewrite-base-url").fill("https://ai.example.test/v1");
        const savesBeforeMissingModel = await page.evaluate(() => window.calls.saves.length);
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("AI 兼容接口地址和模型名称"));
        assert.equal(await page.evaluate(() => window.calls.saves.length), savesBeforeMissingModel, "AI mode requires a model before save");
        await page.locator("#oc-voice-rewrite-model").fill("test-model");
        await textArea("rewrite-prompt").fill("保留技术术语");
        const savesBeforeInvalidTimeout = await page.evaluate(() => window.calls.saves.length);
        await page.locator("#oc-voice-rewrite-timeout").fill("4");
        await page.locator("#oc-voice-settings-save").click();
        await page.waitForFunction(() => document.getElementById("oc-voice-settings-error").textContent.includes("AI 请求超时"));
        assert.equal(await page.evaluate(() => window.calls.saves.length), savesBeforeInvalidTimeout, "invalid AI timeout is rejected before save");
        await page.locator("#oc-voice-rewrite-timeout").fill("15");
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 4);
        assert.equal(await page.evaluate(() => Object.hasOwn(window.calls.saves.at(-1), "rewrite_api_key")), false, "AI settings save without a key leaves the key untouched");
        assert.equal(await page.evaluate(() => window.calls.previews.length), previewsBefore, "saving AI mode does not preview or contact the model");
        assert.equal(await page.evaluate(() => window.calls.rewriteTests.length), testsBefore, "saving AI mode does not run a connection test");
        assert.match(await page.locator('[data-testid="oc-voice-rewrite-key-status"]').innerText(), /尚未保存密钥/);
        const aiSection = page.locator(".settings-v2-section").filter({ has: page.locator("#oc-voice-rewrite-base-url") });
        await page.locator("#oc-voice-rewrite-base-url").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-ai-light.png`), animations: "disabled" });
        await page.evaluate(() => window.setNativeTheme("dark")); await page.waitForTimeout(100);
        const darkPromptStyle = await page.evaluate(() => {
          const field = document.querySelector("#oc-voice-rewrite-prompt") || [...document.querySelectorAll("textarea")].find(node => node.getAttribute("data-testid") === "oc-voice-rewrite-prompt");
          const ancestors = [];
          for (let node = field; node && ancestors.length < 7; node = node.parentElement) { const style = getComputedStyle(node); ancestors.push({ tag: node.tagName, id: node.id, classes: String(node.className || ""), component: node.getAttribute("data-component"), slot: node.getAttribute("data-slot"), testid: node.getAttribute("data-testid"), background: style.backgroundColor, color: style.color, colorScheme: style.colorScheme }); }
          const matched = [];
          const scan = rules => { for (const rule of rules) { if (rule.cssRules) scan(rule.cssRules); if (field && rule.selectorText) { try { if (field.matches(rule.selectorText) && /background|color|appearance/.test(rule.cssText)) matched.push({ selector: rule.selectorText, cssText: rule.cssText.slice(0, 400) }); } catch (_) {} } } };
          for (const sheet of document.styleSheets) { try { scan(sheet.cssRules); } catch (_) {} }
          const style = field && getComputedStyle(field), root = getComputedStyle(document.documentElement);
          return { found: !!field, html: field?.outerHTML, background: style?.backgroundColor, color: style?.color, colorScheme: style?.colorScheme, tokens: { bgBase: root.getPropertyValue("--v2-background-bg-base").trim(), textBase: root.getPropertyValue("--v2-text-text-base").trim() }, ancestors, matched };
        });
        themeDiagnostics.push({ variant, darkPromptStyle });
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-ai-dark.png`), animations: "disabled" });
        await page.evaluate(() => window.setNativeTheme("light")); await page.waitForTimeout(100);
        await page.locator("#oc-voice-rewrite-api-key").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-ai-credentials.png`), animations: "disabled" });
        await page.locator("#oc-voice-rewrite-api-key").fill("TEST-SECRET-DO-NOT-LEAK");
        await page.locator("#oc-voice-rewrite-test").click();
        await page.waitForFunction(() => window.calls.rewriteTests.length === 1);
        assert.equal(await page.evaluate(() => window.calls.rewriteTests[0].fixedText), "固定连接测试句");
        assert.equal(await page.evaluate(() => window.calls.rewriteTests[0].hasKey), true);
        assert.equal(await page.evaluate(() => window.calls.previews.length), previewsBefore, "testing the connection does not run a transcript preview");
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 5);
        assert.equal(await page.evaluate(() => window.calls.saveKeyStates.at(-1)), "set");
        assert.equal(await page.evaluate(() => Object.hasOwn(window.calls.saves.at(-1), "rewrite_api_key")), false);
        assert.match(await page.locator('[data-testid="oc-voice-rewrite-key-status"]').innerText(), /已保存密钥（不会回显）/);
        assert.equal(await page.locator("#oc-voice-rewrite-api-key").inputValue(), "");
        assert.equal(await page.evaluate(() => JSON.stringify({ config: window.fakeVoiceConfig, calls: window.calls, storage: Object.fromEntries(Object.entries(localStorage)) }).includes("TEST-SECRET-DO-NOT-LEAK")), false);
        await tab("general").click(); await tab("voice-input").click(); await ready();
        await select("text-mode").click(); await clickOption("轻度整理");
        assert.equal(await page.locator("#oc-voice-rewrite-base-url").count(), 0, "AI settings hide outside AI mode after reopen");
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 6);
        assert.equal(await page.evaluate(() => window.calls.saveKeyStates.at(-1)), "omit", "blank key does not clear a saved credential");
        assert.equal(await page.evaluate(() => window.fakeVoiceConfig.rewrite_key_configured), true);
        await select("text-mode").click(); await clickOption("AI 改写"); await page.locator("#oc-voice-rewrite-base-url").waitFor();
        await page.locator("#oc-voice-rewrite-clear-key").click();
        assert.match(await page.locator("#oc-voice-rewrite-clear-key").innerText(), /撤销清除密钥/);
        await page.locator("#oc-voice-settings-save").click(); await page.waitForFunction(() => window.calls.saves.length === 7);
        assert.equal(await page.evaluate(() => window.calls.saveKeyStates.at(-1)), "clear");
        assert.equal(await page.evaluate(() => window.fakeVoiceConfig.rewrite_key_configured), false);
        assert.equal(await page.locator("#oc-voice-rewrite-api-key").inputValue(), "");
      });
      await check("collapsed text tools call only the explicit draft actions", async () => {
        const tools = page.locator("[data-oc-voice-section='text-tools']");
        assert.equal(await tools.evaluate(node => node.open), false);
        await page.evaluate(() => {
          window.lastVoiceResult = { raw_text: "原始语音", local_text: "本地语音", text: "最终语音", processing_warning: "AI 未启用" };
          window.dispatchEvent(new Event("oc-voice-result-updated"));
        });
        await tools.evaluate(node => { node.open = true; });
        assert.equal(await page.locator('[data-testid="oc-voice-recent-result"]').count(), 0);
        const settingsText = await panel().innerText();
        for (const hidden of ["原始语音", "本地语音", "最终语音", "预览示例", "预览效果", "预览结果", "最近语音结果"]) assert.ok(!settingsText.includes(hidden), "settings must not display samples or recognized text: " + hidden);
        assert.equal(await page.evaluate(() => window.calls.previews.length), 0);
        await page.locator("#oc-voice-draft-insertComma").click();
        await page.locator("#oc-voice-draft-insertSpace").click();
        await page.locator("#oc-voice-draft-spaceToComma").click();
        await page.locator("#oc-voice-draft-commaToSpace").click();
        await page.locator("#oc-voice-restore-original").click();
        await page.locator("#oc-voice-restore-local").click();
        assert.deepEqual(await page.evaluate(() => window.calls.draftActions), ["insertComma", "insertSpace", "spaceToComma", "commaToSpace", "restoreOriginal", "restoreLocal"]);
        assert.equal(await page.locator('[data-testid="oc-voice-draft-action-status"]').innerText(), "已恢复本地处理文本", "the result label describes the completed operation rather than an internal action id");
        assert.equal(await page.evaluate(() => window.calls.permissions), 0, "text tools do not request a microphone");
        await page.setViewportSize({ width: 620, height: 760 });
        await page.locator("#oc-voice-restore-local").scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "native settings remain within a narrow viewport");
        await page.screenshot({ path: path.join(output, `native-settings-${variant}-text-tools-narrow.png`), animations: "disabled" });
        await page.setViewportSize({ width: 1180, height: 860 });
      });
      await check("late reads clean up when settings unmount and narrow layout stays bounded", async () => {
        const configEventsBefore = await page.evaluate(() => window.configEvents.length);
        await page.evaluate(() => { window.settingsMode = "slow"; });
        await page.locator("#oc-voice-settings-reload").click(); await tab("general").click(); await page.waitForTimeout(300);
        assert.equal(await panel().count(), 0);
        assert.equal(await page.evaluate(() => window.configEvents.length), configEventsBefore, "late getConfig must not emit a config event after native panel cleanup");
        await page.evaluate(() => { window.settingsMode = "ok"; }); await tab("voice-input").click(); await ready();
        await page.setViewportSize({ width: 620, height: 760 });
        assert.equal(await page.locator('[role="dialog"]').count(), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await panel().count(), 1);
      });
      await check("real capture results can be restored and converted from native settings while the prompt is modal-inert", async () => {
        await page.evaluate(() => {
          const form = document.createElement("form");
          form.dataset.component = "prompt-input-v2";
          form.id = "voice-draft-integration-form";
          form.style.cssText = "position:fixed;left:24px;right:24px;bottom:20px;min-height:88px;padding:16px;z-index:2;background:var(--v2-background-bg-base,#fff);border:1px solid var(--v2-border-border-base,#888);border-radius:8px";
          form.innerHTML = '<div id="voice-draft-integration-editor" data-component="prompt-input" contenteditable="true" style="min-height:28px">Keep this <span contenteditable="false" data-mention="1">@src/main.ts</span> and continue</div><div data-component="prompt-toolbar" style="display:flex;justify-content:flex-end;min-height:32px"><button type="submit" data-action="prompt-submit">Send</button></div>';
          form.addEventListener("submit", event => { event.preventDefault(); window.calls.submissions++; });
          document.body.append(form);
          window.calls.syntheticCaptures = 0;
          window.calls.transcription = 0;
          window.calls.submissions = 0;
          window.calls.realMicCalls = 0;
          window.calls.captureConstraints = null;
          window.calls.transcribedAudio = null;
          window.calls.previewsBeforeCapture = window.calls.previews.length;
          window.calls.rewriteTestsBeforeCapture = window.calls.rewriteTests.length;
          window.ocVoiceDraftActions = null;
          window.ocMic.transcribe = async (bytes, mime, id) => {
            window.calls.transcription++;
            const view = new DataView(bytes);
            window.calls.transcribedAudio = { mime, rate: view.getUint32(24, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true), bytes: bytes.byteLength, id };
            await new Promise(resolve => setTimeout(resolve, 30));
            return { text: "final speech", raw_text: "raw speech", local_text: "local speech", processing_warning: null, timings: { total_ms: 30 } };
          };
          window.ocMic.cancel = async id => ({ id, state: "cancelled" });
          window.ocMic.onProgress = () => () => {};
          window.ocMic.getConfig = async () => ({ ...window.fakeVoiceConfig, warmup_on_record: false });
          window.syntheticAudioStreams = [];
          navigator.mediaDevices.getUserMedia = async constraints => {
            window.calls.syntheticCaptures++;
            window.calls.captureConstraints = constraints;
            const audio = new AudioContext();
            const oscillator = audio.createOscillator();
            const destination = audio.createMediaStreamDestination();
            oscillator.frequency.value = 330;
            oscillator.connect(destination);
            oscillator.start();
            await audio.resume();
            const stream = destination.stream;
            stream.getTracks().forEach(track => {
              const stop = track.stop.bind(track);
              track.stop = () => { stop(); try { oscillator.stop(); } catch (_) {} void audio.close(); };
            });
            window.syntheticAudioStreams.push(stream);
            return stream;
          };
          navigator.clipboard.writeText = async () => {};
          const dialogShell = document.querySelector(".settings-v2-dialog");
          dialogShell.dataset.integrationOriginalDisplay = dialogShell.style.display;
          dialogShell.style.display = "none";
        });

        await page.addScriptTag({ path: path.resolve("shared/oc-mic.js") });
        await page.locator("#oc-mic-controls").waitFor();
        const editor = page.locator("#voice-draft-integration-editor");
        const originalDraft = await editor.textContent();
        await page.locator("#oc-mic-btn").click();
        await page.waitForFunction(() => document.querySelector("#oc-mic-controls")?.dataset.state === "recording");
        await page.waitForTimeout(700);
        await page.keyboard.press("Enter");
        try {
          await page.waitForFunction(() => document.querySelector("#oc-mic-controls")?.dataset.state === "idle" && document.querySelector("#voice-draft-integration-editor")?.textContent.endsWith("final speech"));
        } catch (error) {
          const diagnostic = await page.evaluate(() => ({ state: document.querySelector("#oc-mic-controls")?.dataset.state,
            status: document.querySelector(".oc-mic-status")?.textContent, editor: document.querySelector("#voice-draft-integration-editor")?.textContent,
            captureCalls: window.calls.syntheticCaptures, transcribeCalls: window.calls.transcription, micError: window.calls.micError || null }));
          throw new Error(error.message + "; synthetic recording diagnostic=" + JSON.stringify(diagnostic));
        }

        const expectedFinal = originalDraft + " final speech";
        assert.equal(await editor.textContent(), expectedFinal);
        assert.equal(await page.locator("#voice-draft-integration-editor [data-mention]").count(), 1);
        assert.deepEqual(await page.evaluate(() => window.ocVoiceDraftActions.getLastResult()), {
          raw_text: "raw speech", local_text: "local speech", text: "final speech", processing_warning: null,
        });
        const recordingEvidence = await page.evaluate(() => ({ captures: window.calls.syntheticCaptures, transcription: window.calls.transcription,
          submissions: window.calls.submissions, physicalMicCalls: window.calls.realMicCalls, permissions: window.calls.permissions,
          audio: window.calls.transcribedAudio, previewsBefore: window.calls.previewsBeforeCapture, previewsAfter: window.calls.previews.length,
          rewriteTestsBefore: window.calls.rewriteTestsBeforeCapture, rewriteTestsAfter: window.calls.rewriteTests.length }));
        assert.equal(recordingEvidence.captures, 1);
        assert.equal(recordingEvidence.transcription, 1);
        assert.equal(recordingEvidence.submissions, 0);
        assert.equal(recordingEvidence.physicalMicCalls, 0);
        assert.equal(recordingEvidence.permissions, 0);
        assert.deepEqual({ mime: recordingEvidence.audio.mime, rate: recordingEvidence.audio.rate, channels: recordingEvidence.audio.channels, bits: recordingEvidence.audio.bits },
          { mime: "audio/wav", rate: 16000, channels: 1, bits: 16 });
        assert.ok(recordingEvidence.audio.bytes > 1000, "the client converted nonempty synthesized audio to WAV");
        assert.equal(recordingEvidence.previewsAfter, recordingEvidence.previewsBefore, "recording does not invoke AI preview");
        assert.equal(recordingEvidence.rewriteTestsAfter, recordingEvidence.rewriteTestsBefore, "recording does not invoke AI connection test");
        assert.match(recordingEvidence.audio.id, /^[0-9a-f-]{20,}$/i);

        await page.evaluate(() => {
          const shell = document.querySelector(".settings-v2-dialog");
          shell.style.display = shell.dataset.integrationOriginalDisplay || "";
          const modal = document.createElement("dialog");
          modal.id = "native-settings-integration-modal";
          modal.setAttribute("aria-label", "OpenCode 设置（模态集成测试壳）");
          modal.style.cssText = "position:fixed;inset:0;margin:auto;padding:0;width:900px;height:650px;max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);border:0;background:transparent;color:inherit;overflow:visible";
          shell.parentNode.insertBefore(modal, shell);
          modal.append(shell);
          modal.showModal();
          document.querySelector("#voice-draft-integration-form").inert = true;
        });
        await page.locator("#native-settings-integration-modal[open]").waitFor();
        const textTools = page.locator("[data-oc-voice-section='text-tools']");
        await textTools.evaluate(node => { node.open = true; });
        await page.locator("#oc-voice-restore-original").scrollIntoViewIfNeeded();
        await page.locator("#oc-voice-restore-original").focus();
        assert.equal(await page.evaluate(() => document.querySelector("#voice-draft-integration-form").inert), true, "the prompt is inert behind the native modal");
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#voice-draft-integration-editor")), false, "the editor cannot keep focus while settings are modal");
        assert.equal(await page.evaluate(() => document.querySelector("#native-settings-integration-modal").contains(document.activeElement)), true, "initial focus remains in the modal dialog");

        async function runDraftButton(selector, expected, statusText) {
          await page.locator(selector).click();
          await page.waitForFunction(({ expectedText, expectedStatus }) => {
            const editorNode = document.querySelector("#voice-draft-integration-editor");
            return editorNode && editorNode.textContent === expectedText && document.querySelector("#native-settings-integration-modal").contains(document.activeElement) &&
              document.querySelector('[data-testid="oc-voice-draft-action-status"]')?.textContent === expectedStatus;
          }, { expectedText: expected, expectedStatus: statusText });
          assert.equal(await page.locator("#voice-draft-integration-editor [data-mention]").count(), 1, "the file mention remains intact");
          assert.equal(await editor.textContent(), expected);
        }
        await runDraftButton("#oc-voice-restore-original", originalDraft + " raw speech", "已恢复原始识别文本");
        await runDraftButton("#oc-voice-restore-local", originalDraft + " local speech", "已恢复本地处理文本");
        await runDraftButton("#oc-voice-draft-spaceToComma", originalDraft + " local,speech", "已将文字中的空格转换为逗号");
        await runDraftButton("#oc-voice-draft-commaToSpace", originalDraft + " local speech", "已将文字中的逗号转换为空格");
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#voice-draft-integration-editor")), false, "draft tools never move focus out of settings");
        assert.deepEqual(await page.evaluate(() => ({ submissions: window.calls.submissions, captures: window.calls.syntheticCaptures,
          transcriptions: window.calls.transcription, previews: window.calls.previews.length, rewriteTests: window.calls.rewriteTests.length,
          mentions: document.querySelectorAll("#voice-draft-integration-editor [data-mention]").length })), {
          submissions: 0, captures: 1, transcriptions: 1,
          previews: await page.evaluate(() => window.calls.previewsBeforeCapture), rewriteTests: await page.evaluate(() => window.calls.rewriteTestsBeforeCapture), mentions: 1,
        });
      });
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.equal(patcher.sha256(fs.readFileSync(input)), originalHash);
  } finally {
    fs.writeFileSync(path.join(output, "native-settings-report.json"), JSON.stringify({ appVersion: candidate.version, originalHash, originalUnchanged: patcher.sha256(fs.readFileSync(input)) === originalHash,
      actualNativeSettingsControls: true, actualNativeSettingsAndTabs: true, appProviders: "isolated test doubles", appDialogShell: "isolated settings shell; combined draft case wrapped in real HTMLDialogElement.showModal() with native inert/focus semantics", nonVoiceSettings: "test doubles", themeSource: "installed main CSS data-color-scheme tokens", themeDiagnostics, actualAppStarted: false, realMicrophone: false, results, errors }, null, 2));
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
