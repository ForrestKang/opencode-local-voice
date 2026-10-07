# V0.2.0 仓库审计与验证

日期：2026-10-07。对外版本：**V0.2.0**。

本轮修复代码、Windows 恢复事务、安装入口和发布材料中的不一致，并重跑相关验证。修改在独立 Git 分支进行，原开发目录的未提交修改和上一候选包保留。本轮没有替换用户已安装的 OpenCode，也没有操作真实麦克风、官方更新器或真实恢复事务。

## 发现并修复的问题

| 问题与触发条件 | 修改后的行为 | 回归证据 |
| --- | --- | --- |
| TUI 在读取配置期间取消仍录音；识别返回时取消仍追加文字 | 配置、设备发现和识别返回的异步边界检查取消状态；取消后不录音、不追加草稿 | `tests/tui.test.cjs`；新增用例修复前失败，修复后通过 |
| CLI 无效麦克风/时长或不存在的文件仍启动后台 | 在启动后台之前验证参数、文件和配置中的最长时长 | `tests/test_voice_cli.py`；修复前仍调用 ensure，修复后不调用 |
| 活动任务期间保存未变化设置返回 409 | 仍验证配置，但只有变化时才更新 worker；未变化保存返回 200，活动任务继续 | `tests/test_voice_server.py`；修复前复现 409 |
| 原生设置的词表、纠错和模板限制超过服务限制 | 对齐 100 项、单项 80 字符和总长度；允许删除型纠错，拒绝重复来源和错误模板 | 原生设置 legacy/v2 各执行边界测试；非法内容在请求服务前拒绝 |
| 停止服务或备份准备失败遗留无效事务 | stop 失败不创建有效事务；准备失败移除本次不完整快照，应用和后台文件保持原内容 | feature stop、snapshot 和 restore preparation 故障注入 |
| 维护入口先恢复，应用恢复失败后不能重试 | 应用/后台先恢复；维护失败保留可重试状态，下一次只重试维护 | Windows PowerShell fixture 验证顺序、阶段失败和 retry |
| 恢复按时间误选不相关事务 | maintenance 取自 active.json，验证应用、包哈希和收据；跳过无关 feature，已有 sidecar 必须匹配 | `tests/restore-managed.test.cjs` |
| 备份落入应用目录、链接路径；DryRun 接受不支持的布局 | 前置拒绝内部/链接备份；恢复写入检查链接及父路径；Windows 受管入口统一只接受 resources/app.asar | ASAR、feature、maintenance 和 Windows 布局拒绝回归 |
| 旧报告脚本写入过期结果，候选包缺少独立校验 | 删除写旧 0.3.x 结果的工具；归档开发说明；校验四包路径、哈希、版本和入口 | 打包篡改、私有文件、越界路径和缺失输入负向回归 |

停止服务失败后不会盲目启动身份不明或忙碌的服务。安全结果是文件未部署、错误可见，用户确认环境后可以重试；不承诺服务必然恢复为运行状态。

## 本轮实际验证

命令、环境和代码哈希见 [机器可读审计结果](repository-audit-results-v0.2.0.json)。本表属于本轮执行，历史候选数字另行保存。

| 检查 | 本轮结果 | 范围 |
| --- | --- | --- |
| Node 全量 | 118/118 PASS，0 fail / 0 skip | 客户端、取消、补丁、事务、更新桥和 Windows fixture |
| Python | 62/62 PASS | 配置、服务、worker、CLI 和打包负向检查 |
| 语音 UI | 29/29 PASS | Chromium 合成音频，非真实麦克风 |
| 原生设置 UI | 26/26 PASS | 只读 OpenCode 1.18.35 ASAR，在隔离宿主运行原生组件 |
| Windows Electron | 13/13 PASS | Electron 44.6.0 独立 runtime、production bridge/controller；非官方 installer |
| Mac 模拟 | 17/17 PASS，其中 11 项预期拒绝 | Windows Git Bash 替身；属于 Node 套件子集，不重复相加 |
| 源码检查 | 42 JavaScript、11 PowerShell、7 Bash、19 Python AST；TypeScript PASS | Windows PowerShell 5.1；CI/Issue YAML 和平台 renderer 一致性通过 |
| 依赖安装 | npm ci PASS | 新建隔离目录，使用 package-lock，不修改原开发目录依赖 |
| 文档与候选包 | Markdown 链接/围栏、四包校验 PASS | 不提交私有运行时、模型、凭据、应用二进制或个人脚本 |

环境：Windows 11 x64、Node 24.15.0、Python 3.12.10、Chromium 153.0.8010.12 / Playwright 1.63.0。具体执行条件见 [测试说明](testing-v0.2.0.md)。原始日志保留在本地 `test-results/`。Node 的 stop、阶段恢复和无效布局报错属于故障注入的预期输出，每项均断言拒绝与文件状态。

### 首次远端 CI 回读

首个提交的 Ubuntu 回归与浏览器检查通过。Windows 发现 fixture 清理阶段把 TEMP 中的 8.3 短文件名 `runner~1` 与 realpath 长文件名比较，导致身份断言失败。测试现在创建 fixture 后立即保存 canonical root，继续保留严格清理校验；没有删除用例或放宽安装/恢复保护。修复后重新运行 Windows maintenance 分项并推送，后续 CI 结果以 GitHub Actions 记录为准。

## 本机 ASAR 只读检查

对 OpenCode 1.18.35 生成隔离候选，完成文件哈希、重复应用幂等性、生产代码回读和 8 个脚本语法检查：

```text
原安装 ASAR SHA256：8595b6457b09b2013cc2030ea236b9439ed718c5b3e9adfe23041c33d0a9fa8b
隔离候选 SHA256：e9152489315e5dbf65a4e7db22a41192cfce3aa01ecf3f5a2ae654e069619a0d
packedFiles / integrityHashedFiles：6953 / 6953
sourceUnchanged / idempotent / productionSourcesReadback：true / true / true
```

该候选没有安装到用户的 OpenCode。当前机器仍使用此前已验收的版本，本轮共享服务和事务修改不能冒充已经完成实机部署。

## 历史证据与未测边界

此前 Windows 官方更新 **1.18.34 → 1.18.35** 有独立 [实机记录](windows-update-observed-v0.2.0.md)。[上一候选 JSON](validation-results-v0.2.0.json) 中的 106/57/29/24/13/17、安装状态和哈希属于历史候选；当前结果单独记录。

本轮未验证真实 macOS 内核、麦克风权限、ACL/xattrs、签名、公证、Gatekeeper、Metal 或官方更新，也未执行真实 Linux 桌面验收。Windows fixture 不证明所有用户权限、杀毒软件、路径交换竞态、管理员 installer 或未来 OpenCode 布局。

识别准确率、口音、冷/热耗时、GPU 和外部 AI 改写需要真实环境记录。取消和 STOP 保留，没有强杀 OpenCode 按钮；硬退出或断电不会执行 JS 清理钩子。手工步骤见 [验收清单](manual-validation.md)，配置覆盖范围和阶段失败重试见 [恢复说明](recovery-v0.2.0.md)。

## 文档和发布产物

中文/英文 README、安装、贡献、安全、测试、Windows bug、更新和恢复说明统一到 V0.2.0。13 份内部记录移至 [archive](archive/README.md)，原生设置预览保留为可选布局参考。

`npm run package` 生成 source、Windows、macOS、Linux 四个候选 ZIP；每包有 `CONTENTS.sha256`，完整包哈希在 `dist/SHA256SUMS.txt`。校验要求四包齐全，拒绝篡改、危险路径、符号链接和私有运行时文件。ZIP 与原始日志保留在本地，源码及说明提交 Git。

Git 推送已经由用户明确授权。实际提交编号与远端回读以 Git 历史和交付消息为准；本轮不创建 tag 或 GitHub Release，不把源码推送写成正式发行或本机安装。
