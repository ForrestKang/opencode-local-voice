# OpenCode Local Voice

在 OpenCode 中直接口述，把想法变成可编辑的提示词。

[![CI](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/ForrestKang/opencode-local-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](docs/README_en.md) · [安装指南](docs/install.md) · [设置指南](docs/configuration.md) · [V0.2.0 更新说明](docs/release-v0.2.0.md)

OpenCode Local Voice 为 OpenCode 提供本地语音输入。点击输入框旁的麦克风，说完后结束录音，识别结果就会写入当前草稿。你可以修改文字，再自行发送。

桌面端的“语音输入”直接放在 OpenCode 原生设置中，沿用宿主的控件与主题。语音识别在本机运行，也可通过同一服务接入 Web、TUI 和 CLI。

## 功能

- **本地识别**：使用 Whisper，支持 faster-whisper 与 Apple Silicon 上的 MLX 后端。
- **原生设置**：集中管理麦克风、识别语言、模型和文本处理选项。
- **词表与纠错**：内置编程词表，支持自定义术语、纠错规则和 JSON 导入导出。
- **文本整理**：可选中文或英文标点、空格处理、编程任务模板与自定义模板。
- **可选 AI 改写**：接入 OpenAI 兼容接口；默认使用本地整理，无需云端模型。
- **更新与恢复**：Windows 提供受支持安装包的更新后恢复，以及带备份的应用补丁恢复。

## 快速开始

准备 Python 3.10+、Node.js 20+ 和 OpenCode。首次安装需要联网下载依赖与模型；CLI/TUI 的麦克风录音还需要 FFmpeg。

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

保存工作并完全退出 OpenCode，然后按平台安装：

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
```

**macOS（桌面适配为实验性）**

```bash
bash macos/install.sh --app /Applications/OpenCode.app
```

**Linux（安装本地服务）**

```bash
bash linux/install.sh
```

Linux 桌面补丁需要指定可写的 Electron 解包目录。只使用 Web/TUI/CLI 时，Windows 可加 `-NoApply`，macOS 可加 `--no-apply`。自定义安装目录、模型选择和各端接入方法见 [安装指南](docs/install.md)。

## 使用

1. 打开 OpenCode 的 **设置 → 语音输入**，选择麦克风和识别语言，保存设置。
2. 在会话输入框旁点击麦克风，开始说话。
3. 点击结束按钮或按 **Enter**，结束录音并转写。
4. 检查插入草稿的文字，按需修改后发送。

点击 **×** 或按 **Esc** 可取消录音、等待中的麦克风请求或转写任务。普通空格键保持原有输入行为；标点和空格转换在设置中单独选择。词表、模板和 AI 配置见 [设置指南](docs/configuration.md)。

## 兼容性

桌面集成通过补丁接入 Electron 的 `app.asar`，需要匹配 OpenCode 的应用结构。官方更新可能改变这些结构，遇到不兼容的版本时应使用新版适配。

| 平台 / 入口 | 支持范围 |
| --- | --- |
| Windows Desktop | 用户级 Electron 安装，包含 `resources/app.asar`；通过维护后的快捷方式启动可检查并恢复插件 |
| macOS Desktop | 包含 `Contents/Resources/app.asar` 的完整 `.app`；实验性适配，官方更新后需重新应用补丁 |
| Linux Desktop | 指定的可写 Electron 解包目录 |
| Web | 本机生成的 userscript，绑定指定的 OpenCode Web Origin |
| TUI / CLI | 本地识别服务；TUI 插件提供 `voice_input` 工具，CLI 支持文件与麦克风转写 |

Tauri、商店包和未知桌面布局目前不支持应用补丁。macOS 补丁会对候选应用进行 ad-hoc 签名，可能影响系统信任与更新；安装前请阅读 [macOS 安装说明](docs/install.md#macos)。

OpenCode 更新后语音入口消失时，按 [更新指南](docs/update-survival.md) 处理；需要恢复安装前状态时，使用 [恢复指南](docs/recovery-v0.2.0.md)。

## 隐私

默认情况下，录音和识别都在本机完成。启用 AI 改写后，转写文本与改写提示会发送到你配置的模型服务。生成的个人 Web 脚本含本机访问凭据，请勿分享或提交到仓库。更多信息见 [安全说明](SECURITY.md)。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/ForrestKang/opencode-local-voice/issues) 提交问题或建议。报告问题时请附操作系统、OpenCode 版本、安装方式、复现步骤和错误信息，并移除密钥与私人内容。

开发环境和贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。感谢 [OpenCode](https://github.com/anomalyco/opencode)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper) 与 [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)。

本项目采用 [MIT License](LICENSE)。
