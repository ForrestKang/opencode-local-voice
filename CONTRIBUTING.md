# 贡献指南

感谢你为 OpenCode Local Voice 提交问题、改进代码或完善文档。项目的运行时功能、桌面补丁和本机服务都在同一个仓库中维护，请让每个改动保持清晰、可回退，并说明它影响的接入方式。

## 开始开发

项目需要 Node.js 20+ 和 Python 3.10+。CLI/TUI 的录音功能还需要 FFmpeg。安装开发依赖：

```bash
npm ci --ignore-scripts --no-audit --no-fund
python -m pip install -r requirements-test.txt
```

常用检查命令：

```bash
npm run check:sources
npm run check:docs
npm run typecheck
npm test
npm run test:python
npm run test:all
```

`npm run test:all` 包含源检查、文档检查、类型检查、Node、Python 和语音 UI 回归。语音 UI 使用 Playwright Core 和合成音频；需要时先安装 Chromium：

```bash
npx playwright-core install chromium
npm run test:ui
```

涉及原生 OpenCode 设置页时，可以使用本地安装的 `app.asar` 运行回归：

```powershell
$env:OC_VOICE_NATIVE_ASAR = "<OpenCode app.asar 的完整路径>"
npm run test:native-settings
```

更新桥的独立 Electron 回归使用项目固定的 Electron 44.6.0。测试环境缺少该运行时会直接失败：

```powershell
npm install --prefix test-results/electron-runtime --ignore-scripts --no-audit --no-fund electron@44.6.0
node test-results/electron-runtime/node_modules/electron/install.js
$env:OC_VOICE_REQUIRE_ELECTRON = "1"
npm run test:electron-runtime
```

打包命令会生成四个平台的候选包并校验版本、入口、文件哈希和不应进入发行包的内容：

```bash
npm run package
```

测试和打包命令不会替你操作正在运行的 OpenCode，也不会把个人配置、凭据、录音或模型写进仓库。需要真实设备验证的改动，请在 Pull Request 中说明验证环境和限制。

## 代码结构

| 目录或文件 | 作用 |
| --- | --- |
| `shared/voice_server.py` | 本机服务、配置、鉴权、队列和识别 worker |
| `shared/voice_cli.py` | 文件/麦克风客户端和服务入口 |
| `shared/desktop-bridge.cjs` | Desktop IPC、服务生命周期和任务取消 |
| `shared/oc-mic.js` | 录音、取消、快捷键和草稿界面 |
| `shared/browser-transport.js` | Web 本机服务客户端 |
| `shared/patch-package.cjs` | ASAR 校验、补丁和恢复辅助 |
| `shared/install-support.*` | 模型、部署和安装支持 |
| `windows`、`macos`、`linux` | 各平台安装、应用和恢复入口 |
| `extras/voice-input.ts` | 可选的 TUI 草稿工具 |
| `tools`、`tests` | 打包、源检查和回归测试 |

渲染器的权威实现是 `shared/oc-mic.js`。修改它以后，按项目约定运行 `npm run sync-renderer`，并检查生成的兼容副本。涉及 OpenCode DOM 或 ASAR 结构的改动必须在结构不匹配时安全失败，不能用宽泛替换破坏宿主应用。

## 提交问题和 Pull Request

提交 Issue 时，请提供系统、OpenCode 版本、接入方式、实际 backend/device/model、复现步骤和脱敏错误信息。不要上传 token、API 密钥、个人 Web 配对脚本、应用备份、原始录音、业务转写、个人绝对路径或未脱敏配置。安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告。

提交 Pull Request 时：

1. 从最新的 `main` 创建分支，并说明改动解决的问题和影响范围。
2. 保持代码、用户文档和 `CHANGELOG.md` 一致；不把内部调试材料或个人环境文件加入提交。
3. 运行与改动相关的检查，并在描述中写出命令和未覆盖的环境边界。
4. 保持提交聚焦，避免无关的依赖升级、格式化或接口变更。

语音输入的用户行为约定需要保持一致：Enter 或 STOP 结束录音并转写，Esc 或 `×` 取消，普通空格保留 OpenCode 原有行为，识别结果写入草稿后由用户自行发送。改动这些行为时，请在 PR 中说明兼容性影响。

## CI

GitHub Actions 在 Ubuntu、Windows 和 macOS 上运行源检查、类型检查、Node/Python 回归、Shell 或 PowerShell 语法检查和候选包校验。Windows 还运行固定 Electron runtime 的更新桥回归；Ubuntu 运行 Playwright 语音 UI 回归。Pull Request 合并前应等待相关检查完成。

项目使用 MIT License。提交代码即表示你有权按该许可证授权这些贡献。
