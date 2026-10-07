# OpenCode Local Voice V0.2.0

[简体中文](../README.md) · [Installation](install.md) · [Recovery](recovery-v0.2.0.md) · [Tests](testing-v0.2.0.md)

OpenCode Local Voice records audio locally, transcribes it on the same machine, and inserts the result into the current OpenCode draft. The user reviews and sends the draft. The feature does not submit prompts automatically. The local service binds to loopback; installing dependencies or downloading a model may require network access.

The public identifier is **V0.2.0**. This repository currently describes a release candidate and its evidence; it does not claim a Git tag, GitHub Release, or full real-device approval on every platform. Older `0.2.x` and `0.3.x` names are internal development history, not earlier public releases.

## Current evidence

One Windows live update was observed from OpenCode **1.18.34 to 1.18.35**. After the update, the V0.2.0 script loaded, the toolbar was mounted, recording started, and a result was inserted into the current draft. This observation does not measure recognition accuracy or latency and does not prove future versions, administrator installers, or other machines. See [the redacted Windows update record](windows-update-observed-v0.2.0.md) and [the validation summary](validation-results-v0.2.0.json).

The current audit report is maintained in [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md). The current checks passed 118 Node tests, 62 Python tests, 29 voice UI checks, 26 native settings checks and 13 standalone Electron checks. [testing-v0.2.0.md](testing-v0.2.0.md) separates these results from the previous candidate evidence. macOS has a Windows Git Bash simulation only; it is not real macOS runtime, signing, notarization, permission, Metal, microphone, or updater evidence.

## Behavior

- Voice settings live in OpenCode's native Settings tabs and follow the host layout, theme, scrolling, and keyboard navigation. The feature does not create a separate settings website.
- An optional isolated layout preview is available at [`docs/previews/native-settings-v2-light.png`](previews/native-settings-v2-light.png); it is a visual reference, not real-device evidence.
- The microphone button starts the requesting/recording flow. The transcription is inserted into the current draft and is never submitted automatically.
- `×` and Escape cancel requesting, recording, or busy work. STOP and Enter finish recording and start transcription.
- Ordinary Space keeps the host's normal editing behavior. IME composition and modified shortcuts are not claimed by voice input.
- There is no button that force-kills OpenCode. Normal `close`, Electron `destroyed`, and `will-quit` callbacks cover normal shutdown paths only. Task Manager termination, a hard kill, or power loss cannot run JavaScript exit hooks, so the feature cannot promise immediate cancellation, track release, or recovery of unsent audio and drafts in those cases.

Cancellation may terminate only the recognition worker owned by that task. The service refuses a shutdown while work is active; timeout cleanup is an exception path, not a hard-exit guarantee.

## Install and use

Requirements: Python 3.10+, Node.js 20+, and FFmpeg for CLI/TUI microphone capture. Close OpenCode normally before applying or restoring a desktop patch; the scripts do not terminate the application for you.

```powershell
# Windows: install the service, model, and desktop patch
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1

# Windows: install only the service for Web/TUI/CLI use
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -NoApply
```

For an existing Windows install, run the read-only candidate check first:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun
```

Then, with OpenCode closed, use `windows\install-feature-preview.cmd`. For a managed install, run `windows\Restore-Voice.cmd -DryRun` before a restore. See the [installation guide](install.md) and [recovery guide](recovery-v0.2.0.md) for exact parameters and refusal conditions.

macOS uses `bash macos/install.sh` and `bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run`. An official macOS update replaces the bundle, so apply the candidate again after that update. Linux desktop patching is limited to a specified writable unpacked Electron directory; the shared service can still be installed with `bash linux/install.sh`.

Web, TUI, and CLI use the shared local service. Run Web/CLI commands with the installer-created `whisper-venv` Python (or another interpreter where the runtime requirements are installed), rather than an unrelated system Python. A Web userscript generated with `tools/make-web-script.py` contains a private local credential and must stay on the same machine. The CLI accepts `--file AUDIO`, `--record --mic NAME`, or `--serve`; it does not send OpenCode prompts.

The optional TUI source is `extras/voice-input.ts`. Copy it to the project `.opencode/plugins/` or user-level `~/.config/opencode/plugins/`, preserving any existing file first, then restart OpenCode. Merge third-party dependencies into the existing config-directory `package.json`; do not replace it. See the [OpenCode Plugins documentation](https://opencode.ai/docs/plugins/). The plugin provides a `voice_input` tool with `record`, `status`, `on`, `off`, and `toggle` actions; recording uses FFmpeg and appends to the TUI draft without submitting it.

## Platform limits

Windows desktop recovery is version-, path-, and ASAR-hash-bound. Unknown layouts, administrator updates, busy services, and incompatible transactions fail closed. Never copy an old ASAR over a newer OpenCode version. Windows feature restore can replace configuration and runtime files inside the transaction snapshot; save later user changes before restoring and merge them afterwards.

macOS backups cover the complete `.app` bundle. Candidate ad-hoc signing is not Developer ID signing, notarization, or Gatekeeper approval. Real macOS permissions, microphone behavior, Metal/CPU inference, and the official updater remain manual validation items.

## Development and testing

Read [CONTRIBUTING.md](../CONTRIBUTING.md), [the testing guide](testing-v0.2.0.md), and [the manual checklist](manual-validation.md). Synthetic audio, substitute services, isolated ASAR fixtures, and a standalone Electron runtime do not prove a real microphone, a real OpenCode window, an official installer, or a real Mac application.

Do not publish tokens, personal userscripts, audio, transcripts, or private paths. See [SECURITY.md](../SECURITY.md).

[MIT License](../LICENSE)
