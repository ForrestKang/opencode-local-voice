# OpenCode Local Voice

> Speak directly inside OpenCode and turn voice into punctuated, editable prompts in real time.

[![CI](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.2.1-1f6feb.svg)](https://github.com/ForrestKang/opencode-local-voice/releases)
[![Rust Daemon](https://img.shields.io/badge/rust%20daemon-0.79%20MB-f97316.svg)](../rust/oc-voice-daemon/Cargo.toml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

[简体中文](../README.md) · [Installation](install.md) · [Configuration](configuration.md) · [Update Survival](update-survival.md) · [Recovery](recovery.md) · [Changelog](../CHANGELOG.md)

---

## Preview

| Idle (native prompt integration) | Recording (live waveform, Enter to transcribe, Esc to cancel) |
| :---: | :---: |
| ![Idle](assets/idle.png) | ![Recording](assets/recording.png) |

Click the microphone next to the prompt, speak, and press **Enter**. Transcripts are inserted into your draft for review—never auto-sent.

---

## Highlights

- **Zero-download default + 0.79 MB pure-Rust daemon**: Default installation skips heavy PyTorch / CUDA / Whisper downloads. An optional zero-Python single-binary Rust daemon (`rust/oc-voice-daemon`, **~0.79 MB**) handles cloud STT, AI rewrite, Chinese auto-punctuation, and offline `whisper-cli`, with automatic dual-backend discovery in `desktop-bridge.cjs`.
- **Smart punctuation & Chinese auto-segmentation**: Combines natural punctuation style prompts, pause-to-comma smart spacing, and clause-connector segmentation while protecting inline code, fenced blocks, URLs, file paths, and version numbers.
- **Native OpenCode Settings**: Manage recognition backends, API presets, microphone, coding vocabulary, custom templates, and optional AI rewriting inside **Settings → Voice Input** using native host controls and themes.
- **1-second OpenCode update check & rolling backup pruning**: Run `Repair-Voice.cmd -Compat` to verify all 5 `app.asar` patch anchors in under a second, `-Adapt` to re-patch right after an OpenCode upgrade, and automatic rolling backup pruning to avoid multi-GB backup buildup.
- **Shared local daemon for every adapter**: One HMAC-SHA256 authenticated `127.0.0.1` service powers Desktop, Web, TUI, and CLI.

---

## Recognition Backends

| Backend | Footprint / Dependencies | Highlights | Best For |
| --- | --- | --- | --- |
| **OpenAI-compatible STT** (default) | **Zero download** (stdlib or 0.79 MB Rust binary) | Built-in Groq Whisper, SiliconFlow SenseVoice, OpenAI & localhost presets | Ultra-lightweight instant setup |
| **macOS Apple Speech** | **Zero download** (`SFSpeechRecognizer`) | Native macOS framework with on-device recognition support | Everyday macOS usage |
| **Offline `whisper-cli`** | Single binary + GGUF model (~550 MB) | Managed directly by the Rust daemon without Python or 2 GB CUDA DLLs | Lightweight offline transcription |
| **Local `faster-whisper` / MLX** | Opt-in (`-WithLocalModel` / `--with-local-model`) | ~0.9s warm CUDA inference with coding hotword biasing | Maximum offline accuracy on NVIDIA GPU / Apple Silicon |

---

## Quick Start

Save your work and fully quit OpenCode first:

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

- **Windows (zero-download default)**
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
  # Optional local high-accuracy Whisper model:
  powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -WithLocalModel
  ```
- **macOS (Apple Speech default; experimental desktop patch)**
  ```bash
  bash macos/install.sh --app /Applications/OpenCode.app
  ```
- **Linux**
  ```bash
  bash linux/install.sh
  ```
- **Optional 0.79 MB Rust single-binary daemon**
  ```bash
  cd rust/oc-voice-daemon && cargo build --release
  ```

See the [Installation Guide](install.md) and [Configuration Guide](configuration.md) for all flags and settings.

---

## Updating & Adapting to New OpenCode Releases

```powershell
# Update plugin in place or from GitHub Releases
.\windows\Update-Plugin.cmd
.\windows\Update-Plugin.cmd -FromGitHub

# After an OpenCode upgrade: check anchors (1s), adapt, or prune old backups
$M = Join-Path $env:USERPROFILE '.config\opencode\voice-maintenance'
& (Join-Path $M 'Repair-Voice.cmd') -Compat
& (Join-Path $M 'Repair-Voice.cmd') -Adapt
& (Join-Path $M 'Repair-Voice.cmd') -Prune
```

See [Update Survival](update-survival.md) and [Recovery](recovery.md) for full details.

---

## Compatibility, Privacy & Contributing

- **Desktop support**: Per-user Windows Electron installs (`resources/app.asar`, including NTFS Junction `.config/opencode`), full macOS `.app` bundles (experimental), and writable Linux Electron unpacked directories.
- **Privacy**: Loopback-only (`127.0.0.1`), HMAC-SHA256 identity proof + Bearer auth, Windows DPAPI write-only secret storage. See [SECURITY.md](../SECURITY.md).
- **Contributing**: Issues and PRs are welcome at [GitHub Issues](https://github.com/ForrestKang/opencode-local-voice/issues); see [CONTRIBUTING.md](../CONTRIBUTING.md).

Thanks to [OpenCode](https://github.com/anomalyco/opencode), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper). Licensed under [MIT](../LICENSE).
