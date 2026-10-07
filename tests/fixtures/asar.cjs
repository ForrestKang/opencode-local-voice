"use strict";
const crypto=require("node:crypto");
const nativeUpdaterFixture="function createUpdaterController(input) {\n  let state = { status: \"ready\", version: \"1.2.4\" };\n  const transition = value => state = value;\n  return { async install() {\n      if (state.status !== \"ready\") throw new Error(\"Update is not ready to install\");\n      const version = state.version;\n      transition({ status: \"installing\", version });\n      await input.stop().then(() => {\n        input.backend.quitAndInstall();\n        transition({ status: \"ready\", version });\n      }).catch((error) => {\n        transition({ status: \"ready\", version });\n        throw error;\n      });\n    } };\n}\nfunction setupAutoUpdater(stop) {\n  autoUpdater.autoDownload = false;\n  autoUpdater.autoInstallOnAppQuit = false;\n  return createUpdaterController({stop,backend:{quitAndInstall:()=>{autoUpdater.quitAndInstall();}}});\n}\n";
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const blockHashes = data => {
  const hashes = [];
  for (let offset = 0; offset < data.length; offset += 4 * 1024 * 1024) {
    hashes.push(sha256(data.subarray(offset, Math.min(data.length, offset + 4 * 1024 * 1024))));
  }
  return hashes.length ? hashes : [sha256(data)];
};

function makeAsar(files, version = "1.2.3") {
  const all = { "package.json": Buffer.from(JSON.stringify({ name: "fixture", version })) };
  for (const [name, source] of Object.entries(files)) all[name] = Buffer.from(source);
  const header = { files: {} };
  const ordered = Object.entries(all).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, data] of ordered) {
    const parts = name.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) {
      node.files ||= {};
      node.files[part] ||= { files: {} };
      node = node.files[part];
    }
    node.files ||= {};
    node.files[parts.at(-1)] = { size: data.length, offset: "0", integrity: {
      algorithm: "SHA256", hash: sha256(data), blockSize: 4 * 1024 * 1024, blocks: blockHashes(data),
    } };
  }

  let jsonLength = Buffer.byteLength(JSON.stringify(header));
  let plan;
  let json;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dataStart = 16 + jsonLength;
    let offset = 0;
    plan = [];
    for (const [name, data] of ordered) {
      plan.push({ name, data, offset });
      offset += data.length;
    }
    for (const part of plan) {
      const entry = lookup(header, part.name);
      entry.size = part.data.length;
      entry.offset = String(part.offset);
    }
    json = JSON.stringify(header);
    const nextLength = Buffer.byteLength(json);
    if (nextLength === jsonLength) break;
    jsonLength = nextLength;
  }
  const jsonBuffer = Buffer.from(json);
  const dataStart = 16 + jsonLength;
  const last = plan.at(-1);
  const buffer = Buffer.alloc(dataStart + last.offset + last.data.length);
  buffer.writeUInt32LE(4, 0);
  buffer.writeUInt32LE(jsonLength + 8, 4);
  buffer.writeUInt32LE(jsonLength + 4, 8);
  buffer.writeUInt32LE(jsonLength, 12);
  jsonBuffer.copy(buffer, 16);
  for (const part of plan) part.data.copy(buffer, dataStart + part.offset);
  return buffer;
}

function lookup(header, filename) {
  let node = header;
  for (const part of filename.split("/")) node = node.files[part];
  return node;
}

// Encode the same fixture with the Chromium Pickle padding used by upstream
// Electron packages, independently of the production archive writer.
function makeStandardAsar(files, version = "1.2.3", paddingTag = "") {
  const compact = makeAsar(files, version);
  const compactStart = 16 + compact.readUInt32LE(12);
  const header = JSON.parse(compact.subarray(16, compactStart).toString("utf8"));
  header.fixturePadding = paddingTag;
  const encoded = Buffer.from(JSON.stringify(header));
  const jsonBytes = encoded.length;
  const padding = (4 - jsonBytes % 4) % 4;
  const standard = Buffer.alloc(16 + jsonBytes + padding + compact.length - compactStart);
  standard.writeUInt32LE(4, 0);
  standard.writeUInt32LE(jsonBytes, 12);
  encoded.copy(standard, 16);
  compact.copy(standard, 16 + jsonBytes + padding, compactStart);
  standard.writeUInt32LE(jsonBytes + padding + 8, 4);
  standard.writeUInt32LE(jsonBytes + padding + 4, 8);
  return standard;
}

const nativeUiBindings = "createComponent,createSignal,createMemo,createRenderEffect,insert,template,onMount,onCleanup,Show,For,mergeProps,SettingsRowV2,SettingsListV2,SelectV2,Switch,TextInputV2,ButtonV2,TextField";
const nativeUiImports = 'import {' + nativeUiBindings + '} from "./native-ui-controls.js";\n';
const nativeV2Fixture = nativeUiImports + String.raw`const DialogSettings=()=>createComponent(TabsV2,{"data-component":"tabs-v2","class":"settings-v2-dialog",get children(){return [createComponent(TabsV2.List,{get children(){const _el={};insert(_el,createComponent(TabsV2.Trigger,{value:"general"}),null);insert(_el,createComponent(TabsV2.Trigger,{value:"shortcuts"}),null);return _el;}}),createComponent(TabsV2.Content,{value:"general","class":"settings-v2-panel",get children(){return createComponent(SettingsGeneralV2,{})}}),createComponent(TabsV2.Content,{value:"shortcuts","class":"settings-v2-panel",get children(){return createComponent(SettingsKeybinds,{v2:true})}})]}});export{DialogSettings};`;
const nativeLegacyFixture = String.raw`const DialogSettings=()=>createComponent(Tabs,{"class":"h-full settings-dialog",get children(){return [createComponent(Tabs.List,{get children(){const _el={};insert(_el,createComponent(Tabs.Trigger,{value:"general"}),null);insert(_el,createComponent(Tabs.Trigger,{value:"shortcuts"}),null);return _el;}}),createComponent(Tabs.Content,{value:"general","class":"no-scrollbar",get children(){return createComponent(SettingsGeneral,{})}}),createComponent(Tabs.Content,{value:"shortcuts","class":"no-scrollbar",get children(){return createComponent(SettingsKeybinds,{})}})]}});export{DialogSettings};`;

function baseFiles({ legacy = false, unknown = false, broadUnknown = false } = {}) {
  const rendererSet = broadUnknown ? 'const rendererPermissions=new Set(["media","local-network-access"]);' : "const rendererPermissions=new Set();";
  const permissionSet = 'const allPermissions=new Set([clipboardWritePermission,notificationPermission,"media","local-network-access"]);';
  const upstream = unknown
    ? "function setup(webContents,permission,callback,details){callback(true)}\n"
    : 'function setup(webContents,permission,callback,details){callback(rendererPermissions.has(permission)&&isTrustedRendererUrl(details.requestingUrl)&&webContents.id===webContentsId)}\n' +
      'function check(webContents,permission,requestingOrigin,details){if(!rendererPermissions.has(permission))return false;return isTrustedRendererUrl(details.requestingUrl)||isTrustedRendererUrl(requestingOrigin)}\n';
  const old = legacy ? '/*oc-stt-v4*/(()=>{try{const legacyVoice=true}catch(error){}})()\nconst codeAfterLegacyMarker=42;\n' : "const untouchedAfterMain=42;\n";
  return {
    "out/main/index.js": nativeUpdaterFixture + rendererSet + "const clipboardWritePermission='clipboard-write';const notificationPermission='notifications';const isTrustedRendererUrl=()=>true;const webContentsId=1;" + permissionSet + upstream + old,
    "out/preload/index.js": 'const electron=require("electron");\nconst untouchedPreload=1;\n',
    "out/renderer/index.html": '<!doctype html><html><head><script src="./oc-mic-v3.js"></script></head><body></body></html>',
    "out/renderer/keep.js": "module.exports=17;\n",
    "out/renderer/assets/prompt-native.js": 'const promptMarkup=`<form data-component=prompt-input-v2><div data-component=prompt-input contenteditable=true></div><button data-action=prompt-submit></button></form>`;',
    "out/renderer/assets/native-ui-controls.js": nativeUiBindings.split(",").map(name => "export const " + name + "=()=>null;").join("\n"),
    "out/renderer/assets/native-ui-row.css": '[data-slot="switch-control"]{border-radius:12px}',
    "out/renderer/assets/global.css": '[data-component="switch"] [data-slot="switch-control"]{border-radius:3px}',
    "out/renderer/assets/index-native-settings.js": nativeV2Fixture,
    "out/renderer/assets/dialog-settings-native.js": nativeLegacyFixture,
  };
}


module.exports={makeAsar,makeStandardAsar,baseFiles,nativeV2Fixture,nativeLegacyFixture,nativeUpdaterFixture};
