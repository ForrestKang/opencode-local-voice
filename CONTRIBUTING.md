# 贡献指南

感谢你愿意为 OpenCode Local Voice 做贡献！

## 提交 Issue

- 提交前请先看 [常见问题](README.md#常见问题)
- Bug 报告请使用 [Issue 模板](https://github.com/ForrestKang/opencode-local-voice/issues/new/choose)，并附上：
  - 系统（Windows 版本 / macOS 版本）与 OpenCode 桌面版版本
  - 调试日志：Windows `%TEMP%\oc-mic-debug.log`、macOS `$TMPDIR/oc-mic-debug.log`
  - 识别服务日志：`~/.config/opencode/whisper/stt_server.log` 尾部

## 开发环境

```
git clone https://github.com/ForrestKang/opencode-local-voice
cd opencode-local-voice
```

改完代码后用平台的 apply 脚本本地验证：

| 平台 | 命令 |
|---|---|
| Windows | 双击 `windows/apply-oc-mic.cmd` |
| macOS | `./macos/apply-oc-mic.sh` |

### 目录职责

| 文件 | 职责 |
|---|---|
| `oc-mic.js` | 注入渲染页面：按钮、录音、WAV 编码、写入输入框（两个平台同一份） |
| `patch-oc-mic.js` | 修改 `app.asar`：权限 + IPC 桥 + 注入脚本；自带语法与全量哈希校验 |
| `stt_server.py` | 本地识别 HTTP 服务（127.0.0.1:47832） |

### 修改注意事项

- `oc-mic.js` 必须保留 `oc-mic-v3` 兼容标记与 `prompt-submit` 锚点字符串（补丁器会校验）
- `patch-oc-mic.js` 的锚点（如权限 Set、theme script 标签）若因 OpenCode 升级而变化，
  请同步更新并把校验失败信息写清楚——**宁可中止，不可静默改坏用户的安装**
- 提交前跑一遍 CI 等价检查：

```bash
node --check windows/oc-mic.js macos/oc-mic.js
node --check windows/patch-oc-mic.js macos/patch-oc-mic.js
bash -n macos/install.sh macos/apply-oc-mic.sh macos/restore-oc-mic.sh
python3 -m py_compile windows/stt_server.py macos/stt_server.py
```

## 提交 PR

- 保持改动聚焦，一个 PR 做一件事
- Commit message 建议使用 `feat:` / `fix:` / `docs:` / `chore:` 前缀
- 涉及行为变化请同步更新 `CHANGELOG.md`
