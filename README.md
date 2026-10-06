<h1 align="center">🎙 OpenCode Local Voice</h1>

<p align="center">
  <strong>给 OpenCode 桌面版装上「开口就能说话」的本地语音输入</strong>
</p>

<p align="center">
  点一下麦克风，说完再点一下，文字自己写进输入框 —— 全程离线，不用一分钱 API
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-0078D6.svg?style=for-the-badge" alt="Platform"></a>
  <a href="VERSION"><img src="https://img.shields.io/badge/Version-v0.1.0-orange.svg?style=for-the-badge" alt="Version"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#特性">特性</a> · <a href="#工作原理">工作原理</a> · <a href="#常见问题">常见问题</a> · <a href="#卸载">卸载</a> · <a href="CHANGELOG.md">更新日志</a>
</p>

---

## 为什么需要 OpenCode Local Voice？

用 OpenCode 写代码，最常干的事是"描述需求"——可每次都得把脑子里的 Prompt 一个字一个字敲出来：

- ⌨️ "打一段两百字的 prompt" → **手酸**，明明动嘴几秒就能说完
- 🚫 "OpenCode 桌面版有没有语音输入" → **没有**，官方相关提案一直没落地
- ☁️ "装个语音插件" → 要么是 TUI 专属，要么是云端识别：**要 Key、要联网、要花钱，音频还得上传**
- 🧩 "那装现成的 opencode 插件呗" → **装不上**，实测桌面版根本不加载插件系统（server 跑在 Node 里，npm / 本地插件全部无效）
- 🔌 "自己接一个" → 录音、编码、CORS、麦克风权限、进程管理…… **全是碎活**

**OpenCode Local Voice 把这件事变成一句话：**

```
帮我安装 OpenCode Local Voice：https://raw.githubusercontent.com/ForrestKang/opencode-local-voice/main/docs/install.md
```

把这句话发给你电脑上的 AI Agent（Claude Code、Cursor、Windsurf……任何能跑命令行的）：它会自己读取安装说明，完成依赖安装、模型下载、补丁注入与重启全套流程。详细步骤见 [docs/install.md](docs/install.md)。

> ⭐ **Star 这个项目**：OpenCode 更新会覆盖补丁，我会持续跟踪新版本、保证 apply 脚本一直可用。你不用自己盯。

### ✅ 在你用之前，你可能想知道

| | |
|---|---|
| 💰 **完全免费** | 识别用本地 Whisper 模型，零 API 费用；一次性下载模型 ≈1.6GB（可换 medium/small 更小） |
| 🔒 **隐私安全** | 音频只在你的电脑里流转：麦克风 → 本地服务，**不上传、不出网** |
| 🎯 **开箱即用** | 麦克风按钮直接长在发送键左边，不改变 OpenCode 任何原有交互 |
| 🔄 **抗更新** | OpenCode 升级覆盖补丁后，重跑一条 apply 脚本即恢复，不用重装 |
| 🩺 **自带诊断** | 渲染层调试日志 + 识别服务日志，出问题一眼定位 |
| 🧯 **可回滚** | 打补丁前自动备份原版 app.asar（macOS 含 Info.plist），一键还原官方 |

---

## 效果

<p align="center">
  <img src="docs/assets/recording.png" alt="录音界面：波形、计时、取消 / 停止按钮" width="720">
</p>

> 实录截图（浅色主题）：点击麦克风后进入录音状态 —— 波形 + 计时 + 停止

- 点 🎤 开始录音：图标变红、呼吸闪烁
- 说完再点一下（或满 60 秒自动结束）
- 识别中图标转圈，1 秒左右后**文字直接出现在输入框**，改完按回车即发
- 自动识别中 / 英 / 混说，不需要切换

---

## 特性

- 🎤 **按钮在提示词工具栏上**：和发送键同排、同款尺寸，无感融入
- 🗣️ **本地识别**：faster-whisper large-v3-turbo，GPU（CUDA）优先、自动回退 CPU
- ⚡ **服务按需拉起**：不用语音时零常驻；空闲 30 分钟自动退出释放显存
- 🧠 **自动语言检测**：中英混合也能正确转写
- 🧩 **不依赖官方插件系统**：桌面版不加载插件？没关系，我们用 asar 注入方案
- 🧯 **全程可回滚**：所有改动有备份、有校验、有一键还原

---

## 工作原理

**本项目是一个「本地补丁 + 本地服务」的组合，不是普通插件。**

实测 OpenCode 桌面版不加载 opencode 插件系统（server 运行在 Node 而非 Bun，npm 插件缓存不生成、本地插件不加载），所以走三层方案：

| 层 | 文件 | 职责 |
|---|---|---|
| ① 注入 UI | `oc-mic.js` | 注入渲染页面：麦克风按钮、录音、本地编码 16kHz WAV、写入输入框 |
| ② 补丁器 | `patch-oc-mic.js` | 修改 `app.asar`：主进程加麦克风权限 + IPC 转写接口 + 注入脚本 |
| ③ 识别服务 | `stt_server.py` | 本地 HTTP 服务（127.0.0.1:47832），faster-whisper 推理 |

```
┌──────────┐   MediaRecorder→WAV   ┌─────────────┐   IPC    ┌──────────────────┐
│ 🎤 按钮   │ ────────────────────► │ preload 桥   │ ───────► │ 主进程补丁        │
│ (注入脚本)│                       │ (ocMic)     │          │ 按需拉起识别服务   │
└──────────┘                       └─────────────┘          └────────┬─────────┘
                                                                    │ HTTP
                                                           ┌────────▼─────────┐
                                                           │ stt_server.py     │
                                                           │ faster-whisper    │
                                                           │ 127.0.0.1:47832   │
                                                           └───────────────────┘
```

### 设计原则

- **本地优先**：识别模型、服务、录音全部本机闭环，没有云端依赖
- **最小入侵**：只动 `app.asar` 里的三个注入点（主进程 / preload / 入口 HTML）+ 一个本地 Python 服务
- **失败即中止**：补丁器对打好的包做**全量文件哈希校验**（6950+ 个文件），任何一步对不上就直接退出，**不会把应用改坏**
- **永远能回滚**：首次打补丁自动保存官方原版，`restore` 脚本一键还原

---

## 支持的平台

| 能力 | Windows | macOS |
|---|---|---|
| 麦克风按钮（工具栏注入） | ✅ | ✅ |
| 本地识别 | ✅ CUDA 优先 / CPU 回退 | ✅ CPU（M 系列很快） |
| 一键安装 | `windows/install.ps1` | `macos/install.sh` |
| 一键还原官方 | `restore-oc-mic.cmd` | `restore-oc-mic.sh` |
| 应用更新后恢复 | ✅ 重跑 apply | ✅ 重跑 apply（自动重签名） |
| 平台特殊处理 | 麦克风权限已内置于补丁 | Info.plist 权限声明 + ad-hoc 重签名 + asar 完整性 fuse 检查 |

---

## 快速开始

### 🪟 Windows

依赖：Python 3.10+、Node.js LTS

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

<details>
<summary>可选参数与它会做什么？（点击展开）</summary>

可选参数：

```powershell
-Model medium|small      # 低配/小显存换小模型（默认 large-v3-turbo ≈1.6GB）
-Cpu                     # 不用 GPU，强制 CPU
-SkipDeps / -SkipModel   # 已装过则跳过
-NoApply                 # 只装识别服务，不打补丁
```

它会做什么：

1. 检查 Python / Node 环境
2. 创建虚拟环境并安装 faster-whisper（GPU 模式附带 CUDA 运行库）
3. 从 hf-mirror 下载 Whisper 模型（自动续传）
4. 部署本地识别服务 `~/.config/opencode/whisper/`
5. 生成并应用 app.asar 补丁（自动关闭 → 替换 → 重启 OpenCode）

</details>

### 🍎 macOS

依赖：`python3`、`node`（`brew install node`）

```bash
cd macos
chmod +x *.sh
./install.sh
```

<details>
<summary>可选参数？（点击展开）</summary>

```bash
./install.sh --model medium      # Intel Mac 建议换 medium / small
./install.sh --pypi <index-url>  # 默认清华镜像，海外可传官方源
./install.sh --no-apply          # 只装识别服务，不打补丁
```

macOS 版会自动：往 Info.plist 加麦克风权限声明 → 检查并关闭 asar 完整性 fuse（如启用）→ ad-hoc 重签名（不做会报"已损坏"）→ 重启。

</details>

首次点击麦克风时，按系统提示允许麦克风权限即可（macOS：系统设置 → 隐私与安全性 → 麦克风）。

---

## 日常使用

| 场景 | Windows | macOS |
|---|---|---|
| 改了 `oc-mic.js` 后应用 | 双击 `apply-oc-mic.cmd` | `./apply-oc-mic.sh` |
| 还原官方原版 | 双击 `restore-oc-mic.cmd` | `./restore-oc-mic.sh` |
| **OpenCode 更新后** | 重新 `apply-oc-mic.cmd` | 重新 `./apply-oc-mic.sh` |

> OpenCode 桌面版更新会覆盖 `app.asar`（补丁丢失），重跑一次 apply 即可，不需要重装。
> 若大版本升级导致注入点变化，补丁器会**校验失败并中止**，不会破坏安装。

---

## 配置（环境变量，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_STT_LOCAL_PORT` | 47832 | 本地识别服务端口 |
| `OPENCODE_STT_DEVICE` | auto | `auto` / `cuda` / `cpu` |
| `OPENCODE_STT_THREADS` | 16 (Win) / 8 (mac) | CPU 线程数 |
| `OPENCODE_WHISPER_MODEL_DIR` | `~/.config/opencode/whisper-models/large-v3-turbo` | 模型目录 |
| `OPENCODE_WHISPER_IDLE_SEC` | 1800 | 服务空闲自动退出秒数 |
| `OPENCODE_APP_PATH`（macOS） | `/Applications/OpenCode.app` | 应用位置 |

---

## 安全性

| 措施 | 说明 |
|---|---|
| 🔒 **音频不出本机** | 录音只在本机内存与本地服务之间流转，没有任何网络上传 |
| 📦 **改动范围可控** | 只动 `app.asar` 的三个注入点 + 一个本地 Python 服务，不碰系统 |
| ✅ **全量校验** | 补丁器对生成结果做 6950+ 文件的哈希校验，异常即中止、不落盘 |
| 💾 **默认备份** | 首次打补丁自动保存原版 app.asar（macOS 另存 Info.plist） |
| 🧯 **一键回滚** | `restore` 脚本随时还原官方应用 |
| 👀 **完全开源** | 所有代码可审查，识别模型来自公开仓库 |

> ⚠️ **非官方补丁提醒**：本项目通过修改 OpenCode Desktop 的安装文件（`app.asar`）实现，属于非官方方案，仅供个人学习与效率使用。请自行评估风险；OpenCode 大版本升级后可能需要等待适配。

---

## 卸载

1. 还原官方版：Windows `restore-oc-mic.cmd` / macOS `./restore-oc-mic.sh`
2. 可选删除数据（释放空间）：
   ```
   ~/.config/opencode/whisper-venv      # Python 环境
   ~/.config/opencode/whisper-models    # 模型（≈1.6GB）
   ~/.config/opencode/whisper           # 识别服务与日志
   ```

---

## 常见问题

- **按钮没出现** → 查看调试日志：Windows `%TEMP%\oc-mic-debug.log`、macOS `$TMPDIR/oc-mic-debug.log`（记录渲染层日志与页面 URL，提 Issue 时附上即可）
- **识别慢** → 看 `~/.config/opencode/whisper/stt_server.log`：显示 `device=cuda` 为最佳状态；显示 `cpu` 说明显卡库缺失（功能正常，只是慢一点）；macOS 走 CPU 属正常
- **macOS 提示"已损坏"** → 脚本已自动处理；若仍报错执行 `sudo xattr -dr com.apple.quarantine /Applications/OpenCode.app` 后重开
- **模型多大** → large-v3-turbo ≈ 1.54GB，显存/内存占用 ≈2GB；RTX 4060 上 10 秒语音约 0.5~2 秒出结果
- **日志里一堆 `ResizeObserver` 警告** → OpenCode 自身噪音，可忽略
- **支持 TUI / CLI 版吗** → 目前只做桌面版（TUI 生态已有成熟语音插件）。`extras/voice-input.ts` 里保留了插件版实现供参考

---

## 贡献

欢迎 Issue 与 PR！

- 开发与 PR 流程：见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：见 [SECURITY.md](SECURITY.md)
- 版本历史：见 [CHANGELOG.md](CHANGELOG.md)
- 让 AI Agent 代劳安装：见 [docs/install.md](docs/install.md)

---

## ⭐ 为什么值得 Star

这个项目我自己每天在用，所以我会一直维护它。

- OpenCode 每次更新覆盖补丁 → 我会跟进验证 apply 脚本
- 新的平台（Linux 桌面版）、更好的模型 → 会陆续加
- 遇到问题欢迎提 [Issue](https://github.com/ForrestKang/opencode-local-voice/issues)，附上调试日志，我尽力解决

点个 Star，下次 OpenCode 更新时能找到它。⭐

---

## 致谢

[OpenCode](https://opencode.ai) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [CTranslate2](https://github.com/OpenNMT/CTranslate2) · [whisper.cpp 模型生态](https://github.com/ggml-org/whisper.cpp) · [hf-mirror](https://hf-mirror.com)

## License

[MIT](LICENSE)
