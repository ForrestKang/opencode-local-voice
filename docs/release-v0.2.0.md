# OpenCode Local Voice V0.2.0 发布说明

## 当前状态

V0.2.0 当前是**发布候选**。仓库文档、候选包、Git 推送、Git tag、GitHub Release 和用户本机安装是独立状态；本文不声称已经创建 tag、GitHub Release 或完成所有平台真实验收。

对外编号只写 **V0.2.0**。历史 `0.2.x`、`0.3.x` 只表示内部开发、修复和更新生存实验，不是旧的公开发行号。

一次 Windows 实机已观察到 OpenCode **1.18.34 → 1.18.35** 官方更新：helper ready/交接、安装器进程、同版本恢复、维护检查、V0.2.0 启动、工具栏挂载、录音开始和草稿插入均有回读。该记录不评估转写准确率、冷/热延迟、未来版本、管理员安装器或其他机器，见 [Windows 更新实机记录](windows-update-observed-v0.2.0.md)。

本次仓库审计的最终范围和指标由 [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md) 维护；上一候选测试基线见 [testing-v0.2.0.md](testing-v0.2.0.md)。

## 功能范围

- 本地录音、转写和当前草稿写入，用户检查后自行发送。
- OpenCode 原生设置中的“语音输入”页，沿用宿主设置布局、主题、滚动和键盘行为。
- Web、TUI、CLI 通过同一本地服务接入；Web userscript 只在本机生成，不改 Web 前端。
- Windows 已知 Electron/ASAR 布局的候选补丁、维护入口、版本/哈希匹配恢复。
- macOS 完整 `.app` 备份、候选 apply/restore 和权限说明；官方更新后手动重新 apply。
- Linux 明确指定的可写解包 Electron 目录和共享服务。

输入条契约为：`×`/Esc 取消 requesting、recording、busy；录音中的 STOP/Enter 结束并转写；普通 Space 保持宿主行为；结果不自动发送。没有强杀 OpenCode 按钮。硬退出、任务管理器结束进程或断电无法运行 JavaScript 退出钩子，不能承诺即时取消或恢复未提交录音/草稿。

## 平台状态和边界

| 平台/路径 | 当前说明 | 未覆盖内容 |
| --- | --- | --- |
| Windows Desktop | 有一次 1.18.34 → 1.18.35 实机更新记录；候选维护/恢复和独立 Electron runtime 另有证据 | 未来版本、管理员 installer、所有机器、准确率和延迟 |
| macOS Desktop | 脚本可生成候选并做完整 `.app` 备份；17 项是 Windows Git Bash 模拟 | 真实 Mac runtime、麦克风、权限、Metal、签名、公证、Gatekeeper 和官方更新 |
| Linux Desktop | 支持明确可写的解包目录 | 商店包、Tauri 包和未知布局 |
| Web/TUI/CLI | 共享 loopback 服务和 CLI 参数 | Web 个人凭据保护依赖用户本机；CLI 不发送 OpenCode 草稿 |

macOS 候选可能需要修改候选 bundle 的 embedded ASAR integrity fuse；这会改变候选包的宿主防篡改校验，完整原包仍用于恢复。它不能写成系统安全、Developer ID、公证或 Gatekeeper 验收。

## 已知 Windows bug 与修复范围

修复前真实 1.18.34 窗口中的 `updater-install` 连点三次会提示 `current app.asar is missing`，物理文件和源 SHA256 仍存在且正常。触发根因是 Electron 桥使用的 `node:fs` 探测在 ASAR 运行时中被重写，`lstat`/`isFile` 错把文件判为缺失；Node helper、ASAR 模拟和普通启动没有覆盖完整 Electron 点击链路。

修复契约是 Electron bridge 使用 `original-fs`，Node helper 保持 `node:fs`，不进行全局 `process.noAsar` 切换；成功显示 prepare 故障提示的路径使用中文 UI、保留英文 main 日志，并验证无 Unhandled rejection。独立 Windows Electron 44.6.0 runtime 的故障重试与恢复 fixture 单列，真实用户更新仍是一次点击后等待安装器，不要求连续点击三次。详情见 [windows-bugs-v0.2.0.md](windows-bugs-v0.2.0.md)。

## 恢复边界

Windows feature restore 会覆盖事务快照范围内后来修改的配置和后台文件；用户必须先另存后来设置、词表和凭据密文，恢复后再合并。版本、路径、ASAR 哈希、manifest 或维护事务不匹配时拒绝恢复。不要用历史 ASAR 跨 OpenCode 版本覆盖新包，也不要把应用恢复当成删除模型、聊天、工作区、venv 或凭据。可执行命令见 [recovery-v0.2.0.md](recovery-v0.2.0.md)。

## 发布前材料清单

- [x] 根目录版本元数据、候选包和 SHA256 清单与 V0.2.0 一致。
- [x] `npm run check:docs` 通过；`npm run package` 已生成四个平台候选并由 `verify-release` 校验覆盖、哈希、版本和入口。
- [x] [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md) 写明本次审计命令、环境、指标和未测边界。
- [x] 自动测试基线和本次审计重跑分开，未把 106/57/29/24/13/17 的上一候选数字冒充新结果。
- [x] Windows 实机更新、安装/恢复、真实麦克风和官方 installer 分别记录。
- [x] Mac 17 项模拟与真实 Mac `.app`、权限、签名、公证、Metal、麦克风和官方更新分开记录。
- [x] 文档、候选包和日志未包含 token、个人路径、配置、录音或业务转写。
- [x] 推送、tag、GitHub Release 和用户本机安装状态分别记录，未把其中一项写成另一项。

## 相关文档

- [安装说明](install.md)
- [真实环境验收](manual-validation.md)
- [测试与证据说明](testing-v0.2.0.md)
- [更新生存说明](update-survival.md)
- [恢复说明](recovery-v0.2.0.md)
- [Windows bug、修法和边界](windows-bugs-v0.2.0.md)
- [推送前审计清单](review-before-push-v0.2.0.md)
