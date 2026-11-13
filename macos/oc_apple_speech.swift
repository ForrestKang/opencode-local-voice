import Foundation
import Speech

struct SpeechOutput: Encodable {
    let text: String
    let on_device: Bool
}

struct ErrorOutput: Encodable {
    let error: String
}

func emitJSON<T: Encodable>(_ value: T, to stderr: Bool = false) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(value),
       var line = String(data: data, encoding: .utf8) {
        line.append("\n")
        if let bytes = line.data(using: .utf8) {
            if stderr {
                FileHandle.standardError.write(bytes)
            } else {
                FileHandle.standardOutput.write(bytes)
            }
        }
    }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emitJSON(ErrorOutput(error: message), to: true)
    exit(code)
}

func parseArgs() -> (audioPath: String, language: String) {
    var audioPath = ""
    var language = "auto"
    var index = 1
    let args = CommandLine.arguments
    while index < args.count {
        let arg = args[index]
        if arg == "--audio", index + 1 < args.count {
            audioPath = args[index + 1]
            index += 2
        } else if arg == "--language", index + 1 < args.count {
            language = args[index + 1]
            index += 2
        } else {
            index += 1
        }
    }
    if audioPath.isEmpty {
        fail("--audio is required", code: 2)
    }
    return (audioPath, language)
}

func localeIdentifier(for language: String) -> String {
    switch language.lowercased() {
    case "zh", "zh-cn", "zh_cn", "zh-hans":
        return "zh-CN"
    case "en", "en-us", "en_us":
        return "en-US"
    default:
        let current = Locale.current.identifier
        return current.isEmpty ? "zh-CN" : current
    }
}

let (audioPath, language) = parseArgs()
let fileURL = URL(fileURLWithPath: audioPath)
guard FileManager.default.fileExists(atPath: fileURL.path) else {
    fail("Audio file does not exist")
}

var authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .notDetermined {
    let authSem = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { status in
        authStatus = status
        authSem.signal()
    }
    _ = authSem.wait(timeout: .now() + 15)
}

guard authStatus == .authorized else {
    fail("请在系统设置 → 隐私与安全性 → 语音识别 中允许终端 / OpenCode 使用语音识别")
}

let locale = Locale(identifier: localeIdentifier(for: language))
guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
    fail("当前系统语言暂不支持 macOS 原生语音识别")
}
guard recognizer.isAvailable else {
    fail("macOS 系统语音识别服务当前不可用")
}

let request = SFSpeechURLRecognitionRequest(url: fileURL)
request.shouldReportPartialResults = false
let onDevice = recognizer.supportsOnDeviceRecognition
if #available(macOS 10.15, *) {
    request.requiresOnDeviceRecognition = onDevice
}

let doneSem = DispatchSemaphore(value: 0)
var transcript = ""
var recognitionError: Error?

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        transcript = result.bestTranscription.formattedString
        if result.isFinal {
            doneSem.signal()
        }
    } else if let error = error {
        recognitionError = error
        doneSem.signal()
    }
}

if doneSem.wait(timeout: .now() + 60) == .timedOut {
    task.cancel()
    fail("macOS 系统语音识别超时")
}

if let error = recognitionError, transcript.isEmpty {
    let nsErr = error as NSError
    // Code 1110 / kAFAssistantErrorDomain often means silence / no speech detected.
    if nsErr.code == 1110 || nsErr.code == 203 {
        emitJSON(SpeechOutput(text: "", on_device: onDevice))
        exit(0)
    }
    fail("macOS 语音识别错误: \(error.localizedDescription)")
}

emitJSON(SpeechOutput(text: transcript.trimmingCharacters(in: .whitespacesAndNewlines), on_device: onDevice))
