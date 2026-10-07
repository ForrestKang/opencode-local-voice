# V0.2.0 真实环境验收清单

这是给真实 Windows/macOS 设备使用的逐项清单。合成音频、隔离服务、替身应用、ASAR 模拟、独立 Electron runtime 和上一候选自动测试不能推导真实麦克风、口音、模型速度、外部 AI、官方 installer、签名、公证、Metal 或系统权限通过。

结果只写 `PASS / FAIL / 未测`，并附版本、时间、脱敏日志或截图索引。不要把上一候选数字直接填成本次审计结果；本次汇总见 [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md)。

## 环境记录

```text
版本：V0.2.0
平台 / 系统 / 架构：
OpenCode 版本与发行格式：
Electron 版本（如可得）：
Python / Node / FFmpeg：
CPU / 内存 / GPU / 驱动：
backend / device / model：
麦克风和驱动：
候选/源 SHA256（如适用）：
是否已脱敏：是 / 否
```

不要记录 token、API 密钥正文、个人 Web 配对脚本、原始录音、业务转写或个人绝对路径。

## Windows 安装和启动

- [ ] 保存工作并正常退出 OpenCode。
- [ ] `powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun` 通过，原 app.asar、配置和快捷方式未被修改。
- [ ] 记录源/候选 SHA256、OpenCode 版本和 feature/maintenance transaction（脱敏）。
- [ ] 执行 `.\windows\install-feature-preview.cmd` 后，从受维护桌面/开始菜单/任务栏入口启动。
- [ ] 窗口响应，原生设置中的“语音输入”与宿主设置同级；主题、窄窗口、滚动和键盘焦点正常。
- [ ] 没有新的终端或 Python 控制台窗口；`Repair-Voice.cmd -Check` 的只读结果已记录（如安装提供该入口）。
- [ ] 直接运行 `OpenCode.exe` 的绕过行为已作为边界记录，不当作维护入口通过。

## Windows 录音、取消和服务

- [ ] 点击麦克风后，requesting、recording、busy 状态有清晰变化。
- [ ] requesting 点击 `×`，权限迟到时也回到 idle，不残留音轨或 spinner。
- [ ] recording 点击 STOP 或按 Enter，只停止录音并进入转写；结果写入当前草稿，不自动发送。
- [ ] recording 点击 `×` 或按 Esc，音轨停止、草稿不改变。
- [ ] busy 点击 `×` 或按 Esc，任务取消，迟到结果不写入草稿。
- [ ] 普通 Space、IME 组合输入、Shift/Ctrl/Alt/Meta 组合和宿主发送按钮保持原行为。
- [ ] 录音期间 pagehide 后音轨释放并保留草稿；转写期间 pagehide 后取消任务并拒绝迟到结果。
- [ ] 不同窗口任务互不取消；取消必要时只终止本任务的识别 worker。
- [ ] 服务有活动任务时 shutdown 被拒绝；显式取消或任务完成后可正常关闭并再次启动。
- [ ] 服务已经消失时取消不会 ensure、restart 或启动真实 Python/server；诊断和清理结果已记录。
- [ ] 产品没有强杀 OpenCode 按钮。正常 `close`/Electron `destroyed`/`will-quit` 只覆盖正常退出；硬退出、任务管理器结束进程或断电不能执行 JavaScript 退出钩子，不能承诺立即取消或恢复未提交录音/草稿。

## Windows updater-install 与恢复

历史真实故障是修复前 1.18.34 窗口连续点击三次 `updater-install` 后提示 `current app.asar is missing`，但物理 `app.asar` 和 SHA256 正常。它只作为历史复现记录；真实验收点击一次执行更新即可。准备失败时可以按提示重试，并记录每次次数、错误文本、native ready、helper/installer 状态；成功后等待安装器退出和恢复。

- [ ] 真实一次更新前回读物理 `resources\app.asar` 存在性和 SHA256。
- [ ] 更新后回读目标 OpenCode 版本、官方新包哈希、补丁包哈希、维护检查和启动日志。
- [ ] 更新后 V0.2.0 脚本加载、工具栏挂载、录音开始和草稿插入均有脱敏证据；准确率/延迟另行记录。
- [ ] 独立 Windows Electron 44.6.0 runtime 的三次故障重试单列为隔离证据，不写成真实 installer 通过。
- [ ] 已成功显示 prepare 故障提示的路径无 Unhandled rejection；原始英文诊断可留在 main 日志，用户界面使用中文。未显示或意外异常继续记录为未通过，不能静默吞掉拒绝。
- [ ] 真实恢复前已另存安装后后来修改的设置、词表和凭据密文。
- [ ] `.\windows\Restore-Voice.cmd -DryRun` 找到当前版本/ASAR 哈希匹配事务后，才执行 `.\windows\Restore-Voice.cmd`。
- [ ] 版本、哈希、应用路径或 manifest 不匹配时明确拒绝，并保留当前官方包。

一次 Windows 1.18.34 → 1.18.35 更新已记录在 [windows-update-observed-v0.2.0.md](windows-update-observed-v0.2.0.md)；它不代表所有机器或未来更新均通过。

## macOS

- [ ] 使用真实 Mac 的完整 `.app`，先运行 `bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run`。
- [ ] 记录完整 bundle、app.asar、Info.plist、扩展属性/ACL 和候选哈希。
- [ ] 关闭 OpenCode 后 apply；启动真实 Mac 应用并记录 bundle 权限、麦克风允许/拒绝/重新允许。
- [ ] 真实麦克风下测试 STOP、Enter、Esc、`×`、普通 Space、草稿和重试。
- [ ] Apple Silicon 的 MLX/Metal 或 Intel CPU 路径有实际加载/转写证据。
- [ ] 若原包启用 Electron embedded ASAR integrity，候选 apply 对候选包的 fuse 状态变化已记录；这不是系统安全验收，完整原包可用于恢复。
- [ ] 候选 ad-hoc 签名与 Developer ID、公证、Gatekeeper 分开记录。参考 [Apple Developer ID](https://developer.apple.com/developer-id/)、[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) 和 [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)。
- [ ] 官方更新替换 `.app` 后重新 apply；不要把 Windows 自动更新恢复能力外推到 Mac。
- [ ] 退出 OpenCode 后先 `bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app --dry-run`，确认匹配完整包备份，再执行恢复。

当前仓库仅有 Windows Git Bash 的 Mac 17 项模拟；模拟结果不能填写到上述真实 Mac 项。

## 证据填写模板

```text
V0.2.0 平台 / 系统 / 架构：
OpenCode / Electron 版本：
源 ASAR / 候选 ASAR 或完整 bundle SHA256：
安装/维护入口与 transaction（脱敏）：
测试项：启动 / 无终端 / 设置 / STOP-Enter / Esc-× / Space / busy shutdown / restore / update
结果：PASS / FAIL / 未测
updater-install 点击次数与每次状态：
物理 app.asar 存在性和哈希回读：
真实麦克风/系统权限：
签名/公证/Metal（如适用）：
证据索引：
根因和修法证据类型：自动 / 隔离 UI / 实机启动 / 真实 installer / 其他
未覆盖边界：
```
