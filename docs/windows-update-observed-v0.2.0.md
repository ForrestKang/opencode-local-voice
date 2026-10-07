# V0.2.0 Windows 官方更新实机观测

2026-10-07，本机在候选安装后完成了 OpenCode **1.18.34 → 1.18.35** 的实际官方更新。更新后语音仍为 **V0.2.0**。这是用户环境的实际链路观测；助手没有调用官方安装器或操作麦克风。

| 环节 | 回读结果 |
| --- | --- |
| 更新桥准备 | 请求目标 1.18.35；存在匹配的 helper ready 和 commit 标记 |
| 官方安装器 | 记录到 1 个安装器进程，随后应用版本确认为 1.18.35 |
| 新包恢复 | 新建同版本 feature 备份，manifest 为 applied，补丁后 SHA256 与当前包一致 |
| 维护检查 | complete=true，语音功能版本 0.2.0 |
| 启动日志 | v0.2.0 script ready；mounted on prompt toolbar |
| 语音链路 | 记录到 recording started 和 transcript inserted into current draft；未读取或导出录音和转写文字 |
| 更新后恢复预检 | Restore DryRun 通过，选中 1.18.35 的匹配备份 |

新官方 1.18.35 原包 SHA256：`aaa772c154f6ca3a604052ae4a15b63303883cb9a6ee0573be0bc9acedb31a39`。

当前补丁后 1.18.35 包 SHA256：`8595b6457b09b2013cc2030ea236b9439ed718c5b3e9adfe23041c33d0a9fa8b`。

发行候选生成时使用的 1.18.34 基准和候选哈希仍保留在测试说明中，它们属于更新前检查。当前应用已是 1.18.35，禁止用旧 1.18.34 的 ASAR/feature 事务覆盖它。当前受管恢复入口会按应用版本和补丁哈希选择匹配的备份，先执行 DryRun，再决定是否真正恢复。

这次记录证明一次实际 Windows 官方更新后，恢复助手重建了语音集成并重新启动，随后出现语音结果写入草稿的日志。它不评估识别准确率、冷/热耗时，不保证所有未来版本、管理员安装器或所有机器。macOS 仍只有 Windows 上的模拟证据，官方更新后仍需手动重新 apply。

脱敏机器可读证据见 [validation-results-v0.2.0.json](validation-results-v0.2.0.json) 的 `observedLiveWindowsUpdate`；原始回读保留于本地 `test-results/windows-live-update-v0.2.0.json` 与 `windows-restore-after-update-v0.2.0.txt`。
