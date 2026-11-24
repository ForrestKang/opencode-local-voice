# 更新记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。

## [0.2.1] — 2026-11-24

### Added

- 新增“按平台差异化零下载”默认安装路径，仅创建纯 Python 标准库虚拟环境（`--without-pip`），跳过 PyTorch / Whisper 依赖与模型下载；保留 `-WithLocalModel` / `--with-local-model` 作为可选高精度本地模型开关。
- 新增纯 Rust 零 Python 单文件守护进程（`rust/oc-voice-daemon`，Release 约 0.8 MB），内置完整 HTTP v1 + HMAC-SHA256 协议、`Condvar` `after_state` 长轮询、Windows DPAPI 凭据互通、中文标点自动断句、OpenAI 兼容云端 STT/AI 改写与轻量离线 `whisper-cli` 引擎，并由 `desktop-bridge.cjs` 自动双后端探测。
- 新增 macOS 原生 `apple-speech` 后端（`macos/oc_apple_speech.swift`，调用系统 `SFSpeechRecognizer`，支持端侧识别）与全平台 `openai-api` 兼容语音识别客户端（含 `stt_api_key` 加密存储与 `POST /v1/stt/test` 连通性测试）。
- 在 OpenCode 原生“语音输入”设置页中加入识别模式选择、接口预设（Groq Whisper、SiliconFlow SenseVoice、OpenAI Whisper、本机 Whisper 服务）、远端模型拉取与连通性测试按钮，并明确标点断句与停顿处理说明。
- 新增备份自动滚动瘦身与缓存清理（`feature-update.cjs prune`、`maintenance-package.cjs --prune-cache`、`Repair-Voice.ps1 -Prune`），单次事务自动去重冗余 `app.asar` 副本并仅保留原版干净备份与最新回滚点。
- 新增 OpenCode 更新即时兼容预检与一键适配（`patch-package.cjs --check-compat`、`Repair-Voice.ps1 -Compat` / `-Adapt`），1 秒内逐项校验 5 个注入锚点。

### Changed

- 全面优化中文标点与自动断句：升级 Whisper 提示词为领域中性自然标点风格锚点、调优 VAD 静默分段（`320ms/180ms`）、升级 `space_mode=smart` 将中文长停顿空格自动转为逗号、为无标点中文长句补充连接词断句与句尾 `。`/`？`（严格避开代码块/URL/路径等受保护片段）。
- `apple-speech` 与 `openai-api` 任务改为在服务进程内的轻量后台线程运行，避免启动重量级 `ProcessWorker` 及跳过本地模型预热；`auto` 模式下未配置识别后端时明确返回 `stt_not_configured`。
- 升级任务状态查询为 `after_state` 零轮询长连接与每任务独立 HTTP keep-alive 连接池；合并平台冗余源码，统一由 `shared/oc-mic.js` 和 `shared/voice_server.py` 单源维护，提取 `windows/voice-paths.ps1` 统一处理 NTFS Junction 路径。
- 原生设置页仅在选择 `faster-whisper` 或 `mlx` 时强制校验 `model_path`；打包脚本同步纳入 `.swift` 与 `rust/oc-voice-daemon` 源码并严格排除 `target/` 与密钥文件。

### Fixed

- 修复 `ModelDownloadManager.start_download()` 持锁重入死锁与空闲自动关闭误杀活跃模型下载的问题。
- 修复 `voice_text.py` HTTP 连接池在 TLS 1.3 `NewSessionTicket` 下的误驱逐与 `fetch_remote_models` 缺少 `urllib.error` 导入的问题。
- 修复 `faster-whisper` 在 CUDA + 编程热词下开启 `word_timestamps` 触发句尾残余片段温度重试导致超时与尾部幻觉的问题。
- 修复纯英文文本在 `punctuation_mode=auto` + `language=zh` 时句号被误转为中文 `。`、`process_transcript` 未透传识别语言到 AI 改写、以及后端热更新 `app.asar` 未变时 `Update-Plugin.ps1` 报错的问题。
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
