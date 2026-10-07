# V0.2.0 推送前审计清单

本文记录 V0.2.0 候选在推送前的范围、证据和未覆盖边界。它不把本机安装、候选包、Git push、tag 或 GitHub Release 混为一件事，也不把历史测试数字写成当前审计结果。对外编号统一为 **V0.2.0**；`0.2.x`、`0.3.x` 只表示内部历史。

本次审计的最终命令、环境、指标和文件哈希记录在 [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md)。本文件的清单用于整理发布材料和实际推送状态。

## 改动范围

- 本地 loopback 语音服务、模型配置、FFmpeg 文件/麦克风客户端。
- OpenCode 原生设置中的语音输入页，以及共享录音、取消、按键和草稿写入。
- Windows 已知 Electron/ASAR 布局的候选补丁、维护入口、更新交接和匹配事务恢复。
- macOS 完整 `.app` 候选 apply/restore 与签名、fuse、权限边界说明。
- Web userscript、TUI 工具和 CLI 共享本地服务。

本文件不扩展未知 Electron 布局、管理员安装器、未来 OpenCode 版本、远程麦克风、系统强杀恢复或全平台自动更新。

## 本轮验证

| 项目 | 本轮结果 | 范围 |
| --- | --- | --- |
| Node 全量 | 118/118，0 fail / 0 skip | 客户端、补丁、事务、helper 和 Windows 隔离 fixture |
| Python | 62/62 | 服务、配置、CLI、文字处理和打包回归 |
| 语音 UI | 29/29 | 合成音频，不是真实麦克风 |
| 原生设置 UI | 26/26 | 只读 1.18.35 ASAR，在隔离宿主运行原生组件 |
| Windows Electron runtime | 13/13 | 独立 Electron 44.6.0，不是官方 installer |
| Mac 模拟 | 17/17 | Windows Git Bash；包含在 Node 套件中 |

原始日志留在本地 `test-results/`，命令和源码哈希见 [审计 JSON](repository-audit-results-v0.2.0.json)。上一候选 106/57/29/24/13/17 单独保存在 [历史 JSON](validation-results-v0.2.0.json)。本轮没有重新安装用户应用，也没有执行真实 updater、麦克风或恢复操作。

一次 Windows 实机 OpenCode **1.18.34 → 1.18.35** 官方更新另有脱敏记录，见 [windows-update-observed-v0.2.0.md](windows-update-observed-v0.2.0.md)。它是实际用户环境观察，不替代本次审计的全量指标，也不评估识别准确率和延迟。

## Windows updater bug 与隔离修复

修复前真实 1.18.34 窗口连续点击三次 `updater-install` 时出现 `current app.asar is missing`，但物理 `app.asar` 和源哈希正常。根因是 Electron bridge 里的 `node:fs` 探测被 ASAR 运行时重写；Node helper、ASAR 模拟和普通启动未覆盖完整 Electron 点击链路。

修复契约：

1. Electron bridge 使用 `original-fs` 读取物理 app.asar；Node helper 保持 `node:fs`。
2. 不做全局 `process.noAsar` 切换。
3. 已成功显示 prepare 故障提示的路径显示中文、保持 native ready，并且无 Unhandled rejection；原始英文诊断可以留在 main 日志。未显示或意外异常继续记录为未通过，不能静默吞掉拒绝。
4. 独立 Windows Electron 44.6.0 runtime 可检查 production controller 的三次故障重试、3 次中文 capture、清理和恢复 fixture retry；这与真实应用一次点击、官方 installer 和真实部署分开。

真实用户验收只点击一次执行更新；准备失败时按提示重试并记录次数、错误文本、native ready、helper/installer 状态，成功后等待安装器完成恢复。修复前连点三次只保留为历史事实。

## 取消、停止和硬退出边界

- `×`/Esc 在 requesting、recording、busy 都取消。
- STOP 方块/Enter 只在 recording 中结束并转写；普通 Space 保持宿主输入。
- 取消必要时只终止本任务拥有的识别 worker；服务 busy 时拒绝 shutdown。
- 服务消失时先写 tombstone、probe 已存在服务再 DELETE，不 ensure/restart 或启动真实 Python/server。
- 正常 `close`/Electron `destroyed`/`will-quit` 只覆盖正常退出；任务管理器结束进程、硬退出或断电无法执行 JavaScript 退出钩子，不能承诺立即取消、释放音轨或恢复未提交录音/草稿。
- 产品没有强杀 OpenCode 按钮。

## 回退和恢复禁止条件

- Windows feature restore 前必须另存安装后后来修改的设置、词表和凭据密文；恢复会覆盖事务快照范围内的配置/后台文件，完成后再合并。
- 只有当前版本、应用路径、ASAR 哈希、manifest 和事务状态全部匹配时才执行 restore。
- 看到 `current app.asar is missing` 时先回读物理文件和 SHA256；存在且正常时按 bridge 误判处理。
- 不跨 OpenCode 版本恢复，不用旧 `.original` 或历史 ASAR 直接覆盖新应用，不删除事务目录，不结束陌生/管理员进程。
- 硬退出、断电和任务管理器结束进程不作为正常回退步骤。
- 应用恢复不等于删除模型、聊天、工作区、venv 或服务凭据。

## macOS 限制

- 17 项 Mac 结果是 Windows Git Bash 模拟，不是 Mac Electron runtime 或真实 installer。
- 真实 Mac `.app`、权限、麦克风、Metal/CPU、签名、公证、Gatekeeper 和官方更新必须单独记录。
- 完整 `.app` 是备份/恢复单位；官方更新替换后需要重新 apply。
- 若原包启用 `EnableEmbeddedAsarIntegrityValidation`，候选 apply 可能把候选包该 fuse 设为 Disabled；这是候选宿主防篡改保证的变化，不是系统安全通过。原始完整包和 fuse 状态用于恢复。
- 参考 [Apple Developer ID](https://developer.apple.com/developer-id/)、[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) 和 [Electron ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)。

## 推送前发布清单

- [x] 根目录版本元数据、候选包、manifest 和 SHA256 与 V0.2.0 一致。
- [x] `npm run check:docs` 通过；`npm run package` 的 `verify-release` 已检查 source、Windows、macOS、Linux 四包覆盖、哈希、版本和平台入口。
- [x] [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md) 已填写本次审计命令、环境、结果和未测项。
- [x] 上一候选 106/57/29/24/13/17 与本次重跑值分栏，未互相冒充。
- [x] Windows 实机更新、真实麦克风、官方 installer、维护启动和 restore DryRun 分开记录。
- [x] Mac 模拟与真实 Mac `.app`、权限、签名、公证、Metal、麦克风和 updater 分开记录。
- [x] 文档/候选包排除 token、配置、个人路径、录音、业务转写和个人 userscript。
- [x] Git push、tag、GitHub Release 和本机安装状态分别写实际状态；未完成的不写成完成。

## 审计结果模板

```text
候选版本：V0.2.0
OpenCode / Electron：
源 ASAR / 候选 ASAR / 完整 bundle SHA256：
本次审计命令和环境：
Node / Python / voice UI / native UI / Electron / Mac simulation：
Windows 实机一次更新：
Windows 真实麦克风和官方 installer：
真实 Mac `.app` / 权限 / 签名 / 公证 / Metal / 麦克风：
回退/恢复 DryRun：
推送状态：
tag / GitHub Release 状态：
证据索引：
仍未覆盖：
```
