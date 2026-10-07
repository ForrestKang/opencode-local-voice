# 贡献与验证

本仓库对外版本统一为 **V0.2.0**。`0.2.x`、`0.3.x` 只用于说明内部开发历史；修改文档、测试和代码时不要把历史编号写成已发布版本。

## 报告问题

请附系统和架构、OpenCode 版本/发行格式、Desktop/Web/TUI/CLI 接入方式、backend/device/model、录音长度、冷/热识别耗时、复现步骤和脱敏错误信息。说明证据类型：自动测试、隔离浏览器、真实启动、真实官方更新或真实麦克风。

不要提交 token、API 密钥、个人 Web 配对脚本、应用恢复备份、原始录音、业务转写、个人绝对路径或未脱敏配置。问题中若包含 `app.asar`，只提供必要的版本和 SHA256 摘要。

## 目录职责

| 目录/文件 | 职责 |
| --- | --- |
| `shared/voice_server.py` | loopback 服务、配置、鉴权、队列和推理 worker |
| `shared/voice_cli.py` | FFmpeg 文件/麦克风客户端和服务入口 |
| `shared/desktop-bridge.cjs` | Desktop IPC、服务生命周期、任务所有权和取消 |
| `shared/oc-mic.js` | 共享录音、取消、按键和草稿界面 |
| `shared/browser-transport.js` | Web 本机协议客户端 |
| `shared/patch-package.cjs` | ASAR 校验、补丁候选生成和恢复辅助 |
| `shared/install-support.*` | 模型校验/下载、部署和安装支持 |
| `windows` / `macos` / `linux` | 平台安装、应用和恢复入口 |
| `extras/voice-input.ts` | 可选 TUI 草稿工具 |
| `tools` / `tests` | 打包、源检查和隔离回归 |

渲染器的权威修改在 `shared/oc-mic.js`。若存在兼容副本，运行 `npm run sync-renderer`，再检查生成文件。保留 OpenCode 原有 form/contenteditable/submit 锚点；未知 DOM、ASAR 布局或权限结构应失败并给出诊断，不能用宽泛正则删除主进程后续代码。

## 本地检查

```bash
npm ci
python -m pip install -r requirements-test.txt
npm run check:sources
npm run check:docs
npm run typecheck
npm test
npm run test:python
```

`npm run test:all` 是上述常规源检查、类型检查、Node、Python 和语音 UI 的组合，不包含需要外部应用包的原生设置测试，也不包含独立 Electron runtime。变更涉及对应路径时再运行下面的隔离检查。

语音 UI 和原生设置 UI 使用 Playwright Core。先准备一份本机已有的 Chromium/Chrome 可执行文件，再设置实际路径；不要把不存在的占位路径直接提交或当作通过：

```powershell
$env:OC_VOICE_TEST_BROWSER = "<已确认存在的Chromium或Chrome可执行文件>"
npm run test:ui

# 下面的 ASAR 必须是获准读取的 OpenCode app.asar，测试只读它
$env:OC_VOICE_NATIVE_ASAR = "<已确认存在的OpenCode app.asar>"
npm run test:native-settings
```

Windows Electron runtime 回归使用项目配置的 Electron 44.6.0 binary。要求测试缺失时直接失败，不得通过跳过来隐藏环境问题：

```powershell
npm install --prefix test-results/electron-runtime --ignore-scripts --no-audit --no-fund electron@44.6.0
node test-results/electron-runtime/node_modules/electron/install.js
$env:OC_VOICE_REQUIRE_ELECTRON = "1"
npm run test:electron-runtime
```

`test:electron-runtime` 的输出保存在 `test-results/`；它覆盖 production controller/bridge 的隔离链路，不等同于真实 OpenCode 窗口或官方 installer。Mac 相关测试如果在 Windows Git Bash 中运行，报告中必须标为模拟。

PowerShell 脚本使用 Parser API 检查，Bash 脚本使用 `bash -n` 检查。测试不会请求真实麦克风；浏览器使用合成音频，推理可使用 fake 后端。真实 Windows/macOS 设备应按 [docs/manual-validation.md](docs/manual-validation.md) 单独验收。

## 打包和文档

`npm run check:docs` 检查 Markdown 代码围栏和仓库内链接，不访问外部网站。`npm run package` 会生成 source、Windows、macOS、Linux 四个候选 ZIP 和 `SHA256SUMS.txt`，随后自动运行 `verify-release`，校验四个压缩包的覆盖范围、文件哈希、版本、平台入口和私有运行时排除。它不自动上传 GitHub，也不创建 tag 或 Release。检查包内容后再处理发布流程。

行为变更要同步更新用户文档和 CHANGELOG；测试证据应记录运行命令、环境、结果文件和证据边界。自动测试、ASAR 模拟或本机启动通过时，不要写成真实麦克风、真实官方更新、签名/公证或未来版本兼容。
