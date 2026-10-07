import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const require = createRequire(import.meta.url)
const base = join(homedir(), ".config", "opencode")
const voiceHome = process.env.OPENCODE_VOICE_HOME || join(base, "local-voice")
const stateFile = join(voiceHome, "tui-state.json")
const ffmpeg = process.env.OPENCODE_STT_FFMPEG || "ffmpeg"
const bridgeFile = process.env.OPENCODE_VOICE_BRIDGE || join(base, "whisper", "desktop-bridge.cjs")

function enabled(): boolean {
  try { return JSON.parse(readFileSync(stateFile, "utf8")).enabled !== false } catch { return true }
}
function setEnabled(value: boolean) {
  mkdirSync(voiceHome, { recursive: true, mode: 0o700 })
  const temporary = stateFile + "." + randomUUID() + ".tmp"
  writeFileSync(temporary, JSON.stringify({ enabled: value }) + "\n", { mode: 0o600 })
  renameSync(temporary, stateFile)
}
function run(args: string[], seconds: number, signal?: AbortSignal): Promise<{ output: Buffer; error: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []; let size = 0, error = "", done = false
    const finish = (failure?: Error, code = 0) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort)
      if (failure) reject(failure); else resolve({ output: Buffer.concat(chunks), error, code })
    }
    const abort = () => { proc.kill(); finish(new Error("Voice input cancelled")) }
    const timer = setTimeout(() => { proc.kill(); finish(new Error("Microphone capture timed out")) }, (seconds + 15) * 1000)
    proc.on("error", err => finish(new Error("FFmpeg failed to start: " + err.message)))
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    proc.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 10 * 1024 * 1024) { proc.kill(); finish(new Error("Recording exceeds the audio limit")) } else chunks.push(chunk)
    })
    proc.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-6000) })
    proc.on("close", code => finish(undefined, code ?? -1))
  })
}
async function inputArgs(mic?: string, signal?: AbortSignal): Promise<string[]> {
  if (process.platform === "win32") {
    let device = mic || process.env.OPENCODE_STT_MIC
    if (!device) {
      const listed = await run(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 5, signal)
      device = /"([^"]+)"\s+\(audio\)/.exec(listed.error)?.[1]
    }
    if (!device) throw new Error("No microphone found. Specify the DirectShow microphone name with mic.")
    return ["-f", "dshow", "-i", device.startsWith("audio=") ? device : "audio=" + device]
  }
  if (process.platform === "darwin") {
    const device = mic || process.env.OPENCODE_STT_MIC || "0"
    return ["-f", "avfoundation", "-i", device.startsWith(":") ? device : ":" + device]
  }
  if (process.platform === "linux") return ["-f", "pulse", "-i", mic || process.env.OPENCODE_STT_MIC || "default"]
  throw new Error("This microphone platform is not supported")
}
function pcmWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("No valid microphone samples")
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export default (async ctx => ({
  tool: {
    voice_input: tool({
      description: "Record local microphone audio only when the user explicitly asks to dictate. Transcribe locally and append to the TUI draft without submitting. on/off/toggle/status never record. Uses the same installed local service and configuration as Desktop/Web.",
      args: {
        action: tool.schema.enum(["record", "on", "off", "toggle", "status"]).optional().default("record"),
        seconds: tool.schema.number().int().min(1).max(300).optional().default(30),
        mic: tool.schema.string().optional().describe("Windows DirectShow name, macOS audio index, or Linux PulseAudio source"),
      },
      async execute({ action, seconds, mic }, context) {
        if (action === "on" || action === "off" || action === "toggle") {
          setEnabled(action === "on" || (action === "toggle" && !enabled()))
          return "Voice input " + (enabled() ? "enabled" : "disabled")
        }
        if (!enabled() && action === "record") return "Voice input is disabled. Enable it before recording."
        let client: any, id = randomUUID(), submitted = false, transcript = ""
        const cancel = () => { if (client && submitted) client.cancel(id).catch(() => {}) }
        try {
          client = require(bridgeFile).createClient({ voiceHome })
          if (action === "status") return JSON.stringify({ enabled: enabled(), service: await client.status() })
          const config = await client.getConfig()
          if (context.abort.aborted) return "Voice input cancelled"
          if (seconds > config.max_seconds) return "Recording duration exceeds the configured maximum of " + config.max_seconds + " seconds."
          context.abort.addEventListener("abort", cancel, { once: true })
          if (config.warmup_on_record) client.warmup().catch(() => {})
          const input = await inputArgs(mic, context.abort)
          if (context.abort.aborted) return "Voice input cancelled"
          const recorded = await run(["-nostdin", "-hide_banner", "-loglevel", "error", ...input,
            "-t", String(seconds), "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"], seconds, context.abort)
          if (recorded.code !== 0) throw new Error("Microphone capture failed: " + recorded.error.slice(-500))
          if (context.abort.aborted) return "Voice input cancelled"
          submitted = true
          const result = await client.transcribe(pcmWav(recorded.output), "audio/wav", id)
          if (context.abort.aborted) return "Voice input cancelled"
          if (result.error) throw new Error(result.error)
          if (!result.text?.trim()) return "No speech detected."
          transcript = result.text
          await ctx.client.tui.appendPrompt({ body: { text: transcript }, throwOnError: true })
          return "Transcribed and appended to the draft. Review before sending: " + result.text
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return transcript ? "Transcription succeeded but the draft could not be updated: " + detail + "\nCopy this text into your draft: " + transcript : "Voice input failed: " + detail
        }
        finally { context.abort.removeEventListener("abort", cancel) }
      },
    }),
  },
})) satisfies Plugin
