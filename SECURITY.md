# 安全策略

## 安全设计

OpenCode Local Voice 在设计上尽量保守：

| 措施 | 说明 |
|---|---|
| 🔒 音频不出本机 | 录音只在本机内存与本地服务（127.0.0.1）之间流转，没有任何网络上传 |
| 📦 改动范围可控 | 只修改 OpenCode 桌面版的 `app.asar`（三个注入点）与本地 `~/.config/opencode` 下的服务文件，不碰系统 |
| ✅ 全量校验 | 补丁生成器对结果做 6950+ 文件哈希校验，异常立即中止且不写入安装目录 |
| 💾 默认备份 | 首次打补丁自动保存原版 `app.asar`（macOS 另存 `Info.plist`），可一键还原 |
| 👀 开源可审 | 全部代码开源，识别模型来自公开仓库（hf-mirror / HuggingFace） |

## 报告安全问题

如果你发现安全漏洞（例如：注入逻辑可被利用、服务端口可被越权调用等）：

- 优先使用 [GitHub Security Advisory](https://github.com/ForrestKang/opencode-local-voice/security/advisories/new) 私密报告
- 或邮件联系维护者（见 GitHub 主页）

请勿在公开 Issue 中披露未修复的漏洞细节。会在确认后尽快修复并致谢。

## 支持范围

仅维护最新 release 对应版本（当前 `0.1.x`）。
