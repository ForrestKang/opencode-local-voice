# OpenCode Local Voice

> 在 OpenCode 里直接开口说需求，自动断句加标点，把口语实时变成可直接编辑的高质量提示词。

[![CI](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.2.1-1f6feb.svg)](https://github.com/ForrestKang/opencode-local-voice/releases)
[![Rust Daemon](https://img.shields.io/badge/rust%20daemon-0.79%20MB-f97316.svg)](rust/oc-voice-daemon/Cargo.toml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](docs/README_en.md) · [安装指南](docs/install.md) · [设置指南](docs/configuration.md) · [更新与恢复](docs/update-survival.md) · [回滚指南](docs/recovery.md) · [更新记录](CHANGELOG.md)

---

## 界面预览

**待机状态**（麦克风按钮原生融入输入框右侧）：

![待机状态](docs/assets/idle.png)

**录音中**（实时音量波形，**Enter** 结束转写、**Esc** 取消）：

![录音状态](docs/assets/recording.png)

点击输入框旁的麦克风即可口述，说完按 **Enter** 结束录音，文字会**直接写入草稿框**供你检查修改，绝不会擅自自动发送。

---

## 为什么好用

- **极简零下载 + 0.79 MB 纯 Rust 守护进程**：默认安装不下载任何 PyTorch / CUDA / Whisper 重型包；附带零 Python 依赖的纯 Rust 单文件守护进程（`rust/oc-voice-daemon`，编译后仅 **0.79 MB**），由桌面桥接自动探测切换，也可无缝保留已有高精度本地模型。
- **中文标点与自动断句**：结合自然标点风格锚点、停顿自动转逗号与中文长句连接词断句（自动补 `，` / `。` / `？`），同时严格保护反引号代码、URL、文件路径与版本号不被破坏。
- **原生 OpenCode 设置体验**：语音设置直接嵌入 **设置 → 语音输入**，沿用宿主主题与控件，一站式配置识别模式、API 预设、麦克风、词表纠错、提示词模板与可选 AI 改写。
- **OpenCode 更新 1 秒适配 + 备份自动滚动瘦身**：提供 `Repair-Voice.cmd -Compat`（1 秒逐项检查 5 个注入锚点）与 `-Adapt`（升级后一键热适配）；每次更新自动去重冗余 `app.asar` 副本并滚动保留原版备份与最新回滚点，告别 GB 级历史垃圾堆积。
- **一套本地服务，全端复用**：通过同一 HMAC-SHA256 认证的本地 `127.0.0.1` 协议，同时驱动 Desktop、Web、TUI 与 CLI。

---

## 识别方案对比（按需选择）

| 方案 | 额外依赖与体积 | 速度与特点 | 适用场景 |
| --- | --- | --- | --- |
| **云端 OpenAI 兼容 STT**（默认） | **零下载**（纯标准库或 0.79 MB Rust 单文件） | 内置 Groq Whisper、硅基流动 SenseVoice、OpenAI、本机服务预设，即装即用 | 追求极致轻量、不想装 Python / GPU 环境 |
| **macOS Apple Speech** | **零下载**（系统原生 `SFSpeechRecognizer`） | 支持端侧离线识别，零额外内存占用 | macOS 日常主力 |
| **轻量离线 `whisper-cli`** | 单文件引擎 + GGUF 量化模型（~550 MB） | 由 Rust 守护进程直接托管，免 Python 与 2 GB CUDA 依赖 | 跨平台轻量离线 |
| **本地高精度 `faster-whisper` / MLX** | 按需安装（`-WithLocalModel` / `--with-local-model`） | NVIDIA CUDA 热态 ~0.9s，支持完整编程热词偏置 | 已有独显 / Apple Silicon，追求离线最高精度 |

---

## 快速开始

先保存工作并完全退出 OpenCode，克隆仓库后按平台执行一行命令：

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

### Windows（默认零下载）

```powershell
# 默认轻量化安装（零模型/零重依赖下载）
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1

# 如需离线高精度本地 Whisper（CUDA / CPU）
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -WithLocalModel
```

### macOS（默认系统 Apple Speech，桌面补丁为实验性）

```bash
bash macos/install.sh --app /Applications/OpenCode.app
```

### Linux

```bash
bash linux/install.sh
```

> 仅使用 Web / TUI / CLI 时，Windows 可加 `-NoApply`，macOS 可加 `--no-apply`。更多参数见 [安装指南](docs/install.md)。

### 可选：编译 0.79 MB 纯 Rust 单文件守护进程

无需 Python 运行时，安装 Rust 工具链后即可本地编出单文件 `oc-voice-daemon` 并放入 `~/.config/opencode/whisper/`，桌面端会自动探测接管：

```bash
cd rust/oc-voice-daemon
cargo build --release
```

---

## 日常使用与快捷键

1. 打开 OpenCode **设置 → 语音输入**，选择识别方式（或填写 Groq / 硅基流动等兼容 API 预设）、麦克风和语言并保存。
2. 推荐文本设置：**标点与自动断句 = 中文标点（或自动）** + **空格与停顿处理 = 智能整理**。
3. 在输入框旁点击麦克风开始说话：
   - **Enter / 结束按钮**：结束录音并转写，结果自动写入当前草稿。
   - **Esc / ×**：取消录音、麦克风请求或进行中的转写。
   - **普通空格键**：完全保留 OpenCode 原有编辑行为。

词表、纠错对照、自定义模板与 AI 改写配置见 [设置指南](docs/configuration.md)。

---

## 更新插件 & 适配新版 OpenCode

### 1. 插件一键增量更新（保留已有配置与模型）

```powershell
# 本地仓库增量更新
.\windows\Update-Plugin.cmd

# 从 GitHub 最新 Release 直接拉取更新
.\windows\Update-Plugin.cmd -FromGitHub
```

### 2. OpenCode 官方升级后 1 秒预检与热适配

```powershell
$M = Join-Path $env:USERPROFILE '.config\opencode\voice-maintenance'

# 1 秒检查新版 OpenCode app.asar 的 5 个注入锚点是否兼容
& (Join-Path $M 'Repair-Voice.cmd') -Compat

# 兼容时一键热适配（无需重装环境）
& (Join-Path $M 'Repair-Voice.cmd') -Adapt

# 手动触发备份与缓存滚动瘦身（每次更新也会自动执行）
& (Join-Path $M 'Repair-Voice.cmd') -Prune
```

完整恢复与回滚流程见 [更新与恢复](docs/update-survival.md) 与 [回滚指南](docs/recovery.md)。

---

## 架构与目录

采用**三层解耦设计**——更新标点断句、识别协议或 Rust 守护进程时，只需替换后台文件，无需反复重打 `app.asar`：

```text
OpenCode Desktop (极薄 ASAR 钩子)
   └─ shared/desktop-bridge.cjs  (HMAC-SHA256 校验 + 双后端自动探测)
        ├─ rust/oc-voice-daemon  (0.79 MB 零 Python 单文件：云端 STT / AI 改写 / whisper-cli / 中文断句)
        └─ shared/voice_server.py (可选 Python 引擎：faster-whisper CUDA / Apple MLX / Apple Speech)
```

| 目录 | 职责 |
| --- | --- |
| `shared/` | 单源前端（`oc-mic.js`、`native-voice-settings.js`）、桌面/Web 桥接、ASAR 补丁与兼容预检、Python 服务端与文本断句引擎 |
| `rust/oc-voice-daemon/` | 纯 Rust 零 Python 单文件守护进程源码（`Cargo.toml` + `src/`） |
| `windows/` `macos/` `linux/` | 各平台安装、一键更新（`Update-Plugin.ps1`）、修复适配（`Repair-Voice.ps1`）与恢复脚本 |
| `extras/` | OpenCode TUI 语音插件（`voice-input.ts`） |
| `tests/` `tools/` | Python / Node / Rust / Edge 浏览器回归测试套件与发布打包校验脚本 |

---

## 兼容性与隐私

| 入口 | 支持范围 |
| --- | --- |
| Windows Desktop | 用户级 Electron 安装（`resources/app.asar`），自动支持 `.config/opencode` NTFS Junction 路径 |
| macOS Desktop | 完整 `.app`（`Contents/Resources/app.asar`），实验性适配，见 [macOS 说明](docs/install.md#macos) |
| Linux Desktop | 指定可写 Electron 解包目录 |
| Web / TUI / CLI | 复用同一本机认证服务；Web 个人脚本绑定指定 Origin |

- **隐私安全**：本地服务仅监听 `127.0.0.1`，所有请求经 Bearer Token + HMAC 挑战校验，API 密钥在 Windows 使用系统 DPAPI 加密存储且仅写不回显；未主动启用云端 STT / AI 改写时音频与文本不会离开本机。详见 [安全说明](SECURITY.md)。

---

## 参与贡献与致谢

欢迎通过 [Issues](https://github.com/ForrestKang/opencode-local-voice/issues) 反馈兼容情况或提交 PR，开发与测试指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

感谢 [OpenCode](https://github.com/anomalyco/opencode)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 与 [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)。

本项目基于 [MIT License](LICENSE) 开源。
