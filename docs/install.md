# 安装指南

默认安装采用**按平台差异化零下载策略**：仅创建极简 Python 标准库虚拟环境（`--without-pip`，不安装 PyTorch / `faster-whisper` / `mlx-whisper` 等重型依赖）并部署纯标准库本地服务；仅在显式传入 `-WithLocalModel`（Windows）或 `--with-local-model`（macOS/Linux）时才安装本地 Whisper 模型。桌面集成还会备份并修改 OpenCode 应用。开始前准备 Python 3.10+、Node.js 20+，保存工作并完全退出 OpenCode。

默认轻量化安装无需下载模型；若使用 CLI/TUI 麦克风录音仍需安装 FFmpeg，桌面与 Web 通过浏览器录音接口采集音频。

以下命令在仓库根目录运行。获取源码：

```bash
git clone https://github.com/ForrestKang/opencode-local-voice.git
cd opencode-local-voice
```

## Windows

支持用户级 Electron 安装，应用目录须包含 `resources\app.asar`。默认跳过重型依赖与模型下载；安装后在 **设置 → 语音输入** 中选择 OpenAI 兼容预设（如 Groq、硅基流动或本机局域网 Whisper 服务）并填入接口地址与 Key 即可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
```

常用选项：

```powershell
# 仅安装轻量本地服务，供 Web/TUI/CLI 使用
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -NoApply

# 按需安装完整高精度本地 Whisper 模型（faster-whisper + 模型下载）
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -WithLocalModel

# 安装本地模型时指定 CPU 和 small 模型
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -WithLocalModel -Cpu -Model small

# 自定义 OpenCode 安装目录
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -AppPath "D:\Apps\OpenCode"
```

仅在启用 `-WithLocalModel` 时才会下载模型，模型可选 `auto`、`large-v3-turbo`、`medium`、`small`。已有本地环境时可使用 `-SkipDeps`、`-SkipModel` 复用依赖和模型。

安装完成后，从桌面或开始菜单中维护后的 OpenCode 快捷方式启动，进入 **设置 → 语音输入**。维护入口会在启动前检查插件；直接运行 `OpenCode.exe` 可能绕过此检查。更新后的处理见 [更新指南](update-survival.md)。

### 更新已有插件

本地服务已安装时，可以只应用新的桌面补丁。先生成候选并检查兼容性：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun
```

检查通过并完全退出 OpenCode 后安装：

```powershell
.\windows\install-feature-preview.cmd
```

自定义应用目录可通过 `install-feature-preview.ps1 -AppPath "D:\Apps\OpenCode"` 指定。备份由安装器管理，恢复命令见 [恢复指南](recovery-v0.2.0.md)。

## macOS

桌面适配为实验性，支持包含 `Contents/Resources/app.asar` 的完整 Electron `.app`。默认自动编译系统原生 `oc_apple_speech` 辅助程序（基于 macOS Speech / `SFSpeechRecognizer`，优先端侧识别）并创建极简 Python 环境，零 pip 包、零模型下载：

```bash
bash macos/install.sh --app /Applications/OpenCode.app
```

只安装服务时：

```bash
bash macos/install.sh --no-apply
```

如需加装本地 Whisper 模型（Apple Silicon 使用 MLX，Intel Mac 使用 faster-whisper CPU），可传入 `--with-local-model`：

```bash
bash macos/install.sh --with-local-model --app /Applications/OpenCode.app
```

已有运行环境时，可先检查再应用桌面补丁：

```bash
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app
```

脚本会保留完整 `.app` 备份，并对候选应用进行 ad-hoc 签名。如果原包启用了 Electron 的 ASAR 完整性验证 fuse，候选包会关闭该验证。这会改变应用的信任与完整性保护，ad-hoc 签名也不等同于官方签名或公证；请在了解这些影响后使用桌面补丁。

首次录音时允许系统麦克风与语音识别权限；若被拒绝，请在系统的隐私与安全性设置中调整。官方更新替换 `.app` 后，需要重新应用兼容补丁。完整应用恢复见 [恢复指南](recovery-v0.2.0.md#macos)。

## Linux

默认只安装零下载轻量本地服务（创建 `--without-pip` 标准库环境，不下载模型）：

```bash
bash linux/install.sh
```

桌面集成需要指定可写的 Electron 解包目录：

```bash
bash linux/install.sh --apply --app /path/to/unpacked/OpenCode
```

如需同时安装本地 `faster-whisper` 与模型，传入 `--with-local-model`：

```bash
bash linux/install.sh --with-local-model --model small
```

已有服务时，可用 `bash linux/apply-oc-mic.sh --app /path/to/unpacked/OpenCode` 应用补丁。不可写目录、商店包、Tauri 包和未知布局不支持桌面补丁。

macOS/Linux 的安装器均接受 `--with-local-model`、`--model auto|large-v3-turbo|medium|small`、`--pypi URL`、`--skip-deps` 和 `--skip-model`；其中 `--model` 仅在 `--with-local-model` 时生效。Linux 的 `--apply` 需要同时提供 `--app`。

## Web

先安装本地服务，然后使用安装器创建的 Python 环境生成个人 userscript。`--origin` 填写实际 OpenCode Web 的协议、主机和端口，不带页面路径。

Windows：

```powershell
$VoicePython = Join-Path $env:USERPROFILE '.config\opencode\whisper-venv\Scripts\python.exe'
& $VoicePython tools/make-web-script.py --origin http://localhost:4096
```

macOS/Linux：

```bash
VOICE_PYTHON="$HOME/.config/opencode/whisper-venv/bin/python"
"$VOICE_PYTHON" tools/make-web-script.py --origin http://localhost:4096
```

把输出路径中的 `.personal.user.js` 导入浏览器的 userscript 管理器，刷新 OpenCode Web。浏览器需要允许麦克风访问；本机 `localhost` 或 HTTPS 页面可用于录音。

该脚本含本机服务的访问凭据，只用于当前机器。更换 Web Origin 或重置凭据后，请重新生成；不要把个人脚本上传或分享。

## TUI

将 `extras/voice-input.ts` 复制到以下任一目录；目标文件已存在时先备份，再合并改动：

| 范围 | 目标路径 |
| --- | --- |
| 当前项目 | `<项目目录>/.opencode/plugins/voice-input.ts` |
| 用户全局 | `~/.config/opencode/plugins/voice-input.ts` |

重启 OpenCode 后，插件提供 `voice_input` 工具。`action=record` 录音并追加草稿，`seconds` 指定时长，`mic` 指定设备；`status`、`on`、`off`、`toggle` 用于查询或切换状态。录音需要 FFmpeg，结果由用户自行发送。插件加载方式见 [OpenCode Plugins](https://opencode.ai/docs/plugins/)。

## CLI

CLI 支持音频文件和麦克风录音。使用前面的 `VoicePython` / `VOICE_PYTHON`，确保解释器包含识别依赖。

Windows：

```powershell
& $VoicePython shared/voice_cli.py --file sample.wav
& $VoicePython shared/voice_cli.py --record --mic "麦克风名称或索引" --duration 10
& $VoicePython shared/voice_cli.py --serve
```

macOS/Linux：

```bash
"$VOICE_PYTHON" shared/voice_cli.py --file sample.wav
"$VOICE_PYTHON" shared/voice_cli.py --record --mic 0 --duration 10
"$VOICE_PYTHON" shared/voice_cli.py --serve
```

`--serve` 显式启动本地服务，与 `--file`、`--record` 互斥。更多选项可通过 `shared/voice_cli.py --help` 查看。

## 文件位置

默认均在当前用户的 `~/.config/opencode/` 下；Windows 对应 `%USERPROFILE%\.config\opencode\`。

| 目录 | 内容 |
| --- | --- |
| `local-voice/` | 语音配置、凭据和识别模型 |
| `whisper-venv/` | 独立 Python 环境 |
| `whisper/` | 部署后的识别服务与客户端 |
| `voice-maintenance/` | Windows 维护入口、插件缓存与备份 |

麦克风、语言、词表与文本处理选项见 [设置指南](configuration.md)。安装报错时，请保留错误信息，并在 [Issues](https://github.com/ForrestKang/opencode-local-voice/issues) 中提供操作系统、OpenCode 版本和安装方式。
