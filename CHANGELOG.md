# 更新记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。

## [0.2.1] — 2026-11-14

### Added

- 新增“按平台差异化零下载”默认安装路径，仅创建纯 Python 标准库虚拟环境（`--without-pip`），跳过 PyTorch / Whisper 依赖与模型下载；保留 `-WithLocalModel` / `--with-local-model` 作为可选高精度本地模型开关。
- 新增 macOS 原生 `apple-speech` 后端（`macos/oc_apple_speech.swift`，调用系统 `SFSpeechRecognizer`，支持端侧识别）与全平台 `openai-api` 兼容语音识别客户端（含 `stt_api_key` 加密存储与 `POST /v1/stt/test` 连通性测试）。
- 在 OpenCode 原生“语音输入”设置页中加入识别模式选择、接口预设（Groq Whisper、SiliconFlow SenseVoice、OpenAI Whisper、本机 Whisper 服务）与连通性测试按钮。

### Changed

- `apple-speech` 与 `openai-api` 任务改为在服务进程内的轻量后台线程运行，避免启动重量级 `ProcessWorker` 及跳过本地模型预热；`auto` 模式下未配置识别后端时明确返回 `stt_not_configured`。
- 原生设置页仅在选择 `faster-whisper` 或 `mlx` 时强制校验 `model_path`；打包脚本同步纳入 `.swift` 源码。

### Fixed

- 修复 Windows PowerShell 安装器在向 `install-support.py configure` 传空 `--model-path ""` 时参数被吞导致报错的问题。

## [0.2.0] — 2026-10-07

### Added

- 在 OpenCode 原生设置中加入“语音输入”设置页，沿用宿主的布局、主题和键盘行为。
- 支持本地词表、纠错、提示词模板、语言、标点和空格规则；可选的 AI 改写默认关闭。
- 通过同一本机服务为 Desktop、Web、TUI 和 CLI 提供语音转写能力。
- 增加 Windows 应用更新后的维护和恢复入口，以及 macOS 完整应用备份和恢复支持。

### Changed

- 录音结果写入当前草稿，由用户检查后自行发送，不会自动提交消息。
- Enter 或 STOP 结束录音并开始转写，Esc 或 `×` 取消当前任务；普通空格继续保持 OpenCode 原有行为。
- 取消操作按窗口和任务隔离，服务有其他活动任务时不会被静默关闭。
- 更新和恢复操作按版本、路径、ASAR 哈希及事务清单匹配备份，未知布局会停止并提示原因。

### Fixed

- 修复首次转写和异步取消过程中的状态竞态，避免取消后继续录音或把结果写入草稿。
- 修复无效 CLI 参数仍启动语音服务的问题。
- 修复保存未变化的配置时被错误拒绝的问题。
- 修复 Windows 后台启动时弹出终端的问题。
- 修复 Electron 环境将物理 `app.asar` 误判为缺失，导致更新恢复失败的问题。
- 修复恢复流程误选无关事务、备份目录位于应用目录内，以及不支持的 Windows 应用布局被错误接受的问题。
- 让原生设置页的词表、纠错和模板限制与服务端保持一致。

## [0.1.2] — 2026-10-06

- 录音过程中按 Enter 结束录音并开始转写。

## [0.1.1] — 2026-10-06

- 改进中文标点处理和安装器中的模型选择。
