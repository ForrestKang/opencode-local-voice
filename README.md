# OpenCode Local Voice V0.2.0

[English](docs/README_en.md) · [安装](docs/install.md) · [恢复](docs/recovery-v0.2.0.md) · [测试](docs/testing-v0.2.0.md)

如果你希望在 OpenCode 中直接口述，OpenCode Local Voice 会在本机录音、转写，并把文字放入当前草稿。你可以检查、修改后再发送；功能不会代替 OpenCode 的发送操作。识别服务只连接本机，安装依赖和模型时可能需要网络。

## 当前状态

对外编号统一为 **V0.2.0**。当前材料是经过仓库审计和自动验证的发布候选；Git tag、GitHub Release 和真实设备验收单独记录。此前出现的 `0.2.x`、`0.3.x` 只表示内部开发历史。

已记录的一次 Windows 实机更新为 OpenCode **1.18.34 → 1.18.35**。更新后回读到 V0.2.0 的脚本加载、工具栏挂载、录音开始和结果写入当前草稿；这次记录不评估识别准确率、延迟、未来版本、管理员安装器或其他机器。完整脱敏回读见 [Windows 更新实机记录](docs/windows-update-observed-v0.2.0.md) 和 [验证结果摘要](docs/validation-results-v0.2.0.json)。

本次仓库审计的最终指标记录在 [V0.2.0 仓库审计报告](docs/repository-audit-v0.2.0.md)。[测试与证据说明](docs/testing-v0.2.0.md) 给出本轮指标与执行方法，历史候选证据另行标注。

## 你会得到什么

- OpenCode 原生设置中提供“语音输入”页；它使用宿主设置的标签、主题、滚动和键盘布局，不创建独立网站或脱离宿主的设置页。
- 可选的原生设置隔离预览见 [`docs/previews/native-settings-v2-light.png`](docs/previews/native-settings-v2-light.png)；预览只展示布局，不是实机验收证据。
- 麦克风按钮开始 requesting/recording 流程，结果写入当前草稿，不自动发送。
- `×` 或 Esc 可取消 requesting、recording、busy；录音中的 STOP 方块或 Enter 结束录音并进入转写。
- 普通 Space 保持宿主原来的输入行为；IME 组合输入和带修饰键的快捷键不由语音功能抢占。
- 没有“强杀 OpenCode”按钮。正常 `close`、Electron `destroyed` 和 `will-quit` 回调只能覆盖正常退出路径；任务管理器结束进程、硬退出或断电不会执行 JavaScript 退出钩子，因此不能承诺立即取消、释放所有音轨或恢复尚未提交的录音/草稿。

取消只影响当前窗口和当前任务；必要时只终止该任务拥有的识别 worker。服务有活动任务时拒绝静默 shutdown；服务超时回收属于异常清理，不能当作硬退出后的即时恢复保证。

## 快速开始

先安装 Python 3.10+、Node.js 20+。CLI/TUI 的录音还需要 FFmpeg。安装或应用补丁前保存工作并正常退出 OpenCode；脚本不会强制结束用户应用。

- Windows：查看 [安装说明](docs/install.md) 中的 `install.ps1`、候选 DryRun 和受管维护入口。
- macOS：使用 `macos/install.sh` 和 `macos/apply-oc-mic.sh`；更新官方 `.app` 后需重新 apply。
- Linux：仅对明确指定、可写的解包 Electron 目录提供应用补丁；服务安装仍使用 `linux/install.sh`。
- 回退和恢复：先读 [恢复说明](docs/recovery-v0.2.0.md)，再执行匹配版本和哈希的 DryRun。
- 真实设备验收：按 [真实环境验收清单](docs/manual-validation.md) 逐项记录 `PASS / FAIL / 未测`。

常用 Windows 命令（在仓库根目录执行）：

```powershell
# 安装依赖、模型和服务，并应用桌面补丁
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1

# 只安装服务，供 Web/TUI/CLI 使用
powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -NoApply

# 只生成候选并验证，不替换应用或配置
powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun
```

只读检查通过且 OpenCode 已退出后，才运行 `.\windows\install-feature-preview.cmd`。已接管的安装使用 `.\windows\Restore-Voice.cmd -DryRun` 先检查，再按 [恢复说明](docs/recovery-v0.2.0.md) 执行恢复。

TUI 可选插件是 `extras/voice-input.ts`，使用 OpenCode plugin 机制加载后提供 `voice_input` 工具。`action=record` 录音并追加草稿，`status`/`on`/`off`/`toggle` 只读或改变开关；录音需要 FFmpeg，工具不自动发送。

## 接入方式和平台边界

| 接入方式 | 支持范围 | 主要边界 |
| --- | --- | --- |
| Windows Desktop | 已知 Electron/ASAR 布局、用户级安装 | 未知布局、管理员更新和跨版本事务拒绝操作；直接运行 `OpenCode.exe` 可能绕过维护入口 |
| macOS Desktop | 完整 `.app` 备份、候选 apply/restore | 真实 Mac 权限、Metal、签名、公证、Gatekeeper、官方更新和麦克风仍需实机验收；官方更新后要重新 apply |
| Linux Desktop | 明确指定的可写解包目录 | 商店包、Tauri 包和不可写/未识别布局不在范围内 |
| Web | 精确 Origin 的本机 userscript | 个人脚本含本机凭据，只留在本机；它不修改 Web 服务前端 |
| TUI / CLI | 共享本地服务 | 不自动发送；CLI 录音依赖 FFmpeg |

Windows 的一次真实更新记录不能外推为 macOS 或 Linux 的真实更新能力。Mac 当前仍只有 Windows Git Bash 模拟，不能写成真实 Mac 通过。

## 更新、恢复和隐私

Windows 维护入口按应用版本、ASAR 哈希和事务清单选择备份；未知原生结构、管理员路径、服务忙或哈希不匹配时拒绝覆盖。不要用旧 ASAR 跨 OpenCode 版本覆盖新应用。Windows 的应用恢复（feature restore）会恢复事务快照范围内的配置和后台文件，可能覆盖安装后后来修改的设置；恢复前先把这些变化另存，恢复后再合并。应用恢复不等于删除模型、聊天、工作区、venv 或服务凭据。

macOS 以完整 `.app` 为备份和恢复单位。如果原包的 Electron embedded ASAR integrity fuse 已启用，apply 只会在候选 `.app` 上关闭该 fuse 并进行 ad-hoc 签名；这会降低候选包的宿主 ASAR 完整性强制检查，原始完整 `.app` 和 fuse 状态保留用于恢复。它不能替代 Developer ID、公证、Gatekeeper 或真实系统验收。

不要提交 token、个人 Web 配对脚本、录音、业务转写、未脱敏路径或配置。安全边界和报告方式见 [SECURITY.md](SECURITY.md)。

## 测试导航

- [测试与证据说明](docs/testing-v0.2.0.md)：本轮测试指标、执行条件和证据模板。
- [Windows bug、修法和边界](docs/windows-bugs-v0.2.0.md)：Electron `app.asar` 误判、取消竞态、输入按键和服务生命周期。
- [更新生存说明](docs/update-survival.md)：一次官方更新后的交接、启动和恢复边界。
- [推送前审计清单](docs/review-before-push-v0.2.0.md)：发布候选范围、证据和未覆盖项；不把本机状态写成 GitHub Release。
- [贡献与验证](CONTRIBUTING.md)：目录职责、测试命令和脱敏要求。

[MIT License](LICENSE) · [OpenCode](https://opencode.ai) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
