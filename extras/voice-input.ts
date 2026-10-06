import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs"
import { tmpdir, homedir } from "os"
import { join } from "path"

const BASE_URL =
  process.env.OPENCODE_STT_BASE_URL ??
  process.env.OPENAI_BASE_URL ??
  "https://api.siliconflow.cn/v1"
const API_KEY =
  process.env.OPENCODE_STT_API_KEY ??
  process.env.SILICONFLOW_API_KEY ??
  process.env.OPENAI_API_KEY
const MODEL = process.env.OPENCODE_STT_MODEL ?? "FunAudioLLM/SenseVoiceSmall"
const LANGUAGE = process.env.OPENCODE_STT_LANGUAGE
const FFMPEG = process.env.OPENCODE_STT_FFMPEG ?? "ffmpeg"
const MAX_SECONDS = Number(process.env.OPENCODE_STT_MAX_SECONDS ?? "30")
const SILENCE_SECONDS = Number(process.env.OPENCODE_STT_SILENCE_SECONDS ?? "2.5")
const NOISE_DB = process.env.OPENCODE_STT_NOISE_DB ?? "-30"
const PORT = Number(process.env.OPENCODE_STT_PORT ?? "47831")
const BACKEND = (process.env.OPENCODE_STT_BACKEND ?? "local").toLowerCase()
const LOCAL_PORT = Number(process.env.OPENCODE_STT_LOCAL_PORT ?? "47832")
const VENV_PY = join(homedir(), ".config", "opencode", "whisper-venv", "Scripts", "python.exe")
const SERVER_PY = join(homedir(), ".config", "opencode", "whisper", "stt_server.py")
const STATE_FILE = join(homedir(), ".config", "opencode", "voice-input-state.json")

type SttAction = "record" | "on" | "off" | "toggle" | "status"

let stateCache: { enabled: boolean } | null = null

function readState(): { enabled: boolean } {
  if (stateCache) return stateCache
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8"))
    stateCache = { enabled: parsed?.enabled !== false }
  } catch {
    stateCache = { enabled: true }
  }
  return stateCache
}

function writeState(enabled: boolean) {
  stateCache = { enabled }
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ enabled }, null, 2), "utf-8")
  } catch (e) {
    console.warn("[voice-input] failed to persist state:", e)
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let out = ""
    p.stdout.on("data", (d) => (out += d.toString()))
    p.stderr.on("data", (d) => (out += d.toString()))
    p.on("error", reject)
    p.on("close", (code) => resolve({ code: code ?? -1, out }))
  })
}

let cachedDevice: string | null = null

async function findMic(): Promise<string> {
  if (process.env.OPENCODE_STT_MIC) return process.env.OPENCODE_STT_MIC
  if (cachedDevice) return cachedDevice
  const { out } = await run(FFMPEG, [
    "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy",
  ])
  const devices: { name: string; alt?: string }[] = []
  for (const line of out.split(/\r?\n/)) {
    const friendly = /"([^"]+)"\s+\(audio\)/.exec(line)
    if (friendly) {
      devices.push({ name: friendly[1] })
      continue
    }
    const alt = /Alternative name "([^"]+)"/.exec(line)
    if (alt && devices.length > 0) devices[devices.length - 1].alt = alt[1]
  }
  if (devices.length === 0) {
    throw new Error(
      "No DirectShow audio input device found. Set OPENCODE_STT_MIC (e.g. the microphone name from `ffmpeg -list_devices true -f dshow -i dummy`)."
    )
  }
  const first = devices[0]
  cachedDevice = first.alt ?? first.name
  return cachedDevice
}

async function record(): Promise<string> {
  const mic = await findMic()
  const file = join(tmpdir(), `opencode-voice-${Date.now()}.wav`)

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      "-hide_banner", "-y", "-stdin",
      "-f", "dshow", "-i", `audio=${mic}`,
      "-t", String(MAX_SECONDS),
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-af", `silencedetect=noise=${NOISE_DB}dB:d=${SILENCE_SECONDS}`,
      file,
    ], { stdio: ["pipe", "ignore", "pipe"] })

    let err = ""
    let quitSent = false
    let quitTimer: NodeJS.Timeout | null = null
    const started = Date.now()

    const quit = () => {
      if (quitSent) return
      quitSent = true
      try {
        proc.stdin.write("q\n")
      } catch {
        // ignore
      }
    }

    const watchdog = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }, (MAX_SECONDS + 10) * 1000)

    proc.stderr.on("data", (d) => {
      const chunk = d.toString()
      err = (err + chunk).slice(-4000)
      for (const line of chunk.split(/\r?\n/)) {
        if (/silence_start:/.test(line) && !quitSent) {
          if (quitTimer) clearTimeout(quitTimer)
          quitTimer = setTimeout(() => {
            if (Date.now() - started >= 1500) quit()
          }, 700)
        }
        if (/silence_end:/.test(line) && quitTimer) {
          clearTimeout(quitTimer)
          quitTimer = null
        }
      }
    })

    proc.on("error", () => {
      clearTimeout(watchdog)
      if (quitTimer) clearTimeout(quitTimer)
      reject(
        new Error(
          `ffmpeg not found. Install ffmpeg and make sure it is on PATH, or set OPENCODE_STT_FFMPEG. (${FFMPEG})`
        )
      )
    })

    proc.on("close", (code) => {
      clearTimeout(watchdog)
      if (quitTimer) clearTimeout(quitTimer)
      if (code === 0) resolve(file)
      else reject(new Error(`recording failed (exit ${code}): ${err.slice(-400)}`))
    })
  })
}

async function transcribeCloud(file: string): Promise<string> {
  const buf = readFileSync(file)
  const form = new FormData()
  form.append("file", new File([buf], file.split(/[\\/]/).pop() ?? "audio.wav", { type: "audio/wav" }))
  form.append("model", MODEL)
  if (LANGUAGE) form.append("language", LANGUAGE)
  const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`STT API ${res.status}: ${text.slice(0, 300)}`)
  try {
    const json = JSON.parse(text)
    return typeof json.text === "string" ? json.text : text
  } catch {
    return text
  }
}

async function ensureLocalServer(): Promise<void> {
  try {
    const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`)
    if (r.ok) return
  } catch {
    // not running yet
  }
  const g = globalThis as any
  try {
    if (!g.__ocSttLocalProc || g.__ocSttLocalProc.exitCode !== null) {
      const proc = spawn(VENV_PY, [SERVER_PY, String(LOCAL_PORT)], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      })
      g.__ocSttLocalProc = proc
      proc.stderr?.on("data", (d) => {
        const line = String(d).trim()
        if (line) console.warn("[voice-input] local stt:", line.slice(0, 300))
      })
      proc.on("exit", () => {
        if (g.__ocSttLocalProc === proc) g.__ocSttLocalProc = null
      })
    }
  } catch (e) {
    throw new Error(`failed to start local whisper server: ${e instanceof Error ? e.message : String(e)}`)
  }
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const r = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`)
      if (r.ok) return
    } catch {
      // keep waiting
    }
  }
  throw new Error("local whisper server did not become ready in time (check opencode logs)")
}

async function transcribeLocal(file: string): Promise<string> {
  await ensureLocalServer()
  const buf = readFileSync(file)
  const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/inference`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-language": (LANGUAGE || "zh").toLowerCase(),
    },
    body: new Uint8Array(buf),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`local STT ${res.status}: ${text.slice(0, 300)}`)
  try {
    const json = JSON.parse(text)
    return typeof json.text === "string" ? json.text : ""
  } catch {
    return text
  }
}

async function transcribeFile(file: string): Promise<string> {
  return BACKEND === "cloud" ? transcribeCloud(file) : transcribeLocal(file)
}

function localConfigured(): boolean {
  return existsSync(VENV_PY) && existsSync(SERVER_PY)
}

function extFromMime(type: string | null): string {
  const t = (type ?? "").toLowerCase()
  if (t.includes("wav")) return "wav"
  if (t.includes("ogg")) return "ogg"
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a"
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3"
  return "webm"
}

function saveTemp(data: ArrayBuffer, ext: string): string {
  const file = join(tmpdir(), `opencode-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  writeFileSync(file, Buffer.from(data))
  return file
}

function toWav16k(input: string): Promise<string> {
  if (input.toLowerCase().endsWith(".wav")) return Promise.resolve(input)
  const output = input.replace(/\.[^.]+$/, "") + ".wav"
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      "-hide_banner", "-y", "-i", input,
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      output,
    ])
    let err = ""
    p.stderr.on("data", (d) => (err += d.toString()))
    p.on("error", reject)
    p.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`ffmpeg convert failed (${code}): ${err.slice(-300)}`))
    )
  })
}

function tryUnlink(file: string | null) {
  if (!file) return
  try {
    unlinkSync(file)
  } catch {
    // ignore
  }
}

function startBridge() {
  const g = globalThis as any
  if (g.__ocVoiceSttBridge) return
  const B = g.Bun
  if (!B || typeof B.serve !== "function") {
    console.warn("[voice-input] Bun.serve not available, mic button bridge disabled")
    return
  }
  try {
    const server = B.serve({
      hostname: "127.0.0.1",
      port: PORT,
      async fetch(req: Request) {
        const cors: Record<string, string> = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Private-Network": "true",
        }
        const json = (obj: unknown, status = 200) =>
          new Response(JSON.stringify(obj), {
            status,
            headers: { ...cors, "Content-Type": "application/json" },
          })
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
        let url: URL
        try {
          url = new URL(req.url)
        } catch {
          return json({ error: "bad url" }, 400)
        }
        if (req.method !== "POST" || url.pathname !== "/transcribe") {
          return json({ error: "not found" }, 404)
        }
        let input: string | null = null
        let converted: string | null = null
        try {
          if (BACKEND === "cloud" && !API_KEY) {
            return json({ error: "STT API key not set (OPENCODE_STT_API_KEY)" }, 500)
          }
          if (BACKEND === "local" && !localConfigured()) {
            return json({ error: "local whisper is not installed" }, 500)
          }
          const ct = (req.headers.get("content-type") ?? "").toLowerCase()
          if (ct.startsWith("multipart/form-data")) {
            const form = await req.formData()
            const blob = form.get("file")
            if (!(blob instanceof Blob)) return json({ error: "missing file field" }, 400)
            input = saveTemp(await blob.arrayBuffer(), extFromMime(blob.type))
          } else {
            input = saveTemp(await req.arrayBuffer(), extFromMime(req.headers.get("content-type")))
          }
          converted = await toWav16k(input)
          const text = await transcribeFile(converted)
          return json({ text })
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500)
        } finally {
          tryUnlink(input)
          if (converted !== input) tryUnlink(converted)
        }
      },
    })
    g.__ocVoiceSttBridge = server
    console.log(`[voice-input] STT bridge listening on http://127.0.0.1:${PORT}`)
  } catch (e) {
    console.warn("[voice-input] failed to start STT bridge:", e)
  }
}

export default (async (ctx) => {
  startBridge()
  const toast = async (title: string, description: string, severity: "success" | "info" | "error") => {
    try {
      await ctx.client.tui.publish({
        body: { type: "toast", toast: { title, description, severity } } as any,
      })
    } catch {
      // ignore
    }
  }
  const describe = () => (readState().enabled ? "ON" : "OFF")
  return {
    tool: {
      voice_input: tool({
        description:
          "Record audio from the user's microphone and transcribe it to text (speech-to-text). " +
          "Use this when the user asks to speak, dictate, or says something like 语音输入 / 听我说 / 用语音说. " +
          "Pass action='on'/'off'/'toggle'/'status' to control voice input instead of recording. " +
          "Never auto-record on your own initiative — only record when the user explicitly asks.",
        args: {
          action: tool.schema
            .enum(["record", "on", "off", "toggle", "status"])
            .describe("Defaults to 'record'. Use on/off/toggle/status to control voice input."),
        },
        async execute({ action }: { action?: SttAction }) {
          const act: SttAction = action ?? "record"

          if (act === "status") {
            return `voice_input is ${describe()}.`
          }
          if (act === "on") {
            writeState(true)
            await toast("Voice Input ON", "麦克风语音输入已开启", "success")
            return "voice_input enabled. Recording on the next explicit request."
          }
          if (act === "off") {
            writeState(false)
            await toast("Voice Input OFF", "麦克风语音输入已关闭", "info")
            return "voice_input disabled. Recording will be refused until turned back on."
          }
          if (act === "toggle") {
            const next = !readState().enabled
            writeState(next)
            await toast(
              next ? "Voice Input ON" : "Voice Input OFF",
              next ? "麦克风语音输入已开启" : "麦克风语音输入已关闭",
              next ? "success" : "info",
            )
            return `voice_input toggled ${next ? "on" : "off"}.`
          }

          if (!readState().enabled) {
            return "voice_input is currently disabled, so nothing was recorded. Turn it on with voice_input(action='on')."
          }
          if (BACKEND === "cloud" && !API_KEY) {
            return "voice_input error: cloud STT API key not set. Set OPENCODE_STT_API_KEY or switch OPENCODE_STT_BACKEND=local."
          }
          if (BACKEND === "local" && !localConfigured()) {
            return `voice_input error: local whisper is not installed (expected ${SERVER_PY}).`
          }
          let file: string | null = null
          try {
            file = await record()
            const text = await transcribeFile(file)
            if (!text || !text.trim()) {
              return "No speech detected. Please try again and speak clearly."
            }
            return `Transcribed speech: "${text.trim()}"`
          } catch (e) {
            return `voice_input failed: ${e instanceof Error ? e.message : String(e)}`
          } finally {
            tryUnlink(file)
          }
        },
      }),
    },
  }
}) satisfies Plugin
