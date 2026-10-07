# V0.2.0 Windows bug、修法和验收边界

本表区分观察到的症状、触发根因、修法契约和证据等级。历史材料中的 `0.2.x`、`0.3.x` 只用于追溯开发过程；上一候选自动测试数字不能代替本次仓库审计或真实设备验收。

## 已观察问题和修法

| 症状 | 触发根因 | 修法/当前契约 | 已有证据及限制 |
| --- | --- | --- | --- |
| 设置或录音时弹出终端窗口 | Windows 子进程使用会分配控制台的 Python 入口，或没有隐藏窗口 | 使用 windowless Python、`windowsHide` 和 detached 服务；维护入口不创建可见控制台 | 上一候选 Node/Python 和真实启动记录；不覆盖所有 Python、杀毒软件和系统策略 |
| Enter/Esc 被宿主拦截，Esc 后音轨继续 | 宿主的 native shortcut 在 document 处理前拦截事件，取消函数根本没有被调用；旧取消函数本身会停止 recorder、音轨和任务 | 在 window capture 处理当前活动录音；Enter 只结束 recording，Esc/`×` 取消 requesting/recording/busy | 上一候选语音 UI 隔离项覆盖宿主拦截、权限迟到、STOP/`×`、IME 和 pagehide；真实麦克风和未来布局仍需测 |
| STOP 点击后状态卡在转写或 ACK 丢失 | 录音结束、任务提交和后台状态通知的时序没有统一收口 | STOP/Enter 结束录音后只提交本任务；迟到状态按任务 ID 过滤，取消写 tombstone | 上一候选 Node/UI 隔离回归；真实网络/设备异常仍需记录 |
| 示例结果栏或独立设置入口出现 | 早期集成把测试展示控件留在主界面，或把原生设置误做成独立页面 | 工具栏只保留语音控制；设置使用 OpenCode 原生 Settings tab | 原生设置隔离回归；不替代真实窗口视觉验收 |
| 多版本 ASAR 对齐或更新后补丁被抹掉 | 补丁只绑定旧包结构，未按新版本生成候选和保存事务 | 按版本、路径、源/候选哈希生成新事务；未知布局拒绝操作；官方更新后重新恢复/应用 | ASAR fixture、候选完整性和一次 Windows 更新记录；不保证未来版本 |
| 1.18.34 窗口 `updater-install` 连点三次提示 `current app.asar is missing` | 物理 `resources\app.asar` 和源哈希仍存在；Electron 桥调用的 `node:fs` `lstat`/`isFile` 被 ASAR 运行时重写而误判。普通 Node、ASAR 模拟和普通启动未覆盖 Electron 点击链路 | Electron bridge 使用 `original-fs`；Node helper 继续使用 `node:fs`；不使用全局 `process.noAsar`；成功显示 prepare 故障提示的路径显示中文且无 Unhandled rejection，英文诊断可留在 main 日志 | 修复前真实 Windows 三次点击是历史复现；独立 Windows Electron 44.6.0 runtime 只证明隔离 controller/bridge 重试和恢复 fixture，不证明真实 installer |
| 取消时服务已消失却重新启动真实 Python/server | 旧 teardown 在服务消失后仍调用 ensure，fixture home 已删除时启动了真实 runtime | 先写本地 tombstone，再 probe 已存在服务；存在才 DELETE，不 ensure/restart；fixture 使用临时 voice home、配置、端口和 token | 上一候选 bridge 取消竞态证据含 HMAC POST/shutdown 202；需在本次审计报告中区分历史基线 |
| 恢复身份解析把 Win32 PID 0 当作真实进程 | Windows 进程查询返回系统 Idle PID 0，身份检查未排除 | 排除 PID 0，再核对可解析进程身份；未知或管理员进程拒绝接管 | Windows helper 回归和安全拒绝证据；不覆盖 EDR、权限或不同系统语言 |
| 安装准备失败留下不完整事务；恢复半途失败后不能重试 | stop/snapshot 不在准备失败收口中；维护入口先恢复，导致 feature 失败后入口和运行时不一致 | stop 失败不建立事务；准备失败移除不完整快照；feature 先恢复，maintenance 失败后可单独重试 | 本轮故障注入与 Windows PowerShell fixture；未替用户执行真实恢复 |
| 恢复选到无关事务；DryRun 接受实际不支持的目录 | 按时间独立选择 feature/maintenance；发现逻辑比写入逻辑支持更多布局 | 维护事务取自 active.json 并核对关联；跳过无关 feature；Windows 受管入口统一只支持 resources/app.asar | 本轮 managed restore、布局拒绝和链接路径回归；真实权限竞态仍需实机验证 |

## 输入、取消和退出契约

- `×`/Esc 在 requesting、recording、busy 都是取消动作。
- STOP 方块和 Enter 只在 recording 中结束并转写；普通 Space 保持宿主输入。
- 取消必要时只终止本任务拥有的识别 worker，其他窗口和 OpenCode 进程保持可用。
- 服务 busy 时拒绝 shutdown；显式取消或任务完成后才允许正常关闭。
- 正常窗口 `close`、Electron `destroyed` 和 `will-quit` 只覆盖正常退出；硬退出、任务管理器结束进程或断电无法执行 JavaScript 退出钩子，不能承诺立即取消、释放所有音轨或恢复未提交录音/草稿。
- 产品没有强杀 OpenCode 按钮。

## 更新和恢复验收

真实用户更新只点击一次 `updater-install`，然后等待官方 installer 和维护恢复。如果准备失败，可按提示重试并记录次数、错误文本、native ready、helper 和 installer 状态；修复前三次点击只保留为历史事实。独立 runtime 的三次故障重试属于隔离证据，不是连续点击真实应用的要求。

每次记录：

- [ ] OpenCode/Electron 版本、发行格式、候选和源 SHA256。
- [ ] 物理 `resources\app.asar` 存在性与哈希回读。
- [ ] Electron bridge `original-fs`、Node helper `node:fs`、全局 `process.noAsar` 未启用。
- [ ] 成功显示 prepare 故障提示的路径无 Unhandled rejection；意外/未显示提示继续视为未通过。
- [ ] 成功路径的 helper ready、hand-off、installer、恢复和重新启动状态。
- [ ] 失败时保留官方包、原始日志和事务目录，不因英文提示删除 app.asar。
- [ ] Windows feature restore 前另存后来配置；版本、路径、哈希或 manifest 不匹配时拒绝恢复。

## 证据填写模板

```text
平台 / OpenCode / Electron：
触发步骤：
错误文本（原文）：
物理 app.asar 存在性和 SHA256：
bridge 文件模块：original-fs / 未确认
Node helper 文件模块：node:fs / 未确认
process.noAsar：未使用 / 使用 / 未确认
native ready：
updater-install 点击次数与每次状态：
helper / installer / restore 状态：
结果：PASS / FAIL / 未测
证据文件（脱敏）：
仍未覆盖：
```

不能用删除测试、跳过 runtime、放宽哈希校验或硬编码结果把历史 bug 改成通过。
