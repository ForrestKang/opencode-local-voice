# 安全策略

OpenCode Local Voice 默认在本机运行语音服务。服务绑定 loopback，客户端通过随机 token 和 challenge-response 鉴权；Web 接入只允许配置的精确 Origin，不使用通配 CORS。录音和转写结果用于当前任务，不应作为业务数据或凭据提交到仓库。

## 数据和凭据

- 安装依赖、下载模型和使用配置的 AI 改写服务可能需要网络。
- AI 改写默认关闭。启用后，本次转写文本和配置的改写提示会发送到你选择的服务；请确认该服务的隐私政策和数据处理范围。
- Windows 凭据使用当前用户的 DPAPI 保护。POSIX 系统的 token 和配置文件使用 `0600` 权限。
- 已经控制当前用户账户的进程可能读取该账户可用的 token、配置或进程内存；本项目不能防御这种情况。
- 不要公开 `token`、`.personal.user.js`、`config.json`、应用备份、录音、转写内容、API 密钥或未脱敏日志。

Desktop IPC 只接受受信任的 OpenCode 页面。取消操作按窗口和任务核对所有权，避免一个窗口控制另一个窗口的任务。更新和恢复操作会校验版本、应用路径、ASAR 哈希和事务清单；遇到未知布局或不匹配的数据会拒绝继续。

## macOS 安全边界

macOS 候选补丁会保留完整的原始 `.app` 以便恢复。如果原包启用了 Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse，候选包可能需要关闭该 fuse 并进行 ad-hoc 签名。这会降低候选包的 ASAR 完整性强制检查；ad-hoc 签名不等于 Developer ID 签名、公证或 Gatekeeper 通过。使用前请按你的发布和系统安全要求完成实际签名与验证。

## 报告漏洞

请通过 [GitHub Security Advisory](https://github.com/ForrestKang/opencode-local-voice/security/advisories/new) 私密报告可利用的安全问题。请提供受影响版本、系统、复现步骤和必要的脱敏日志；不要在公开 Issue 中发布凭据、个人脚本、录音或业务数据。

我们会确认报告、评估影响并在修复可用后更新公告。普通功能问题和使用咨询请提交公开 Issue。
