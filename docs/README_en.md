# OpenCode Local Voice

Speak directly in OpenCode and turn your ideas into editable prompts.

[![CI](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

[简体中文](../README.md) · [Installation](install.md) · [Configuration](configuration.md) · [Changelog (V0.2.1)](../CHANGELOG.md) · [Recovery](recovery.md)

OpenCode Local Voice adds voice input to OpenCode. Click the microphone next to the prompt, speak, and finish recording. The transcript appears in your current draft, ready for you to edit and send.

On desktop, Voice Input lives inside OpenCode's native settings and uses the host controls and theme. A lightweight standard-library local daemon coordinates recording, recognition, and text formatting for Desktop, Web, TUI, and CLI.

## Features

- **Zero-download lightweight default + optional 0.8 MB Rust single-binary daemon**: Default installation skips Whisper model downloads and heavy `pip` packages. An optional pure-Rust zero-Python daemon (`rust/oc-voice-daemon`, ~0.8 MB release binary) supports OpenAI-compatible STT, AI rewriting, Chinese auto-punctuation, and lightweight `whisper-cli` offline engines, with automatic dual-backend discovery in `desktop-bridge.cjs`.
- **Platform-adapted recognition**:
  - **macOS**: Uses built-in **Apple Speech** (`SFSpeechRecognizer`, supporting on-device recognition when available) with zero extra downloads.
  - **Windows / Linux / Cross-platform**: Supports **OpenAI-compatible STT APIs** (Groq Whisper, SiliconFlow SenseVoice, OpenAI Whisper, or a localhost Whisper server).
  - **Optional high-accuracy local models**: Opt in to `faster-whisper`, Apple Silicon MLX, or lightweight `whisper-cli` anytime.
- **Native settings**: Manage recognition mode, API presets, microphone, language, and text processing in one place.
- **Vocabulary and corrections**: Built-in coding vocabulary, custom terms, replacement rules, and JSON import/export.
- **Smart punctuation and auto-segmentation**: Natural Chinese/English punctuation, pause-to-comma smart spacing, automatic Chinese clause breaks (protecting code, URLs, and file paths), plus coding and custom templates.
- **Optional AI rewriting**: Connects to any OpenAI-compatible chat endpoint. Local formatting is the default.
- **Instant update adaptation & rolling backup pruning**: Windows ships `Repair-Voice.cmd -Compat` (1-second `app.asar` anchor check), `-Adapt` (one-command re-patch after OpenCode updates), and automatic rolling backup/cache pruning.

## Quick start

You need Python 3.10+, Node.js 20+, and OpenCode. Default lightweight setup downloads no Python wheels or Whisper models. CLI/TUI microphone capture still requires FFmpeg.

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

Save your work and fully quit OpenCode before installing:

**Windows (zero-download default; configure Groq / SiliconFlow / localhost STT API in Settings)**

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
```

**macOS (uses built-in Apple Speech by default; experimental desktop integration)**

```bash
bash macos/install.sh --app /Applications/OpenCode.app
```

**Linux (zero-download lightweight local service)**

```bash
bash linux/install.sh
```

To install local Whisper models (`faster-whisper` / CUDA / MLX), pass `-WithLocalModel` on Windows or `--with-local-model` on macOS/Linux. Linux desktop patching requires an explicit writable Electron directory. For Web/TUI/CLI only, add `-NoApply` (Windows) or `--no-apply` (macOS). See the [installation guide](install.md) and [configuration guide](configuration.md) for details.

## Usage

1. Open **Settings → Voice Input** (语音输入), choose your microphone and language, and save.
2. Click the microphone next to the session prompt and speak.
3. Click the stop button or press **Enter** to finish recording and transcribe.
4. Review the text inserted into your draft, edit as needed, and send it yourself.

Click **×** or press **Esc** to cancel microphone acquisition, recording, or transcription. Space keeps its normal editing behavior. Punctuation and spacing transforms are configured separately. See the [configuration guide](configuration.md) for vocabulary, templates, and AI settings.

## Compatibility

Desktop integration patches Electron's `app.asar` and depends on OpenCode's application structure. An official update can change that structure; incompatible versions require an updated adapter.

| Platform / adapter | Supported scope |
| --- | --- |
| Windows Desktop | Per-user Electron installs containing `resources/app.asar`; maintained shortcuts check and recover the plugin on launch |
| macOS Desktop | Complete `.app` bundles containing `Contents/Resources/app.asar`; experimental, with manual reapplication after official updates |
| Linux Desktop | Explicit writable unpacked Electron directories |
| Web | A locally generated userscript bound to the exact OpenCode Web Origin |
| TUI / CLI | Shared local service; the TUI adapter exposes `voice_input`, and the CLI transcribes files or microphone audio |

Tauri, store packages, and unknown desktop layouts are not supported by the patcher. The macOS patch ad-hoc signs the candidate application, which can affect system trust and updates. Read the [macOS installation notes](install.md#macos) before applying it.

If voice input disappears after an OpenCode update, follow the [update guide](update-survival.md). To restore the pre-installation state, use the [recovery guide](recovery.md).

## Privacy

Recording and recognition run locally by default. Enabling AI rewriting sends transcript text and the rewrite instruction to your configured provider. A personal Web userscript contains a local access credential; do not share or commit it. See [SECURITY.md](../SECURITY.md) for details.

## Feedback and contributions

Report bugs and suggest features through [Issues](https://github.com/ForrestKang/opencode-local-voice/issues). Include your OS, OpenCode version, installation method, reproduction steps, and error message. Remove API keys and private content.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup and the contribution process. Thanks to [OpenCode](https://github.com/anomalyco/opencode), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), and [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper).

Licensed under the [MIT License](../LICENSE).
