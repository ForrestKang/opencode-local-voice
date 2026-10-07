"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const HEADER_JSON_OFFSET = 16;
const BLOCK_SIZE = 4 * 1024 * 1024;
const MAIN = "out/main/index.js";
const PRELOAD = "out/preload/index.js";
const HTML = "out/renderer/index.html";
const BRIDGE = "out/main/oc-voice-bridge.cjs";
const RENDERER = "out/renderer/oc-voice-v2.js";
const NATIVE_UI = "out/renderer/oc-voice-native-settings.js";
const UPDATE_BRIDGE = "out/main/oc-voice-update.cjs";
const NATIVE_SETTINGS_ASSET_ROOT = "out/renderer/assets/";
const NATIVE_SETTINGS_V2_MARKER = "/*oc-voice-native-settings-v2";
const NATIVE_SETTINGS_LEGACY_MARKER = "/*oc-voice-native-settings-legacy";
const MAIN_START = "/*oc-voice-v2:start*/";
const MAIN_END = "/*oc-voice-v2:end*/";
const PRELOAD_START = "/*oc-voice-v2-preload:start*/";
const PRELOAD_END = "/*oc-voice-v2-preload:end*/";
const BRIDGE_REQUIRE = 'require2("./oc-voice-bridge.cjs").install(require2("electron"));';
const ALLOW_MEDIA = 'require2("./oc-voice-bridge.cjs").allowMedia(webContents,permission,details)';

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hashBlocks(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    blocks.push(sha256(data.subarray(offset, Math.min(offset + BLOCK_SIZE, data.length))));
  }
  if (blocks.length === 0) blocks.push(sha256(data));
  return blocks;
}

function parseAsar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_JSON_OFFSET) fail("input is not a complete ASAR archive");
  const pickleSize = buffer.readUInt32LE(0);
  const headerSize = buffer.readUInt32LE(4);
  const jsonPickleSize = buffer.readUInt32LE(8);
  const jsonLength = buffer.readUInt32LE(12);
  // Chromium Pickle strings are padded to a 4-byte boundary. Older voice
  // archives omitted that padding; keep them readable for backup/restore.
  const padding = headerSize - jsonLength - 8;
  const alignedPadding = (4 - (jsonLength % 4)) % 4;
  if (pickleSize !== 4 || jsonPickleSize !== headerSize - 4 ||
      (padding !== 0 && padding !== alignedPadding)) {
    fail("unsupported or malformed ASAR header");
  }
  const dataStart = 8 + headerSize;
  if (dataStart > buffer.length || HEADER_JSON_OFFSET + jsonLength > dataStart) fail("ASAR header extends beyond input");
  for (let offset = HEADER_JSON_OFFSET + jsonLength; offset < dataStart; offset += 1) {
    if (buffer[offset] !== 0) fail("ASAR header padding is not zero-filled");
  }
  let header;
  try { header = JSON.parse(buffer.subarray(HEADER_JSON_OFFSET, HEADER_JSON_OFFSET + jsonLength).toString("utf8")); }
  catch (error) { fail("ASAR header JSON is invalid: " + error.message); }
  if (!header || typeof header !== "object" || !header.files || typeof header.files !== "object") fail("ASAR header has no files tree");
  return { header, jsonLength, headerSize, dataStart };
}

function getEntry(header, name) {
  let node = header;
  for (const segment of name.split("/")) {
    if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, segment)) return null;
    node = node.files[segment];
  }
  return node;
}

function getOrCreateEntry(header, name) {
  let node = header;
  const parts = name.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const segment = parts[i];
    if (i < parts.length - 1) {
      if (!node.files) node.files = {};
      if (!node.files[segment]) node.files[segment] = { files: {} };
      if (!node.files[segment].files || typeof node.files[segment].files !== "object") {
        fail("ASAR path collides with an existing file: " + name);
      }
      node = node.files[segment];
    } else {
      if (!node.files) node.files = {};
      if (!node.files[segment]) node.files[segment] = {};
      node = node.files[segment];
      if (node.files || node.link) fail("ASAR path is not a regular file: " + name);
    }
  }
  return node;
}

function readEntry(buffer, dataStart, node, name) {
  if (!node || node.unpacked || node.link != null || node.offset == null || !Number.isSafeInteger(Number(node.size))) {
    fail("ASAR entry is missing or not packed: " + name);
  }
  const offset = Number(node.offset);
  const size = Number(node.size);
  if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || dataStart + offset + size > buffer.length) {
    fail("ASAR entry has an invalid data range: " + name);
  }
  return buffer.subarray(dataStart + offset, dataStart + offset + size);
}

function walkFiles(node, prefix, callback) {
  if (node && node.files && typeof node.files === "object") {
    for (const key of Object.keys(node.files)) walkFiles(node.files[key], prefix ? prefix + "/" + key : key, callback);
  } else if (node && !node.link) callback(prefix, node);
}

function validateAsar(buffer, parsed = parseAsar(buffer)) {
  let packed = 0;
  let hashed = 0;
  walkFiles(parsed.header, "", (name, node) => {
    if (node.unpacked) return;
    const data = readEntry(buffer, parsed.dataStart, node, name);
    packed += 1;
    const integrity = node.integrity;
    if (!integrity) return;
    if (String(integrity.algorithm).toUpperCase() !== "SHA256" || typeof integrity.hash !== "string") {
      fail("ASAR entry has unsupported integrity metadata: " + name);
    }
    if (sha256(data) !== integrity.hash.toLowerCase()) fail("ASAR integrity hash mismatch: " + name);
    if (integrity.blocks != null) {
      if (!Array.isArray(integrity.blocks) || integrity.blockSize !== BLOCK_SIZE) fail("ASAR block integrity metadata is invalid: " + name);
      const actualBlocks = hashBlocks(data);
      if (actualBlocks.length !== integrity.blocks.length || actualBlocks.some((hash, index) => hash !== String(integrity.blocks[index]).toLowerCase())) {
        fail("ASAR block integrity mismatch: " + name);
      }
    }
    hashed += 1;
  });
  if (packed === 0) fail("ASAR contains no packed files");
  return { packed, hashed };
}

function inspectAsarBuffer(buffer) {
  const parsed = parseAsar(buffer);
  const checked = validateAsar(buffer, parsed);
  const packageEntry = getEntry(parsed.header, "package.json");
  if (!packageEntry) fail("ASAR package.json is missing; cannot bind patch to an app version");
  let packageJson;
  try { packageJson = JSON.parse(readEntry(buffer, parsed.dataStart, packageEntry, "package.json").toString("utf8")); }
  catch (error) { fail("ASAR package.json is invalid: " + error.message); }
  if (!packageJson || typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    fail("ASAR package.json has no version; refusing an unbound patch");
  }
  return { ...parsed, ...checked, version: packageJson.version.trim() };
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function stripManagedBlock(text, start, end, label) {
  const starts = count(text, start);
  const ends = count(text, end);
  if (starts !== ends || starts > 1) fail(label + " patch markers are incomplete or duplicated");
  if (starts === 0) return text;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  if (endAt < 0) fail(label + " patch end marker is missing");
  return text.slice(0, startAt) + text.slice(endAt + end.length);
}

function findBalancedEnd(source, openAt, open = "(", close = ")") {
  if (source[openAt] !== open) fail("native settings parser expected " + open);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openAt; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === String.fromCharCode(96)) {
      quote = character;
      escaped = false;
      continue;
    }
    if (character === open) {
      depth += 1;
      continue;
    }
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) break;
    }
  }
  fail("native settings parser found an unbalanced " + open + " call");
}

function findNativeComponentCall(source, receiver, component, value) {
  const pattern = new RegExp("createComponent\\(\\s*" + receiver + "\\." + component + "\\s*,", "g");
  const matches = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const openAt = source.indexOf("(", match.index);
    const end = findBalancedEnd(source, openAt);
    const call = source.slice(match.index, end);
    if (new RegExp("value\\s*:\\s*[\\\"']" + value + "[\\\"']").test(call)) {
      matches.push({ start: match.index, end, call });
    }
  }
  if (matches.length !== 1) {
    fail("native settings " + receiver + "." + component + " value '" + value + "' must have exactly one candidate (found " + matches.length + ")");
  }
  return matches[0];
}

function nativeSettingsMarkerNames(variant) {
  const prefix = variant === "v2" ? NATIVE_SETTINGS_V2_MARKER : variant === "legacy" ? NATIVE_SETTINGS_LEGACY_MARKER : "";
  if (!prefix) fail("native settings variant must be v2 or legacy");
  return {
    helperStart: prefix + ":helper:start*/",
    helperEnd: prefix + ":helper:end*/",
    triggerStart: prefix + ":trigger:start*/",
    triggerEnd: prefix + ":trigger:end*/",
    contentStart: prefix + ":content:start*/",
    contentEnd: prefix + ":content:end*/",
  };
}

function stripNativeSettingsBlocks(source, variant) {
  const markers = nativeSettingsMarkerNames(variant);
  let output = source;
  output = stripManagedBlock(output, markers.helperStart, markers.helperEnd, "native settings " + variant + " helper");
  output = stripManagedBlock(output, markers.triggerStart, markers.triggerEnd, "native settings " + variant + " trigger");
  output = stripManagedBlock(output, markers.contentStart, markers.contentEnd, "native settings " + variant + " content");
  return output;
}

function nativeSettingsLayout(source, variant) {
  const v2 = variant === "v2";
  const receiver = v2 ? "TabsV2" : "Tabs";
  const panelClass = v2 ? "settings-v2-panel" : "no-scrollbar";
  const rootMarker = v2 ? /\bsettings-v2-dialog\b/ : /\bsettings-dialog\b/;
  if (!source.includes("DialogSettings") || !rootMarker.test(source)) {
    fail("native settings " + variant + " module does not match the expected DialogSettings layout");
  }
  const trigger = findNativeComponentCall(source, receiver, "Trigger", "shortcuts");
  const content = findNativeComponentCall(source, receiver, "Content", "shortcuts");
  if (!source.includes(receiver + ".List") || !source.includes(panelClass)) {
    fail("native settings " + variant + " module is missing its native tabs list or panel class");
  }
  return { receiver, panelClass, trigger, content };
}

function nativeSettingsHelper(markers) {
  return [
    markers.helperStart,
    'import {__ocVoiceNativePanel} from "../oc-voice-native-settings.js";',
    "function __ocVoiceInputLabel(){const lang=typeof document===\"object\"?String(document.documentElement?.lang||\"\"):\"\";return /^zh(?:-|$)/i.test(lang)?\"语音输入\":\"Voice input\"}",
    "function __ocVoiceInputIcon(){const wrapper=document.createElement(\"div\");wrapper.setAttribute(\"data-component\",\"icon\");const svg=document.createElementNS(\"http://www.w3.org/2000/svg\",\"svg\");svg.setAttribute(\"data-slot\",\"icon-svg\");svg.setAttribute(\"width\",\"16\");svg.setAttribute(\"height\",\"16\");svg.setAttribute(\"viewBox\",\"0 0 24 24\");svg.setAttribute(\"fill\",\"none\");svg.setAttribute(\"stroke\",\"currentColor\");svg.setAttribute(\"stroke-width\",\"1.7\");svg.setAttribute(\"stroke-linecap\",\"round\");svg.setAttribute(\"stroke-linejoin\",\"round\");svg.setAttribute(\"aria-hidden\",\"true\");svg.innerHTML=\"<rect x='9' y='3' width='6' height='11' rx='3'/><path d='M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6'/>\";wrapper.append(svg);return wrapper}",
    markers.helperEnd,
  ].join("\n");
}

function patchNativeSettingsSource(input, variant) {
  const markers = nativeSettingsMarkerNames(variant);
  let source = stripNativeSettingsBlocks(String(input), variant);
  if (source.includes("voice-input") || source.includes("oc-voice-settings")) {
    fail("native settings " + variant + " contains an unmanaged voice input injection");
  }
  const layout = nativeSettingsLayout(source, variant);
  const triggerInsertAt = source.lastIndexOf("insert(", layout.trigger.start);
  if (triggerInsertAt < 0) fail("native settings " + variant + " shortcuts trigger has no insert owner");
  const triggerOpenAt = source.indexOf("(", triggerInsertAt);
  const triggerInsertEnd = findBalancedEnd(source, triggerOpenAt);
  if (triggerInsertEnd < layout.trigger.end) fail("native settings " + variant + " trigger owner is malformed");
  const triggerOwner = source.slice(triggerInsertAt, triggerInsertEnd);
  const targetMatch = /^insert\(\s*([A-Za-z_$][\w$]*),\s*createComponent/.exec(triggerOwner);
  if (!targetMatch) fail("native settings " + variant + " trigger owner target is ambiguous");
  const target = targetMatch[1];
  const triggerBlock = [
    markers.triggerStart,
    "insert(" + target + ",createComponent(" + layout.receiver + ".Trigger,{value:\"voice-input\",get children(){return [__ocVoiceInputIcon(),__ocVoiceInputLabel()]}}),null);",
    markers.triggerEnd,
  ].join("\n");
  source = source.slice(0, triggerInsertEnd) + triggerBlock + source.slice(triggerInsertEnd);

  const refreshed = nativeSettingsLayout(source, variant);
  const contentBlock = [
    markers.contentStart,
    ",createComponent(" + refreshed.receiver + ".Content,{value:\"voice-input\",class:\"" + refreshed.panelClass + "\",get children(){return createComponent(__ocVoiceNativePanel,{})}})",
    markers.contentEnd,
  ].join("\n");
  source = source.slice(0, refreshed.content.end) + contentBlock + source.slice(refreshed.content.end);
  source = source.replace(/\s*$/, "") + "\n" + nativeSettingsHelper(markers) + "\n";

  validateNativeSettingsSource(source, variant);
  return source;
}

function validateNativeSettingsSource(source, variant) {
  const markers = nativeSettingsMarkerNames(variant);
  nativeSettingsLayout(source, variant);
  if (count(source, "value:\"voice-input\"") !== 2 || count(source, "createComponent(__ocVoiceNativePanel,{})") !== 1 ||
      count(source, 'import {__ocVoiceNativePanel} from "../oc-voice-native-settings.js";') !== 1 ||
      source.includes('document.createElement("oc-voice-settings")')) {
    fail("native settings " + variant + " voice tab did not validate");
  }
  if (count(source, markers.helperStart) !== 1 || count(source, markers.helperEnd) !== 1 ||
      count(source, markers.triggerStart) !== 1 || count(source, markers.triggerEnd) !== 1 ||
      count(source, markers.contentStart) !== 1 || count(source, markers.contentEnd) !== 1) {
    fail("native settings " + variant + " managed markers did not validate");
  }
  checkJavaScript(source, "native settings " + variant, true);
  return true;
}

function isNativeSettingsCandidate(source, variant) {
  const v2 = variant === "v2";
  const receiver = v2 ? "TabsV2" : "Tabs";
  const rootMarker = v2 ? /\bsettings-v2-dialog\b/ : /\bsettings-dialog\b/;
  const shortcuts = /value\s*:\s*[\"']shortcuts[\"']/.test(source);
  return source.includes("DialogSettings") && rootMarker.test(source) && source.includes(receiver + ".List") && source.includes(receiver + ".Trigger") && source.includes(receiver + ".Content") && shortcuts && source.includes(v2 ? "settings-v2-panel" : "no-scrollbar");
}

function findNativeSettingsCandidates(buffer, parsed = parseAsar(buffer)) {
  const candidates = { v2: [], legacy: [] };
  walkFiles(parsed.header, "", (name, node) => {
    if (node.unpacked || !name.startsWith(NATIVE_SETTINGS_ASSET_ROOT) || !name.endsWith(".js")) return;
    const source = readEntry(buffer, parsed.dataStart, node, name).toString("utf8");
    for (const variant of ["v2", "legacy"]) {
      if (isNativeSettingsCandidate(source, variant)) candidates[variant].push({ name, source });
    }
  });
  for (const variant of ["v2", "legacy"]) {
    if (candidates[variant].length !== 1) {
      fail("native settings " + variant + " module candidate count is " + candidates[variant].length + "; refusing ambiguous ASAR layout");
    }
  }
  return { v2: candidates.v2[0], legacy: candidates.legacy[0] };
}

function buildNativeSettingsModule(buffer, parsed, modernSource, componentSource) {
  if (!componentSource.includes("function __ocVoiceNativeSettingsV2(props)")) fail("native voice component source is missing");
  const required = ["createComponent", "createSignal", "createMemo", "createRenderEffect", "insert", "template", "onMount", "onCleanup", "Show", "For", "mergeProps",
    "SettingsRowV2", "SettingsListV2", "SelectV2", "Switch", "TextInputV2", "ButtonV2", "TextField"];
  const bindings = new Map();
  const imports = /import\s*\{([^}]+)\}\s*from\s*(["'])(\.\/[^"']+)\2\s*;/g;
  for (const match of modernSource.matchAll(imports)) {
    if (!/^\.\/[^/]+\.js$/.test(match[3])) continue;
    for (const specifier of match[1].split(",")) {
      const item = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (!item) continue;
      const local = item[2] || item[1];
      if (!required.includes(local)) continue;
      if (bindings.has(local)) fail("ambiguous native UI binding: " + local);
      bindings.set(local, { exported: item[1], asset: NATIVE_SETTINGS_ASSET_ROOT + match[3].slice(2) });
    }
  }
  // The multiline field belongs to the same native UI runtime as SelectV2,
  // but the original General settings module does not need to import it.
  if (!bindings.has("TextField") && bindings.has("SelectV2")) {
    const mainAsset = bindings.get("SelectV2").asset;
    const mainSource = readEntry(buffer, parsed.dataStart, getEntry(parsed.header, mainAsset), mainAsset).toString("utf8");
    const exportsAt = mainSource.lastIndexOf("\nexport {");
    const fieldExport = exportsAt >= 0 && /\bTextField\s+as\s+([A-Za-z_$][\w$]*)\b/.exec(mainSource.slice(exportsAt));
    if (!fieldExport) fail("the native multiline TextField export is missing");
    bindings.set("TextField", { exported: fieldExport[1], asset: mainAsset });
  }
  // The legacy settings entry does not preload the V2 row chunk's Switch CSS.
  // Reference the host stylesheet unchanged, with the same URL as Vite, so
  // the modern entry's existing stylesheet is reused rather than duplicated.
  const nativeStyles = [];
  walkFiles(parsed.header, "", (name, node) => {
    if (node.unpacked || !name.startsWith(NATIVE_SETTINGS_ASSET_ROOT) || !name.endsWith(".css")) return;
    const css = readEntry(buffer, parsed.dataStart, node, name).toString("utf8");
    // The global stylesheet also skins the older Switch via a parent
    // selector. The V2 row chunk owns the standalone slot selector.
    if (/(?:^|\})\s*\[data-slot\s*=\s*["']?switch-control["']?\]\s*\{/.test(css)) nativeStyles.push(name);
  });
  if (nativeStyles.length !== 1) fail("native Switch stylesheet candidate count is " + nativeStyles.length + "; refusing ambiguous native styles");
  const grouped = new Map();
  for (const local of required) {
    const binding = bindings.get(local);
    if (!binding) fail("unsupported native UI imports: missing " + local);
    if (!getEntry(parsed.header, binding.asset)) fail("native UI dependency is missing: " + binding.asset);
    const group = grouped.get(binding.asset) || [];
    group.push(binding.exported + " as " + local);
    grouped.set(binding.asset, group);
  }
  const styleUrl = "./assets/" + nativeStyles[0].slice(NATIVE_SETTINGS_ASSET_ROOT.length);
  const output = [...grouped].map(([asset, names]) => 'import {' + names.join(",") + '} from "./assets/' + asset.slice(NATIVE_SETTINGS_ASSET_ROOT.length) + '";').join("\n") +
    '\nconst __ocVoiceNativeStyleHref=new URL(' + JSON.stringify(styleUrl) + ',import.meta.url).href;\n' +
    'if(!Array.from(document.querySelectorAll(\'link[rel="stylesheet"]\')).some(link=>link.href===__ocVoiceNativeStyleHref)){const link=document.createElement("link");link.rel="stylesheet";link.href=__ocVoiceNativeStyleHref;link.dataset.ocVoiceNativeStyle="true";document.head.appendChild(link)}\n' +
    "\n" + componentSource + "\n" +
    "export function __ocVoiceNativePanel(){return createComponent(__ocVoiceNativeSettingsV2,{ui:{" + required.join(",") +
    "},onConfig(config){window.dispatchEvent(new CustomEvent(\"oc-voice-settings-updated\",{detail:config}))}})}\n";
  checkJavaScript(output, NATIVE_UI, true);
  return output;
}

function removeLegacyLines(text, label) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const oldVersionMarker = /\/\*oc-stt-v[234]\*\//.test(line);
    const oldHandler = /ipcMain\.handle\(["']oc-stt-transcribe["']/.test(line);
    const oldPreload = label === "preload" && /exposeInMainWorld\(["']ocMic["']/.test(line) && /oc-stt-transcribe/.test(line);
    if (!oldVersionMarker && !oldHandler && !oldPreload) {
      kept.push(line);
      continue;
    }
    const startsAtLine = oldVersionMarker
      ? /^\/\*oc-stt-v[234]\*\//.test(trimmed)
      : oldPreload
        ? /^;?\(\(\)=>\{try\{electron\.contextBridge\.exposeInMainWorld\(["']ocMic["']/.test(trimmed)
        : /^;?\(\(\)=>\{try\{ipcMain\.handle\(["']oc-stt-transcribe["']/.test(trimmed);
    if (!startsAtLine || !/\}\)\(\);?$/.test(trimmed)) {
      fail("unrecognized legacy voice injection in " + label + "; refusing to discard surrounding source");
    }
    removed += 1;
  }
  if (removed === 0) return text;
  return kept.join(text.includes("\r\n") ? "\r\n" : "\n");
}

function removeOldGlobalPermissions(main) {
  const legacy = /new Set\(\[\s*clipboardWritePermission\s*,\s*notificationPermission\s*,\s*["']media["']\s*,\s*["']local-network-access["']\s*\]\)/g;
  const matches = [...main.matchAll(legacy)];
  if (matches.length > 1) fail("multiple legacy broad permission sets found");
  return main.replace(legacy, "new Set([clipboardWritePermission, notificationPermission])");
}

function assertMediaIsScoped(main) {
  const rendererSets = [...main.matchAll(/rendererPermissions\s*=\s*new Set\(\[([\s\S]*?)\]\)/g)];
  if (rendererSets.length > 1) fail("multiple renderer permission sets found; refusing an ambiguous media scope");
  if (rendererSets.some(match => /["'](?:media|local-network-access)["']/.test(match[1]))) {
    fail("rendererPermissions still grants global media/network access; refusing a broad permission layout");
  }
}

function patchPermissionChecks(main) {
  const requestPattern = /callback\(\s*\(?\s*rendererPermissions\.has\(permission\)(?:\s*\|\|\s*require2\(["']\.\/oc-voice-bridge\.cjs["']\)\.allowMedia\(webContents,\s*permission,\s*details\))?\s*\)?\s*&&\s*isTrustedRendererUrl\(details\.requestingUrl\)\s*&&\s*webContents\.id\s*===\s*webContentsId\s*\)/g;
  const checkPattern = /if\s*\(\s*!\s*\(?\s*rendererPermissions\.has\(permission\)(?:\s*\|\|\s*require2\(["']\.\/oc-voice-bridge\.cjs["']\)\.allowMedia\(webContents,\s*permission,\s*details\))?\s*\)?\s*\)\s*return\s+false\s*;?/g;
  const requests = [...main.matchAll(requestPattern)];
  const checks = [...main.matchAll(checkPattern)];
  const allowCount = count(main, "allowMedia(webContents,permission,details)");
  if (requests.length !== 1 || checks.length !== 1) fail("unsupported renderer permission layout (expected one request and one check guard)");
  if (allowCount === 0) {
    const request = requests[0][0];
    const updatedRequest = request.replace(
      "rendererPermissions.has(permission)",
      "(rendererPermissions.has(permission)||" + ALLOW_MEDIA + ")",
    );
    main = main.replace(request, updatedRequest);
    const check = [...main.matchAll(checkPattern)];
    if (check.length !== 1) fail("permission check guard changed while applying microphone permission");
    const updatedCheck = check[0][0].replace(
      "rendererPermissions.has(permission)",
      "(rendererPermissions.has(permission)||" + ALLOW_MEDIA + ")",
    );
    main = main.replace(check[0][0], updatedCheck);
  } else if (allowCount !== 2) {
    fail("partial microphone permission patch found; refusing to guess");
  }
  if (count(main, "allowMedia(webContents,permission,details)") !== 2) fail("microphone permission guards did not validate");
  return main;
}

function mainSource(input, bridgeSource) {
  if (!bridgeSource.includes("function allowMedia") || !bridgeSource.includes("module.exports")) {
    fail("shared desktop bridge is incomplete");
  }
  let main = stripManagedBlock(input, MAIN_START, MAIN_END, "main");
  main = removeLegacyLines(main, "main");
  main = removeOldGlobalPermissions(main);
  assertMediaIsScoped(main);
  main = patchPermissionChecks(main);
  assertMediaIsScoped(main);
  return main.replace(/\s*$/, "") + "\n" + MAIN_START + BRIDGE_REQUIRE + MAIN_END + "\n";
}

const ORIGINAL_UPDATE_INSTALL = `async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install");
      const version = state.version;
      transition({ status: "installing", version });
      await input.stop().then(() => {
        input.backend.quitAndInstall();
        transition({ status: "ready", version });
      }).catch((error) => {
        transition({ status: "ready", version });
        throw error;
      });
    }`;
const UPDATE_INSTALL_START = "/*oc-voice-update:install:start*/";
const UPDATE_INSTALL_END = "/*oc-voice-update:install:end*/";
const UPDATE_CALL_START = "/*oc-voice-update:call:start*/";
const UPDATE_CALL_END = "/*oc-voice-update:call:end*/";

function restoreOwnedUpdateBlock(source, start, end, original) {
  const starts = count(source, start), ends = count(source, end);
  if (!starts && !ends) return source;
  if (starts !== 1 || ends !== 1 || source.indexOf(end) < source.indexOf(start)) fail("ambiguous or partial voice updater hook");
  return source.slice(0, source.indexOf(start)) + original + source.slice(source.indexOf(end) + end.length);
}

function patchUpdaterSource(input) {
  let source = restoreOwnedUpdateBlock(input, UPDATE_INSTALL_START, UPDATE_INSTALL_END, ORIGINAL_UPDATE_INSTALL);
  source = restoreOwnedUpdateBlock(source, UPDATE_CALL_START, UPDATE_CALL_END, "autoUpdater.quitAndInstall();");
  if (count(source, "function createUpdaterController(input)") !== 1 || count(source, "function setupAutoUpdater(stop)") !== 1 ||
      count(source, ORIGINAL_UPDATE_INSTALL) !== 1 || count(source, "autoUpdater.quitAndInstall();") !== 1 ||
      count(source, "autoUpdater.autoDownload = false;") !== 1 || count(source, "autoUpdater.autoInstallOnAppQuit = false;") !== 1) {
    fail("unsupported OpenCode updater layout; refusing an unverified update handoff");
  }
  const installed = `async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install");
      const version = state.version;
      let __ocVoiceRecovery;
      try {
        __ocVoiceRecovery = await require2("./oc-voice-update.cjs").prepare(version, autoUpdater, require2("electron"));
      } catch (error) {
        if (error && error.ocVoiceUpdateNotified === true) return;
        throw error;
      }
      transition({ status: "installing", version });
      await input.stop().then(() => {
        require2("./oc-voice-update.cjs").commit(__ocVoiceRecovery);
        input.backend.quitAndInstall();
        transition({ status: "ready", version });
      }).catch((error) => {
        try { require2("./oc-voice-update.cjs").cancel(__ocVoiceRecovery); } catch (_) {}
        transition({ status: "ready", version });
        throw error;
      });
    }`;
  source = source.replace(ORIGINAL_UPDATE_INSTALL, UPDATE_INSTALL_START + installed + UPDATE_INSTALL_END);
  source = source.replace("autoUpdater.quitAndInstall();", UPDATE_CALL_START + 'require2("./oc-voice-update.cjs").quitAndInstall(autoUpdater);' + UPDATE_CALL_END);
  return source;
}

function findPromptContract(buffer, parsed) {
  const matches = [];
  walkFiles(parsed.header, "", (name, node) => {
    if (node.unpacked || !name.startsWith(NATIVE_SETTINGS_ASSET_ROOT) || !name.endsWith(".js")) return;
    const source = readEntry(buffer, parsed.dataStart, node, name).toString("utf8");
    if (/<form\b[^>]*data-component\s*=\s*["']?prompt-input(?:-v2)?(?:["']|\s|>)/.test(source) &&
        /data-component\s*=\s*["']?prompt-input(?:["']|\s|>)/.test(source) && /contenteditable/.test(source) &&
        /data-action\s*=\s*["']?prompt-submit(?:["']|\s|>)/.test(source)) matches.push(name);
  });
  if (matches.length !== 1) fail("unsupported native prompt layout: prompt module candidate count is " + matches.length);
  return matches[0];
}

function preloadSource(input) {
  let preload = stripManagedBlock(input, PRELOAD_START, PRELOAD_END, "preload");
  preload = removeLegacyLines(preload, "preload");
  const block = [
    PRELOAD_START,
    ';(()=>{try{electron.contextBridge.exposeInMainWorld("ocMic",{' +
      'getConfig:()=>electron.ipcRenderer.invoke("oc-voice:config"),' +
      'saveConfig:(patch)=>electron.ipcRenderer.invoke("oc-voice:save-config",patch),' +
      'status:()=>electron.ipcRenderer.invoke("oc-voice:status"),' +
      'warmup:()=>electron.ipcRenderer.invoke("oc-voice:warmup"),' +
      'transcribe:(bytes,mime,jobId)=>electron.ipcRenderer.invoke("oc-voice:transcribe",bytes,mime,jobId),' +
      'cancel:(jobId)=>electron.ipcRenderer.invoke("oc-voice:cancel",jobId),' +
      'useLocal:(jobId)=>electron.ipcRenderer.invoke("oc-voice:use-local",jobId),' +
      'previewText:(text,config,key)=>electron.ipcRenderer.invoke("oc-voice:preview-text",text,config,key),' +
      'testRewrite:(config,key)=>electron.ipcRenderer.invoke("oc-voice:test-rewrite",config,key),' +
      'onProgress:(callback)=>{if(typeof callback!=="function")return ()=>{};const listener=(_event,payload)=>callback(payload);electron.ipcRenderer.on("oc-voice:progress",listener);return ()=>electron.ipcRenderer.removeListener("oc-voice:progress",listener)}' +
      '})}catch(error){console.error("[oc-voice] preload bridge failed",error)}})()',
    PRELOAD_END,
  ].join("");
  return preload.replace(/\s*$/, "") + "\n" + block + "\n";
}

function rendererHtml(input) {
  const oldTags = /<script\b[^>]*\bsrc\s*=\s*(["'])\.\/oc-mic(?:-v3)?\.js\1[^>]*>\s*<\/script\s*>/gi;
  let html = input.replace(oldTags, "");
  const newTag = '<script defer src="./oc-voice-v2.js"></script>';
  html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])\.\/oc-voice-v2\.js\1[^>]*>\s*<\/script\s*>[ \t]*(?:\r?\n)?/gi, "");
  if (/<\/head\s*>/i.test(html)) html = html.replace(/<\/head\s*>/i, newTag + "\n</head>");
  else if (/<\/body\s*>/i.test(html)) html = html.replace(/<\/body\s*>/i, newTag + "\n</body>");
  else fail("renderer HTML has no safe script insertion point");
  if (count(html, "./oc-voice-v2.js") !== 1) fail("renderer script tag did not validate");
  return html;
}

function checkJavaScript(source, label, moduleMode = false) {
  const args = ["--check"];
  if (moduleMode) args.push("--input-type=module");
  const checked = spawnSync(process.execPath, args, { input: source, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (checked.error || checked.status !== 0) {
    fail(label + " JavaScript syntax check failed: " + (checked.error ? checked.error.message : checked.stderr));
  }
}

function patchAsar(inputBuffer, options) {
  const platform = options && options.platform;
  if (!["windows", "macos", "linux"].includes(platform)) fail("platform must be windows, macos, or linux");
  const bridge = String(options.bridgeSource || "");
  const mic = String(options.micSource || "");
  if (!mic || !/oc-mic-v0\.(?:2|3)(?:\.\d+)?/.test(mic)) fail("shared renderer source is missing a supported voice marker");
  const original = inspectAsarBuffer(inputBuffer);
  const header = JSON.parse(JSON.stringify(original.header));
  const originalFiles = [];
  walkFiles(header, "", (name, node) => {
    if (node.unpacked) return;
    originalFiles.push({
      name,
      node,
      offset: Number(node.offset),
      data: Buffer.from(readEntry(inputBuffer, original.dataStart, node, name)),
    });
  });
  originalFiles.sort((left, right) => left.offset - right.offset);
  let main = readEntry(inputBuffer, original.dataStart, getEntry(header, MAIN), MAIN).toString("utf8");
  let preload = readEntry(inputBuffer, original.dataStart, getEntry(header, PRELOAD), PRELOAD).toString("utf8");
  let html = readEntry(inputBuffer, original.dataStart, getEntry(header, HTML), HTML).toString("utf8");
  const nativeCandidates = findNativeSettingsCandidates(inputBuffer, original);
  const nativeComponent = String(options.nativeSettingsSource || fs.readFileSync(path.join(__dirname, "native-voice-settings.js"), "utf8"));
  const nativeUi = buildNativeSettingsModule(inputBuffer, original, nativeCandidates.v2.source, nativeComponent);
  const nativeV2 = patchNativeSettingsSource(nativeCandidates.v2.source, "v2");
  const nativeLegacy = patchNativeSettingsSource(nativeCandidates.legacy.source, "legacy");
  main = mainSource(main, bridge);
  let updaterBridge;
  let promptModule;
  if (platform === "windows") {
    promptModule = findPromptContract(inputBuffer, original);
    updaterBridge = String(options.updateBridgeSource || fs.readFileSync(path.join(__dirname, "update-bridge.cjs"), "utf8"));
    if (!updaterBridge.includes("module.exports") || !updaterBridge.includes("quitAndInstall")) fail("shared update bridge is incomplete");
    main = patchUpdaterSource(main);
    checkJavaScript(updaterBridge, UPDATE_BRIDGE);
  }
  preload = preloadSource(preload);
  html = rendererHtml(html);
  checkJavaScript(main, MAIN, true);
  checkJavaScript(preload, PRELOAD);
  checkJavaScript(bridge, BRIDGE);
  checkJavaScript(mic, RENDERER);

  const replacements = [
    { name: MAIN, data: Buffer.from(main, "utf8") },
    { name: PRELOAD, data: Buffer.from(preload, "utf8") },
    { name: HTML, data: Buffer.from(html, "utf8") },
    { name: BRIDGE, data: Buffer.from(bridge, "utf8") },
    { name: RENDERER, data: Buffer.from(mic, "utf8") },
    { name: NATIVE_UI, data: Buffer.from(nativeUi, "utf8") },
    { name: nativeCandidates.v2.name, data: Buffer.from(nativeV2, "utf8") },
    { name: nativeCandidates.legacy.name, data: Buffer.from(nativeLegacy, "utf8") },
  ];
  if (updaterBridge) replacements.push({ name: UPDATE_BRIDGE, data: Buffer.from(updaterBridge, "utf8") });
  for (const item of replacements) getOrCreateEntry(header, item.name);

  let jsonLength = original.jsonLength;
  let plan = null;
  let json = null;
  const replacementMap = new Map(replacements.map(item => [item.name, item.data]));
  const writtenNames = new Set();
  const filesToWrite = originalFiles.map(file => {
    writtenNames.add(file.name);
    return { name: file.name, node: file.node, data: replacementMap.get(file.name) || file.data,
      replaced: replacementMap.has(file.name) };
  });
  for (const item of replacements) {
    if (!writtenNames.has(item.name)) {
      filesToWrite.push({ name: item.name, node: getEntry(header, item.name), data: item.data, replaced: true });
    }
  }
  if (filesToWrite.length === 0) fail("ASAR contains no packed files to write");
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const dataStart = HEADER_JSON_OFFSET + Math.ceil(jsonLength / 4) * 4;
    let position = dataStart;
    const nextPlan = [];
    for (const item of filesToWrite) {
      position = Math.ceil(position / 4) * 4;
      nextPlan.push({ item, absolute: position });
      position += item.data.length;
    }
    for (const part of nextPlan) {
      part.item.node.size = part.item.data.length;
      part.item.node.offset = String(part.absolute - dataStart);
      if (part.item.replaced) {
        part.item.node.integrity = {
          algorithm: "SHA256",
          hash: sha256(part.item.data),
          blockSize: BLOCK_SIZE,
          blocks: hashBlocks(part.item.data),
        };
      }
      delete part.item.node.unpacked;
      delete part.item.node.link;
    }
    const nextJson = JSON.stringify(header);
    const nextLength = Buffer.byteLength(nextJson, "utf8");
    if (nextLength === jsonLength) {
      plan = nextPlan;
      json = nextJson;
      break;
    }
    jsonLength = nextLength;
  }
  if (!plan || !json) fail("ASAR header size did not converge");

  const paddedJsonLength = Math.ceil(jsonLength / 4) * 4;
  const dataStart = HEADER_JSON_OFFSET + paddedJsonLength;
  const last = plan[plan.length - 1];
  const output = Buffer.alloc(last.absolute + last.item.data.length);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(paddedJsonLength + 8, 4);
  output.writeUInt32LE(paddedJsonLength + 4, 8);
  output.writeUInt32LE(jsonLength, 12);
  Buffer.from(json, "utf8").copy(output, HEADER_JSON_OFFSET);
  for (const part of plan) part.item.data.copy(output, part.absolute);

  const final = inspectAsarBuffer(output);
  if (final.version !== original.version) fail("ASAR app version changed during patching");
  const originalByName = new Map(originalFiles.map(file => [file.name, file.data]));
  for (const file of originalFiles) {
    if (replacementMap.has(file.name)) continue;
    const emitted = readEntry(output, final.dataStart, getEntry(final.header, file.name), file.name);
    if (!emitted.equals(originalByName.get(file.name))) fail("untouched ASAR file changed while packing: " + file.name);
  }
  const mainOut = readEntry(output, final.dataStart, getEntry(final.header, MAIN), MAIN).toString("utf8");
  const preloadOut = readEntry(output, final.dataStart, getEntry(final.header, PRELOAD), PRELOAD).toString("utf8");
  const htmlOut = readEntry(output, final.dataStart, getEntry(final.header, HTML), HTML).toString("utf8");
  const nativeV2Out = readEntry(output, final.dataStart, getEntry(final.header, nativeCandidates.v2.name), nativeCandidates.v2.name).toString("utf8");
  const nativeLegacyOut = readEntry(output, final.dataStart, getEntry(final.header, nativeCandidates.legacy.name), nativeCandidates.legacy.name).toString("utf8");
  validateNativeSettingsSource(nativeV2Out, "v2");
  validateNativeSettingsSource(nativeLegacyOut, "legacy");
  if (count(mainOut, MAIN_START) !== 1 || count(mainOut, MAIN_END) !== 1 || count(mainOut, "allowMedia(webContents,permission,details)") !== 2) {
    fail("main bridge or scoped permission checks did not validate");
  }
  if (count(preloadOut, PRELOAD_START) !== 1 || count(preloadOut, "onProgress:") !== 1) fail("preload bridge did not validate");
  if (count(htmlOut, "./oc-voice-v2.js") !== 1) fail("renderer script did not validate");
  return {
    buffer: output,
    version: original.version,
    inputHash: sha256(inputBuffer),
    outputHash: sha256(output),
    packedFiles: final.packed,
    hashedFiles: final.hashed,
    nativeSettings: { v2: nativeCandidates.v2.name, legacy: nativeCandidates.legacy.name },
    ...(platform === "windows" ? { updateRecovery: true, promptModule } : {}),
  };
}

function writeAtomic(filename, data) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "." + path.basename(filename) + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail("unexpected argument: " + key);
    const name = key.slice(2);
    if (Object.prototype.hasOwnProperty.call(out, name)) fail("duplicate argument: " + key);
    if (name === "help") { out.help = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("missing value for " + key);
    out[name] = value;
    index += 1;
  }
  return out;
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write("Usage: node shared/patch-package.cjs --platform windows|macos|linux --app APP --input APP_ASAR --output PATCHED_ASAR\n");
    return 0;
  }
  if (!args.platform || !args.app || !args.input || !args.output) fail("--platform, --app, --input, and --output are required");
  if (!["windows", "macos", "linux"].includes(args.platform)) fail("unsupported platform: " + args.platform);
  const app = path.resolve(args.app);
  const input = path.resolve(args.input);
  const output = path.resolve(args.output);
  if (!fs.existsSync(app) || !fs.statSync(app).isDirectory()) fail("--app must name an existing application or fixture directory");
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) fail("--input must name an existing ASAR file");
  if (input.toLowerCase() === output.toLowerCase()) fail("--output must differ from --input");
  const root = path.resolve(__dirname, "..");
  const bridgeSource = fs.readFileSync(path.join(root, "shared", "desktop-bridge.cjs"), "utf8");
  const micSource = fs.readFileSync(path.join(root, "shared", "oc-mic.js"), "utf8");
  const result = patchAsar(fs.readFileSync(input), { platform: args.platform, bridgeSource, micSource });
  writeAtomic(output, result.buffer);
  process.stdout.write(JSON.stringify({ ok: true, app: result.version, inputHash: result.inputHash, outputHash: result.outputHash,
    output, packedFiles: result.packedFiles, hashedFiles: result.hashedFiles, nativeSettings: result.nativeSettings }) + "\n");
  return 0;
}

if (require.main === module) {
  try { process.exitCode = runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write("[patch] ERROR: " + error.message + "\n"); process.exitCode = 1; }
}

module.exports = {
  parseAsar,
  getEntry,
  readEntry,
  inspectAsarBuffer,
  validateAsar,
  patchAsar,
  patchNativeSettingsSource,
  patchUpdaterSource,
  findPromptContract,
  findNativeSettingsCandidates,
  buildNativeSettingsModule,
  nativeSettingsLayout,
  validateNativeSettingsSource,
  writeAtomic,
  sha256,
  runCli,
};
