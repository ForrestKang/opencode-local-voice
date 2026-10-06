"use strict"
// OpenCode Voice — macOS patch generator
// Patches Contents/Resources/app.asar of the OpenCode desktop app:
//   - grants "media" permission in the main process
//   - adds the ipcMain transcription handler (spawns the local whisper service)
//   - injects oc-mic.js into the renderer
// Info.plist / code signing are handled by apply-oc-mic.sh
const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")

const HOME = process.env.HOME || os.homedir()
const APP_DIR = process.env.OPENCODE_APP_PATH || "/Applications/OpenCode.app"
const ASAR = path.join(APP_DIR, "Contents", "Resources", "app.asar")
const HERE = __dirname
const OUT = path.join(HERE, "app.asar.patched")

function die(msg) {
  console.error("[patch] ERROR: " + msg)
  process.exit(1)
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}
function blockHashes(buf) {
  const size = 4194304
  const out = []
  for (let off = 0; off < buf.length; off += size) {
    out.push(sha256(buf.subarray(off, Math.min(off + size, buf.length))))
  }
  if (out.length === 0) out.push(sha256(buf))
  return out
}
function parseAsar(buf) {
  const L = buf.readUInt32LE(12)
  const headerSize = buf.readUInt32LE(4)
  const h = JSON.parse(buf.slice(16, 16 + L).toString("utf8"))
  return { Z: L, h: h, dataStart: 8 + headerSize, headerSize: headerSize }
}
function getEntry(h, p) {
  let node = h
  for (const seg of p.split("/")) {
    if (!node.files || !node.files[seg]) return null
    node = node.files[seg]
  }
  return node
}
function getOrCreateEntry(h, p) {
  let node = h
  for (const seg of p.split("/")) {
    if (!node.files) node.files = {}
    if (!node.files[seg]) node.files[seg] = {}
    node = node.files[seg]
  }
  if (node.files && Object.keys(node.files).length === 0) delete node.files
  return node
}
function readEntry(buf, dataStart, node) {
  const off = Number(node.offset)
  return buf.slice(dataStart + off, dataStart + off + node.size)
}

if (!fs.existsSync(ASAR)) {
  die("app.asar not found: " + ASAR + " (use OPENCODE_APP_PATH=/path/to/OpenCode.app)")
}
const src = fs.readFileSync(ASAR)
const parsed = parseAsar(src)
const Z = parsed.Z
const h = parsed.h
const dataStart = parsed.dataStart

const MAIN = "out/main/index.js"
const PRELOAD = "out/preload/index.js"
const HTML = "out/renderer/index.html"
const MIC = "out/renderer/oc-mic-v3.js"

let main = readEntry(src, dataStart, getEntry(h, MAIN) || die("out/main/index.js missing")).toString("utf8")
const baseSet = "new Set([clipboardWritePermission, notificationPermission])"
if (!main.includes('"local-network-access"')) {
  if (!main.includes(baseSet)) die("permission anchor not found in out/main/index.js (app version changed?)")
  main = main.replace(baseSet, 'new Set([clipboardWritePermission, notificationPermission, "media", "local-network-access"])')
}
const sttPy = path.join(HOME, ".config", "opencode", "whisper-venv", "bin", "python")
const sttServer = path.join(HOME, ".config", "opencode", "whisper", "stt_server.py")
const stripMarkers = ['\n;(()=>{try{ipcMain.handle("oc-stt-transcribe"', "\n/*oc-stt-v2*/", "\n/*oc-stt-v3*/"]
for (const m of stripMarkers) {
  const i = main.indexOf(m)
  if (i !== -1) main = main.slice(0, i)
}
const ocSttSnippet =
  "\n/*oc-stt-v3*/(()=>{try{" +
  'const fsx=require2("node:fs");const pathx=require2("node:path");const LOGF=pathx.join(process.env.TMPDIR||"/tmp","oc-mic-debug.log");const LOG=(m)=>{try{fsx.appendFileSync(LOGF,new Date().toISOString()+" "+m+"\\n")}catch(_){}};' +
  'const wire=(wc)=>{try{wc.on("console-message",(e,level,message)=>{let lvl=level,msg=message;if(e&&typeof e==="object"&&e.level!==undefined){lvl={debug:0,info:1,warning:2,error:3}[e.level];msg=e.message}const s=String(msg);if(s.indexOf("[oc-mic]")!==-1||lvl>=3){LOG("renderer["+lvl+"] "+s.slice(0,600))}});wc.on("did-fail-load",(e,code,desc,url)=>{LOG("did-fail-load code="+code+" desc="+desc+" url="+url)});wc.on("did-finish-load",()=>{LOG("did-finish-load url="+wc.getURL())})}catch(_){}};' +
  'app.on("browser-window-created",(e,w)=>{LOG("window-created");try{wire(w.webContents)}catch(_){}});try{const WC=require2("electron").webContents;if(WC){for(const wc of WC.getAllWebContents()){wire(wc)}}}catch(_){}LOG("main patch v3 active (mac)");' +
  'try{const sysp=require2("electron").systemPreferences;if(sysp&&sysp.askForMediaAccess&&process.platform==="darwin"){app.whenReady().then(()=>{try{const p=sysp.askForMediaAccess("microphone");if(p&&p.catch){p.catch(()=>{})}}catch(_){}})}}catch(_){}' +
  'const cp=require2("node:child_process");' +
  "const PY=" + JSON.stringify(sttPy) + ";" +
  "const SRV=" + JSON.stringify(sttServer) + ";" +
  "const LPORT=Number(process.env.OPENCODE_STT_LOCAL_PORT||47832);" +
  'const health=(cb)=>{try{const rq=http.get({host:"127.0.0.1",port:LPORT,path:"/health",timeout:2000},(rs)=>{rs.resume();cb(rs.statusCode===200)});rq.on("error",()=>cb(false));rq.on("timeout",()=>{try{rq.destroy()}catch(_){}cb(false)})}catch(_){cb(false)}};' +
  'let proc=null;const ensure=()=>new Promise((resolve)=>{health((ok)=>{if(ok){resolve(true);return}try{if(!proc||proc.exitCode!==null){proc=cp.spawn(PY,[SRV,String(LPORT)],{stdio:["ignore","ignore","pipe"]});proc.stderr.on("data",()=>{})}}catch(e){resolve(false);return}const t0=Date.now();const iv=setInterval(()=>{health((ok2)=>{if(ok2){clearInterval(iv);resolve(true)}else if(Date.now()-t0>180000){clearInterval(iv);resolve(false)}})},700)})});' +
  'ipcMain.handle("oc-stt-transcribe",async(e,bytes)=>{const ok=await ensure();if(!ok){return {error:"local whisper server failed to start"}}return await new Promise((resolve)=>{try{const payload=Buffer.from(bytes);const rq=http.request({host:"127.0.0.1",port:LPORT,path:"/inference",method:"POST",headers:{"content-type":"application/octet-stream","content-length":payload.length,"x-language":"auto"}},(rs)=>{let d="";rs.setEncoding("utf8");rs.on("data",(c)=>{d+=c});rs.on("end",()=>{try{resolve(JSON.parse(d))}catch(_){resolve({error:"bad response from whisper server"})}})});rq.on("error",(err)=>resolve({error:String((err&&err.message)||err)}));rq.setTimeout(300000,()=>{try{rq.destroy(new Error("timeout"))}catch(_){}});rq.end(payload)}catch(err){resolve({error:String(err)})}})})}catch(e){console.error("[oc-stt] init failed",e)}})()\n'
main += ocSttSnippet
const syntaxCheck = require("child_process").spawnSync(process.execPath, ["--check", "--input-type=module"], {
  input: main,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
})
if (syntaxCheck.error || syntaxCheck.status !== 0) {
  die("main JavaScript syntax validation failed: " + (syntaxCheck.error ? syntaxCheck.error.message : syntaxCheck.stderr))
}

let pre = readEntry(src, dataStart, getEntry(h, PRELOAD) || die("out/preload/index.js missing")).toString("utf8")
if (!pre.includes("ocMic")) {
  pre +=
    '\n;(()=>{try{electron.contextBridge.exposeInMainWorld("ocMic",{transcribe:(bytes,mime)=>electron.ipcRenderer.invoke("oc-stt-transcribe",bytes,mime)})}catch(_){}})()\n'
}

let html = readEntry(src, dataStart, getEntry(h, HTML) || die("out/renderer/index.html missing")).toString("utf8")
const themeTag = '<script id="oc-theme-preload-script" src="./oc-theme-preload.js"></script>'
html = html.split('\n    <script src="./oc-mic.js"></script>').join("")
html = html.split('\n    <script src="./oc-mic-v3.js"></script>').join("")
if (!html.includes('<script src="./oc-mic-v3.js"></script>')) {
  if (html.includes(themeTag)) {
    html = html.replace(themeTag, themeTag + '\n    <script src="./oc-mic-v3.js"></script>')
  } else if (html.includes("</head>")) {
    html = html.replace("</head>", '  <script src="./oc-mic-v3.js"></script>\n  </head>')
  } else {
    die("index.html anchor not found")
  }
}

const micSource = fs.readFileSync(path.join(HERE, "oc-mic.js"))
if (!micSource.includes("prompt-submit")) die("oc-mic.js looks wrong (missing prompt-submit anchor)")
if (!micSource.includes("oc-mic-v3")) die("oc-mic.js looks wrong (missing v3 marker)")

const outputs = [
  { p: MAIN, buf: Buffer.from(main, "utf8") },
  { p: PRELOAD, buf: Buffer.from(pre, "utf8") },
  { p: HTML, buf: Buffer.from(html, "utf8") },
  { p: MIC, buf: micSource },
]
for (const rec of outputs) {
  if (rec.p.endsWith(".js")) {
    const check = require("child_process").spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: rec.buf, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    })
    if (check.error || check.status !== 0) die("JavaScript validation failed for " + rec.p + ": " + (check.error ? check.error.message : check.stderr))
  }
  getOrCreateEntry(h, rec.p)
}

let Znew = Z
let finalPlan = null
let finalJson = null
for (let iter = 0; iter < 12; iter++) {
  const dataStartNew = 16 + Znew
  const oldDataLen = src.length - dataStart
  let pos = (dataStartNew + oldDataLen + 3) & ~3
  const plan = []
  for (const rec of outputs) {
    plan.push({ rec: rec, abs: pos })
    pos += rec.buf.length
  }
  for (const item of plan) {
    const node = getEntry(h, item.rec.p)
    node.size = item.rec.buf.length
    node.offset = String(item.abs - dataStartNew)
    node.integrity = {
      algorithm: "SHA256",
      hash: sha256(item.rec.buf),
      blockSize: 4194304,
      blocks: blockHashes(item.rec.buf),
    }
    delete node.unpacked
  }
  const json = JSON.stringify(h)
  const Zc = Buffer.byteLength(json, "utf8")
  if (Zc === Znew) {
    finalPlan = plan
    finalJson = json
    break
  }
  Znew = Zc
}
if (!finalPlan) die("header size did not converge")

const dataStartNew = 16 + Znew
const last = finalPlan[finalPlan.length - 1]
const outBuf = Buffer.alloc(last.abs + last.rec.buf.length)
outBuf.writeUInt32LE(4, 0)
outBuf.writeUInt32LE(Znew + 8, 4)
outBuf.writeUInt32LE(Znew + 4, 8)
outBuf.writeUInt32LE(Znew, 12)
Buffer.from(finalJson, "utf8").copy(outBuf, 16)
src.copy(outBuf, dataStartNew, dataStart)
for (const item of finalPlan) item.rec.buf.copy(outBuf, item.abs)

const v = parseAsar(outBuf)
if (v.Z !== Znew) die("validation: header size mismatch")
if (!outBuf.slice(dataStartNew, dataStartNew + (src.length - dataStart)).equals(src.slice(dataStart))) {
  die("validation: untouched data region changed")
}
let checked = 0
const mismatches = []
function walk(node, prefix) {
  if (node && node.files) {
    for (const k of Object.keys(node.files)) walk(node.files[k], prefix + "/" + k)
    return
  }
  if (node && node.integrity && node.integrity.hash && node.offset != null) {
    const off = v.dataStart + Number(node.offset)
    const got = sha256(outBuf.slice(off, off + node.size))
    checked++
    if (got !== node.integrity.hash) mismatches.push(prefix)
  }
}
for (const k of Object.keys(v.h.files)) walk(v.h.files[k], k)
if (mismatches.length) die("validation: integrity mismatches: " + mismatches.slice(0, 5).join(", "))

const htmlOut = readEntry(outBuf, v.dataStart, getEntry(v.h, HTML)).toString("utf8")
const micOut = readEntry(outBuf, v.dataStart, getEntry(v.h, MIC)).toString("utf8")
const mainOut = readEntry(outBuf, v.dataStart, getEntry(v.h, MAIN)).toString("utf8")
const preOut = readEntry(outBuf, v.dataStart, getEntry(v.h, PRELOAD)).toString("utf8")
if (!htmlOut.includes("./oc-mic-v3.js")) die("validation: html script tag missing")
if (!micOut.includes("prompt-submit") || !micOut.includes("oc-mic-v3")) die("validation: mic script missing")
if (!mainOut.includes("oc-stt-v3") || !mainOut.includes("oc-stt-transcribe") || !mainOut.includes('"local-network-access"')) die("validation: main patch missing")
if (mainOut.includes(":47831")) die("validation: stale v1 main patch still present")
if (!preOut.includes("ocMic")) die("validation: preload patch missing")

fs.writeFileSync(OUT, outBuf)
console.log("[patch] OK -> " + OUT)
console.log("[patch] verified " + checked + " packed files, output size " + outBuf.length)
