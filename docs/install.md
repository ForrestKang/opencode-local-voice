# V0.2.0 安装说明

V0.2.0 在本机运行识别服务，并把结果写入 OpenCode 当前草稿。安装前准备 Python 3.10+ 和 Node.js 20+；CLI/TUI 录音还需要 FFmpeg。保存工作并正常退出 OpenCode，应用补丁和恢复脚本都不会强制结束用户应用。

对外编号只使用 **V0.2.0**。`0.2.x`、`0.3.x` 只出现在内部历史材料中，不是旧的公开发行号。

## Windows

### 首次安装

在仓库根目录执行。默认会安装依赖、模型、服务并应用已知布局的桌面补丁：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1
```

常用选择：

```powershell
# 显式使用 CPU 和 small 模型
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -Cpu -Model small

# 只安装服务、模型和 CLI 运行环境，不改桌面 ASAR
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -NoApply

# 指定 OpenCode 桌面目录；目录应包含 resources\app.asar
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -AppPath "<OpenCode安装目录>"
```

`install.ps1` 的公开选项是 `-Model auto|large-v3-turbo|medium|small`、`-Cpu`、`-SkipDeps`、`-SkipModel`、`-NoApply`、`-DryRun`、`-AppPath` 和 `-Pypi`。`-SkipDeps` 与 `-SkipModel` 只适用于已有并且已验证的运行环境；不要用它们掩盖缺失的 venv 或模型。

### 已有安装的候选补丁

先运行只读检查。它会读取应用、生成隔离候选并验证布局；不会替换应用、配置或快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun
```

检查成功、OpenCode 已退出后应用候选：

```powershell
.\windows\install-feature-preview.cmd
```

保存输出中的 feature transaction 和 maintenance transaction。应用后从维护过的桌面、开始菜单或任务栏入口启动；直接运行 `OpenCode.exe` 可能绕过启动检查。

Windows 受管安装只接受 `AppPath\resources\app.asar`；根目录 `app.asar` 或 macOS 风格布局会在 DryRun 阶段拒绝。备份目录必须在应用、运行时和配置目录之外，并且不能经过 symlink/junction。停止服务失败时不建立有效安装事务；备份准备失败时移除不完整事务，原应用和后台文件保持原内容。

`install-feature-preview.ps1` 的公开 PowerShell 参数是 `-AppPath`、`-VoiceHome`、`-RuntimePath`、`-BackupRoot`、`-MaintenanceRoot`、`-PythonPath`、`-Transaction`、`-Restore` 和 `-DryRun`。它是 PowerShell 入口；不要把内部 Node/CJS 的 `--app`、`--input` 等参数直接拼到这个脚本上。需要指定事务时使用 `restore-feature-preview.cmd -Transaction "<事务路径>"`，见 [恢复说明](recovery-v0.2.0.md)。

如果旧版 1.18.34 窗口中的 `updater-install` 出现 `current app.asar is missing`，先保留错误和日志，回读物理 `resources\app.asar` 及脱敏 SHA256。已知 Electron 桥的 ASAR 文件探测可能误判；不要因为这条提示删除或跨版本覆盖正常文件。修复后的独立 Windows Electron 44.6.0 回归与真实用户一次更新分别记录，不能互相替代。

### Web 和 CLI（Windows）

安装器把 STT 运行时放在独立的 Python venv。Web 脚本和 CLI 必须使用这个解释器；不要直接用可能没有 STT 依赖的系统 `python` 启动服务：

```powershell
$VoicePython = Join-Path $env:USERPROFILE '.config\opencode\whisper-venv\Scripts\python.exe'

# 生成精确 Origin 的本机 Web userscript
& $VoicePython tools/make-web-script.py --origin http://localhost:4096

# 文件转写、麦克风转写或显式启动服务
& $VoicePython shared/voice_cli.py --file sample.wav
& $VoicePython shared/voice_cli.py --record --mic "输入设备名称或索引" --duration 10
& $VoicePython shared/voice_cli.py --serve
```

只有在该路径已由安装器创建并且运行时依赖已验证后才运行这些命令。`--origin` 必须是实际 OpenCode Web 的精确 HTTP(S) origin，不带路径、凭据、查询或片段。生成的 `.personal.user.js` 含本机凭据，只留在本机，不提交仓库。`voice_cli.py` 还接受 `--timeout`、`--config` 和 `--ffmpeg`；`--serve` 不能与 `--file` 或 `--record` 同时使用。

### TUI 插件

可选插件源文件是 `extras/voice-input.ts`。按 OpenCode 官方插件机制，将它复制到项目的 `.opencode/plugins/`，或用户级的 `~/.config/opencode/plugins/`，然后重启 OpenCode 让插件加载：

```text
项目：.opencode/plugins/voice-input.ts
全局：~/.config/opencode/plugins/voice-input.ts
```

例如，在项目目录安装并在覆盖前保留已有文件：

```powershell
$PluginDir = Join-Path (Get-Location) '.opencode\plugins'
New-Item -ItemType Directory -Force $PluginDir | Out-Null
$Target = Join-Path $PluginDir 'voice-input.ts'
if (Test-Path -LiteralPath $Target) { Copy-Item -LiteralPath $Target -Destination ($Target + '.bak') -Force }
Copy-Item -LiteralPath '.\extras\voice-input.ts' -Destination $Target -Force
```

macOS/Linux 可在项目根目录使用同样的目标布局：

```bash
mkdir -p .opencode/plugins
test ! -e .opencode/plugins/voice-input.ts || cp .opencode/plugins/voice-input.ts .opencode/plugins/voice-input.ts.bak
cp extras/voice-input.ts .opencode/plugins/voice-input.ts
```

目标文件已存在时先另存再合并；不要直接覆盖已有插件。若插件需要第三方依赖，按照官方配置目录中的 `package.json` 合并依赖，不替换现有配置。官方说明见 [OpenCode Plugins](https://opencode.ai/docs/plugins/)。插件提供 `voice_input` 工具：`record` 录音并追加草稿，`status`/`on`/`off`/`toggle` 不录音；`seconds` 和 `mic` 控制时长与平台输入设备。工具使用同一份本地服务配置，不自动提交草稿。

## macOS

真实 Mac 上先准备完整的 OpenCode `.app`，再执行：

```bash
# 安装服务和模型，并应用桌面候选
bash macos/install.sh

# 只安装服务，不应用桌面包
bash macos/install.sh --no-apply

# 只读生成候选，不替换应用
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run

# 关闭 OpenCode 后应用候选
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app
```

`macos/install.sh` 接受 `--model`、`--pypi`、`--app`、`--no-apply`、`--dry-run`、`--skip-deps` 和 `--skip-model`。`apply-oc-mic.sh` 接受 `--app`、`--input`、`--output`、`--backup-root` 和 `--dry-run`。应用脚本以完整 `.app` 备份，保留资源、扩展属性和 ACL，并检查 `Info.plist`、fuse 和候选签名。

候选 ad-hoc 签名不等于 Developer ID、公证或 Gatekeeper 通过。真实 Mac 的系统权限、麦克风、Metal/CPU、签名、公证和官方更新仍需按 [真实环境验收清单](manual-validation.md) 记录。官方更新替换 `.app` 后，必须重新运行兼容版本的 apply。

macOS 上的 Web/CLI 也必须使用安装器 venv（或已安装本项目 runtime requirements 的等价解释器）：

```bash
VOICE_PYTHON="$HOME/.config/opencode/whisper-venv/bin/python"
"$VOICE_PYTHON" tools/make-web-script.py --origin http://localhost:4096
"$VOICE_PYTHON" shared/voice_cli.py --file sample.wav
"$VOICE_PYTHON" shared/voice_cli.py --record --mic 0 --duration 10
```

## Linux

服务和明确的可写解包目录可以使用：

```bash
bash linux/install.sh
bash linux/install.sh --apply --app /path/to/unpacked/OpenCode
```

`linux/install.sh` 接受 `--model`、`--pypi`、`--app`、`--input`、`--apply`、`--no-apply`、`--dry-run`、`--skip-deps` 和 `--skip-model`。商店包、Tauri 包、不可写目录和未知 Electron 布局会拒绝应用补丁。

Linux 上将 `VOICE_PYTHON` 指向安装器创建的 `$HOME/.config/opencode/whisper-venv/bin/python`，或指向已安装本项目 runtime requirements 的解释器，再按上面的 Web/CLI 脚本路径运行。不要用未安装 STT 依赖的系统解释器启动服务。

## 取消、结束和异常退出

`×`/Esc 取消 requesting、recording 或 busy；STOP/Enter 只在 recording 中结束录音并转写；普通 Space 不改变宿主输入。没有强杀 OpenCode 按钮。正常窗口 `close`、Electron `destroyed` 和 `will-quit` 回调只覆盖正常退出；任务管理器结束进程、硬退出或断电不会执行 JavaScript 退出钩子，不能承诺立即取消、释放所有音轨或恢复尚未提交的录音/草稿。取消必要时只终止本任务的识别 worker，服务 busy 时拒绝 shutdown，服务超时回收仍可能清理已登记任务。

安装失败时保留终端输出、脱敏日志、候选哈希和事务路径。未知布局、管理员安装、服务身份不匹配、版本/哈希不匹配时停止，不结束陌生进程，也不要删除当前官方应用。恢复条件和禁止条件见 [recovery-v0.2.0.md](recovery-v0.2.0.md)。
