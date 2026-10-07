# Windows 桌面端更新后的语音恢复

V0.2.0 的 Windows 更新交接以一次更新为边界：在 OpenCode 已下载新版本并准备重启安装时，主进程启动应用目录之外的一次性 helper。helper 准备成功后才交给官方更新器；下载、签名检查和安装仍由 OpenCode 官方更新器负责。

## 交接顺序

1. 记录当前应用版本、`resources\app.asar` 源哈希、目标版本和维护事务。
2. helper 验证版本、应用布局、服务身份和空闲状态；服务 busy 时不强制 shutdown。
3. helper 准备好一次性恢复上下文后，OpenCode 才停止后台并 hand-off 给官方 installer。
4. helper 等待 OpenCode、官方 installer 及可观察的安装子进程退出，再等待新 `app.asar` 稳定。
5. 新包版本必须等于本次更新目标。通过包结构、完整性、原生设置入口、输入条契约和脚本检查后，按新包生成 V0.2.0 候选。
6. 回读新包哈希、事务 manifest 和维护状态；重新绑定受维护的桌面/开始菜单/任务栏入口，再启动 OpenCode。

一次 Windows 1.18.34 → 1.18.35 更新已经观察到 helper ready、安装器进程、同版本恢复、维护检查、脚本加载、工具栏挂载、录音开始和草稿插入。完整记录见 [windows-update-observed-v0.2.0.md](windows-update-observed-v0.2.0.md)。这一次观察不证明未来版本、管理员安装器或其他平台。

## 启动入口和维护文件

维护入口会保存与当前 OpenCode.exe 对应的快捷方式信息，启动器在应用启动前检查脚本和后台文件。直接运行 `OpenCode.exe`、未被接管的第三方入口或系统后来重建的入口可能绕过检查；遇到这种情况应先使用 `Repair-Voice.cmd -Check` 读取状态，不要直接覆盖 app.asar。

默认维护目录位于用户配置目录下，文档不记录具体用户路径。`active.json` 指向带清单哈希的发布缓存；启动和恢复不依赖工作区源码仍存在。模型和语音配置保留在应用外目录。

维护文件、feature backup、maintenance transaction 和应用源包必须按版本、路径和哈希匹配。1.18.34 的事务不能恢复到 1.18.35，未知布局、管理员路径、陌生进程和缺失 manifest 均拒绝操作；实现不能承诺自动恢复所有未来版本。

## 更新后的检查

关闭并重新启动后记录：

- [ ] OpenCode 版本等于官方更新目标。
- [ ] 新 `app.asar` 存在，官方新包和候选补丁 SHA256 已保存。
- [ ] 维护检查 complete，V0.2.0 脚本已加载，工具栏已挂载。
- [ ] 原生设置、麦克风 requesting/recording、STOP/Enter、Esc/`×` 和草稿写入正常。
- [ ] 失败时用户界面显示中文；原始英文诊断可保留在 main 日志；已成功显示 prepare 故障提示的路径没有 Unhandled rejection。
- [ ] `Restore-Voice.cmd -DryRun` 能找到当前版本/哈希匹配事务。

如果只看到 `current app.asar is missing`，先回读物理文件和 SHA256。Electron 桥可能因为 ASAR 运行时文件语义误判；不要把英文提示当成物理文件已经丢失，也不要用旧 ASAR 覆盖新包。

## 取消、关闭和异常退出

`×`/Esc 取消 requesting、recording、busy；STOP/Enter 只结束 recording；普通 Space 保持宿主行为。取消必要时只终止本任务的识别 worker。服务 busy 时拒绝 shutdown，服务已消失时取消不会 ensure/restart 真实 Python/server。

正常窗口 `close`、Electron `destroyed` 和 `will-quit` 回调只覆盖正常退出路径。任务管理器结束进程、硬退出或断电无法执行 JavaScript 退出钩子，不能承诺立即取消、释放全部音轨或恢复未提交录音/草稿；服务超时回收也不是硬退出保证。产品没有强杀 OpenCode 按钮。

## 回退和跨平台边界

Windows feature restore 会覆盖事务快照范围内后来修改的配置和后台文件。恢复前先把后来配置、词表和凭据密文另存，恢复后再合并；恢复应用不等于删除模型、聊天、工作区、venv 或服务凭据。完整命令和禁止条件见 [recovery-v0.2.0.md](recovery-v0.2.0.md)。

macOS 采用完整 `.app` 备份和手动 apply/restore。官方更新替换 `.app` 后需要重新 apply；Windows 的更新接管证据不能覆盖 Mac 的签名、公证、权限、Metal 或官方 updater 验收。
