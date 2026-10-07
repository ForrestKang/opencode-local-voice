# 安全策略

V0.2.0 的识别服务只绑定本机 loopback。模型从本地文件加载；安装依赖、下载模型或生成 Web 配对脚本时可能联网。录音和转写在客户端、服务或 worker 内存中处理，当前实现不把它们写入普通日志。

## 访问边界

- 每个用户环境使用随机本机 token。状态和配置 API 不返回 token；凭据损坏时不会为了“自愈”而绕过身份校验。
- 客户端先用随机 challenge 验证 HMAC，再发送 Authorization 和音频。占用端口的陌生服务即使返回 HTTP 200，也不能通过身份检查。
- Web API 只接受配置中的精确 Origin；不使用通配 CORS。请求体、任务并发、排队和已完成结果均有边界。
- Desktop IPC 只接受受信任主页面。桌面补丁只增加该页面需要的音频访问，不放行摄像头、子帧或任意网页。
- Desktop 取消按窗口和任务核对所有权。必要时只终止本任务拥有的识别 worker；服务有活动任务时不会被静默 shutdown。
- Windows 更新/恢复按版本、应用路径、ASAR 哈希和事务清单匹配。未知布局、管理员安装器、跨版本事务和陌生进程会拒绝操作；这不是自动接管所有未来版本的承诺。
- Windows 本机凭据使用当前用户账户的 DPAPI 保护；复制凭据文件到另一个账户不能解密，但已经控制该账户的进程仍可能使用当前凭据。
- POSIX 系统的本机 token/config 文件使用 `0600` 权限；同一用户下的恶意进程仍属于信任边界内的风险。

同一用户账户下的恶意进程仍可能读取本机 token 或进程内存。本机凭据不能防御已经控制该账户的攻击者。Web userscript 只能导入可信页面；生成后不要上传或分享。

## 不要公开的数据

请勿提交 `local-voice/token`、`.personal.user.js`、`config.json`、应用恢复备份、模型私有路径、录音、业务转写、聊天内容、API 密钥或未脱敏日志。打包工具应排除个人 userscript、`node_modules`、配置和测试运行输出。

macOS apply 如果发现原始包的 `EnableEmbeddedAsarIntegrityValidation` fuse 为 `Enabled`，只会在候选 `.app` 上将该 fuse 关闭并进行 ad-hoc 签名；这会降低候选包由 Electron 强制执行的 ASAR 完整性检查。原始完整 `.app` 和原 fuse 状态会保留用于恢复。候选 ad-hoc 签名不能写成 Developer ID 签名、公证或 Gatekeeper 通过；脚本不自动清除 quarantine，也不以候选流程替代系统安全验收。

## 漏洞报告

请通过 [GitHub Security Advisory](https://github.com/ForrestKang/opencode-local-voice/security/advisories/new) 私密报告可利用问题。只附脱敏复现步骤、版本、平台和必要日志，不上传凭据或业务数据。

报告中请区分：

1. 真实 OpenCode 窗口/官方更新器行为；
2. 独立 Electron runtime 或 ASAR 模拟；
3. 合成音频、替身服务和普通 Node/Python 测试。

它们的证据强度不同，不能把隔离通过写成真实安装器、真实麦克风、签名、公证或未来版本兼容。
