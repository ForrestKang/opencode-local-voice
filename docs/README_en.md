# OpenCode Local Voice

Speak directly in OpenCode and turn your ideas into editable prompts.

[![CI](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

[简体中文](../README.md) · [Installation](install.md) · [Configuration](configuration.md) · [V0.2.0 release notes](release-v0.2.0.md)

OpenCode Local Voice adds local speech input to OpenCode. Click the microphone next to the prompt, speak, and finish recording. The transcript appears in your current draft, ready for you to edit and send.

On desktop, Voice Input lives inside OpenCode's native settings and uses the host controls and theme. The same local speech service also powers Web, TUI, and CLI adapters.

## Features

- **Local recognition** with Whisper: faster-whisper and MLX on Apple Silicon.
- **Native settings** for microphone, language, model, and text processing.
- **Vocabulary and corrections** with a built-in coding vocabulary, custom terms, replacement rules, and JSON import/export.
- **Text formatting** with Chinese or English punctuation, spacing options, coding templates, and custom templates.
- **Optional AI rewriting** through an OpenAI-compatible endpoint. Local formatting is the default.
- **Update recovery** for supported Windows desktop installations, plus backup-based patch restoration.

## Quick start

You need Python 3.10+, Node.js 20+, and OpenCode. Initial setup downloads dependencies and a model. CLI/TUI microphone capture also requires FFmpeg.

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

Save your work and fully quit OpenCode before installing the desktop patch.

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
```

**macOS (experimental desktop integration)**

```bash
bash macos/install.sh --app /Applications/OpenCode.app
```

**Linux (local service)**

```bash
bash linux/install.sh
```

Linux desktop patching requires an explicit writable Electron application directory. For Web/TUI/CLI only, use `-NoApply` on Windows or `--no-apply` on macOS. See the [installation guide](install.md) for model selection, custom paths, and adapter setup. Detailed guides are currently in Chinese.

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

If voice input disappears after an OpenCode update, follow the [update guide](update-survival.md). To restore the pre-installation state, use the [recovery guide](recovery-v0.2.0.md).

## Privacy

Recording and recognition run locally by default. Enabling AI rewriting sends transcript text and the rewrite instruction to your configured provider. A personal Web userscript contains a local access credential; do not share or commit it. See [SECURITY.md](../SECURITY.md) for details.

## Feedback and contributions

Report bugs and suggest features through [Issues](https://github.com/ForrestKang/opencode-local-voice/issues). Include your OS, OpenCode version, installation method, reproduction steps, and error message. Remove API keys and private content.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup and the contribution process. Thanks to [OpenCode](https://github.com/anomalyco/opencode), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), and [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper).

Licensed under the [MIT License](../LICENSE).
