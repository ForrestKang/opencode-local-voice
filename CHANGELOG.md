# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- 🔧 中文标点：识别结果自动将中文语境的半角标点规范为全角（`,` → `，`、`?` → `？` 等，不影响英文单词 / 文件名 / 小数）
- 🔧 当自动检测为中文且结果完全不含标点时，自动携带标点提示词重试一次，避免出现"一整串没有标点"的长文本

## [0.1.0] - 2026-10-06

首个公开版本。

### 新增

- 🎤 OpenCode 桌面版提示词工具栏麦克风按钮（Windows / macOS）
- 🗣️ 本地识别服务：faster-whisper（large-v3-turbo），GPU（CUDA）优先、自动回退 CPU
- 🔌 三层架构：app.asar 注入（主进程权限 + preload IPC 桥 + 渲染层脚本）+ 本地 Python 服务
- 🚀 一键安装：`windows/install.ps1`、`macos/install.sh`（依赖 + 模型 + 补丁 + 重启）
- 🧯 一键还原：`restore-oc-mic.cmd` / `restore-oc-mic.sh`
- ✅ 补丁生成器内置全量哈希校验（6950+ 个文件），任何异常立即中止且不落盘
- 🔒 macOS 专项：Info.plist 麦克风权限声明、ad-hoc 重签名、asar 完整性 fuse 检查
- 🩺 调试日志：渲染层日志（`oc-mic-debug.log`）与识别服务日志（`stt_server.log`）
- 📦 `extras/voice-input.ts`：opencode 插件版实现（TUI / CLI 场景参考）

### 说明

- 实测 OpenCode 桌面版不加载 opencode 插件系统（server 运行在 Node 而非 Bun），
  因此本项目采用 app.asar 注入方案，独立于官方插件接口。
- OpenCode 升级会覆盖 `app.asar`，重跑一次 apply 脚本即可恢复。
