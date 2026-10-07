# V0.2.0 UI 测试与恢复速查

这份清单用于真实 Windows/macOS 设备的手工检查。自动测试使用合成音频、替身服务、隔离 ASAR 或独立 Electron runtime，不能替代真实麦克风、真实 OpenCode 窗口、官方安装器或真实 Mac 应用。每项记录 `PASS / FAIL / 未测`、平台、版本、时间和脱敏证据索引。

一次 Windows OpenCode **1.18.34 → 1.18.35** 官方更新已经单独记录，更新后观察到脚本加载、工具栏、录音开始和草稿写入；详见 [Windows 更新实机记录](docs/windows-update-observed-v0.2.0.md)。该记录不代表本清单的每台设备都已通过。

## Windows

### 安装前

1. 保存工作并正常退出 OpenCode。
2. 在仓库根目录运行只读候选检查：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\install-feature-preview.ps1 -DryRun
   ```

3. 记录源/候选 ASAR SHA256，并确认 DryRun 没有替换应用、配置、模型或快捷方式。

### 安装和界面

1. 运行 `.\windows\install-feature-preview.cmd`，保存 feature transaction 和 maintenance transaction。
2. 从受维护的桌面、开始菜单或任务栏入口启动 OpenCode；单独运行 `OpenCode.exe` 可能绕过启动检查。
3. 打开 OpenCode 原生设置，检查“语音输入”与宿主设置同级，明暗主题、窄窗口、滚动和键盘焦点正常。
4. 逐项操作并记录：

   - [ ] requesting 点击 `×`，回到 idle，无残留 spinner。
   - [ ] recording 点击 `×` 或按 Esc，轨道停止，草稿保持原样。
   - [ ] recording 点击 STOP 或按 Enter，只结束录音并开始转写。
   - [ ] busy 点击 `×` 或按 Esc，任务取消，迟到结果不写入草稿。
   - [ ] 普通 Space、IME 确认、带修饰键输入保持宿主行为。
   - [ ] 结果只写入草稿，不自动发送；失败后可以在当前页面重试。
   - [ ] recording 期间触发 pagehide 后音轨释放并保留草稿；转写期间触发 pagehide 后任务取消，迟到结果不写入。
   - [ ] 没有新的终端或 Python 控制台窗口。
   - [ ] 关闭/取消一个窗口不会取消另一个窗口的任务。
   - [ ] 服务 busy 时 shutdown 被拒绝；任务取消或完成后可正常停服和再次启动。

### Windows 更新观察

真实用户更新执行一次点击即可：在 OpenCode 的更新界面点击一次 `updater-install`，成功后等待官方安装器退出和维护入口恢复。如果准备阶段失败，可按提示再次尝试，并记录每次的错误文本、次数、native ready、helper/installer 状态；不要求连续点击三次。修复前 1.18.34 连点三次出现 `current app.asar is missing` 是历史复现，不是当前测试步骤。

隔离 Windows Electron 44.6.0 runtime 可单独检查 production controller 的三次故障重试、中文提示、native ready 和清理；它不启动真实 OpenCode updater 或官方 installer。物理 `resources\app.asar` 存在时，必须同时记录文件存在性和脱敏 SHA256，不能只凭英文错误判断文件缺失。

### Windows 回退

先把安装后新增或修改的设置、词表和凭据密文另存到事务目录之外，再运行：

```powershell
.\windows\Restore-Voice.cmd -DryRun
```

DryRun 匹配当前版本、ASAR 哈希、应用路径和事务后，关闭 OpenCode 并执行：

```powershell
.\windows\Restore-Voice.cmd
```

Windows feature restore 会覆盖事务快照范围内的配置和后台文件；恢复后按备份清单合并后来变化。它不会自动删除模型、聊天、工作区、venv 或服务凭据。

## macOS

真实 Mac 上使用完整 `.app`，先做只读检查：

```bash
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app --dry-run
```

确认目标、版本和完整包备份匹配，关闭 OpenCode 后再执行：

```bash
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app
```

逐项记录：

- [ ] 完整 `.app`、资源、扩展属性/ACL 和 app.asar 哈希已保存。
- [ ] 候选 `Info.plist` 麦克风说明、fuse 状态和候选签名已记录；ad-hoc 不写成官方签名或公证。
- [ ] 真实系统麦克风允许/拒绝/重新允许、STOP/Enter/Esc/`×`、Space、草稿和重试可用。
- [ ] Apple Silicon 的 Metal/MLX 或 Intel 的 CPU 路径有实际加载和转写证据。
- [ ] 官方更新后重新 apply；不能把 Windows 更新接管证据外推到 Mac。

## 结果模板

```text
版本：V0.2.0
系统 / 架构：
OpenCode 版本和发行格式：
Electron 版本（如可得）：
backend / device / model：
步骤：
期望：
实际：PASS / FAIL / 未测
证据索引（脱敏）：
未覆盖边界：
```

## 退出边界

产品保留结束录音和取消动作，没有强杀 OpenCode 按钮。正常 `close`、Electron `destroyed` 和 `will-quit` 回调只覆盖正常退出；硬退出、任务管理器结束进程或断电无法执行 JavaScript 退出钩子，因此不能承诺立即取消、释放全部音轨或恢复未提交录音/草稿。服务超时回收和正常启动恢复应分开记录。
