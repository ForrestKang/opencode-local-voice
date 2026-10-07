# V0.2.0 测试与证据说明

这份文档把自动测试、隔离 UI、独立 Electron runtime、真实 Windows 更新和真实 macOS 验收分开记录。合成音频、替身服务、ASAR fixture 或普通 Node 通过，只能证明对应隔离路径；不能证明真实麦克风、识别质量、官方 installer、签名/公证、Metal 或未来 OpenCode 版本。

对外编号为 **V0.2.0**。历史 `0.2.x`、`0.3.x` 只用于追溯内部开发过程。

## 证据状态

本次仓库审计的结果见 [repository-audit-v0.2.0.md](repository-audit-v0.2.0.md) 和 [机器可读结果](repository-audit-results-v0.2.0.json)。以下是本轮执行；原始日志留在本地 `test-results/`。

| 层级 | 本轮结果 | 证据 | 不能证明 |
| --- | --- | --- | --- |
| Node 全量 | 118/118，0 fail，0 skip | `test-results/node-audit.txt` | 真实窗口、官方更新器、真实麦克风 |
| Python | 62/62 | `test-results/python-audit.txt` | 真实模型质量、口音、驱动和 GPU/Metal |
| 语音 UI | 29/29 | `test-results/ui-report.json`；合成音频 | 真实麦克风和系统权限 |
| 原生设置 UI | 26/26 | `test-results/native-settings-report.json`；只读 1.18.35 ASAR | 真实主窗口和系统权限 |
| Windows Electron runtime | 13/13 | `test-results/electron-update-runtime.json`；独立 Electron 44.6.0 | 真实 OpenCode 窗口或官方 installer |
| Mac 模拟 | 17/17，11 项预期拒绝 | `test-results/macos-release-simulation.json`；Windows Git Bash | 真实 macOS 内核、权限、签名、公证、Metal、麦克风和 updater |
| 源语法检查 | 42 JS、11 PowerShell、7 Bash、19 Python AST；TypeScript/YAML PASS | 本轮审计日志与 JSON | 实际设备功能和权限 |

上一候选的 106/57/29/24/13/17 保存在 [历史验证 JSON](validation-results-v0.2.0.json)，不与本轮计数混用。Mac 模拟是 Node 套件的子集，不再加到 Node 总数上。

一次真实 Windows OpenCode 更新另有独立记录：1.18.34 → 1.18.35，更新后观察到 V0.2.0 脚本、工具栏、录音开始和草稿插入。它是实际链路证据，但不替代上述测试，也不评估准确率或延迟，见 [Windows 更新实机记录](windows-update-observed-v0.2.0.md)。脱敏机器可读摘要见 [validation-results-v0.2.0.json](validation-results-v0.2.0.json)。

## 测试层级

| 层级 | 命令/对象 | 可以证明 | 不能证明 |
| --- | --- | --- | --- |
| Node | `npm test` | 协议、客户端、取消、事务、helper 和 ASAR 逻辑 | 真实桌面或官方安装器 |
| Python | `npm run test:python` | 服务、worker、配置和文字处理 | 真实模型效果和设备驱动 |
| 语音 UI | `npm run test:ui` | 合成音频下的录音、按键、取消、草稿契约 | 真实麦克风、权限和 OpenCode 主窗口 |
| 原生设置 UI | `npm run test:native-settings` | 获准 ASAR 的设置 DOM/键盘契约 | 真实包替换和系统权限 |
| Electron runtime | `OC_VOICE_REQUIRE_ELECTRON=1 npm run test:electron-runtime` | 独立 Windows Electron 44.6.0 中的 production controller/bridge | 真实 updater-install 或 installer |
| 文档/候选包 | `npm run check:docs`、`npm run package` | Markdown 链接/围栏，以及四个平台候选包、文件哈希、版本和入口覆盖 | GitHub 上传、tag、Release 和真实设备 |
| 手工环境 | [manual-validation.md](manual-validation.md) | 指定设备上的真实链路记录 | 未执行的设备和未来版本 |

## 如何运行

先在仓库根目录准备依赖：

```bash
npm ci
python -m pip install -r requirements-test.txt
npm run check:sources
npm run check:docs
npm run typecheck
npm test
npm run test:python
```

UI 测试需要一份已确认存在的 Chromium/Chrome 可执行文件。不要在没有浏览器的环境直接运行，也不要把占位路径当作命令结果：

```powershell
$env:OC_VOICE_TEST_BROWSER = "<已确认存在的Chromium或Chrome可执行文件>"
npm run test:ui
```

原生设置测试需要一份获准读取的 OpenCode `app.asar`，测试不会修改它：

```powershell
$env:OC_VOICE_NATIVE_ASAR = "<已确认存在的OpenCode app.asar>"
npm run test:native-settings
```

独立 Electron runtime 必须显式要求 Electron；缺少 runtime 时应失败而不是跳过：

```powershell
npm install --prefix test-results/electron-runtime --ignore-scripts --no-audit --no-fund electron@44.6.0
node test-results/electron-runtime/node_modules/electron/install.js
$env:OC_VOICE_REQUIRE_ELECTRON = "1"
npm run test:electron-runtime
```

常规命令写入 `test-results/`。`--baseline` 只用于读取额外的旧桥源码基线，若执行了附加 14 项，报告中仍把常规结果写为 13 项，不把 baseline 加入当前计数。

打包检查使用：

```bash
npm run package
```

该命令先生成 source、Windows、macOS、Linux 四个候选 ZIP 和 `SHA256SUMS.txt`，再自动调用 `verify-release` 检查四包覆盖、内容哈希、V0.2.0 版本、平台安装入口和私有运行时排除。它只验证候选文件，不代表真实安装、Git push、tag 或 GitHub Release 已完成。

## 本轮已知边界和修复证据

上一候选记录过 Windows OpenCode 1.18.34 中 `updater-install` 的历史故障：连续点击三次时提示 `current app.asar is missing`，但物理文件和哈希正常。Electron 桥的 `node:fs` `lstat`/`isFile` 被 ASAR 运行时重写而误判；Node helper 继续使用 `node:fs`，Electron bridge 使用 `original-fs`，不通过全局 `process.noAsar` 切换解决。独立 Windows Electron runtime 检查 production controller 的三次故障重试、中文提示、native ready、成功 retry 和清理；它没有启动真实官方 installer。

真实用户更新只需点击一次执行更新；若准备阶段失败，可按提示重试并记录次数、错误文本和 native ready，成功后等待安装器退出和恢复。修复前三次点击是历史复现，不是当前发布必测动作。

取消契约：`×`/Esc 取消 requesting、recording、busy；STOP/Enter 只在 recording 中结束并转写；普通 Space 保持宿主行为。服务已消失时，bridge 先写 tombstone、只 probe 已存在服务再 DELETE，不得 ensure/restart 或启动真实 Python/server。正常 `close`/`destroyed`/`will-quit` 只能覆盖正常退出；硬退出或断电不能执行 JS 清理钩子。

## 真实验收记录模板

```text
版本：V0.2.0
平台 / 系统 / 架构：
OpenCode 版本和发行格式：
Electron 版本：
Python / Node / FFmpeg：
backend / device / model：
候选/源 SHA256（如适用）：
测试命令或手工步骤：
结果：PASS / FAIL / 未测
证据文件：
真实麦克风：是 / 否
官方 updater/installer：是 / 否
签名、公证、Metal 或系统权限：是 / 否 / 不适用
仍未覆盖：
```

## 发布描述的写法

- 写“上一候选基线”时保留证据文件和测试环境；不要把它写成本次审计重跑。
- 写“Windows 实机通过”时只指已有的一次 1.18.34 → 1.18.35 观察，并同时写清准确率、延迟和未来版本未测。
- Mac 17 项只能写 Windows Git Bash 模拟；真实 Mac `.app`、权限、签名、公证、Metal、麦克风和官方更新分开填写。
- 不把本机已安装状态、候选包、Git push、tag 或 GitHub Release 混为一件事。
