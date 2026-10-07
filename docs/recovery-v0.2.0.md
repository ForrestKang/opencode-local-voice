# V0.2.0 安装、回退和恢复

**Windows feature restore 不会自动保留安装后后来修改的配置；它会覆盖事务快照范围内的配置和后台文件。恢复前必须先把后来新增或修改的语音设置、词表和凭据密文另存到事务目录之外，恢复后再按清单合并。** 恢复应用也不会自动删除模型、聊天、工作区、venv 或服务凭据。

恢复的目标是把应用、桌面维护入口、运行时和事务中的配置恢复到同一版本、同一 ASAR 哈希的已验证快照。它不是跨版本迁移、数据清理或强制修复工具。

## 何时可以恢复

可以考虑恢复的情况：

- 当前 OpenCode 版本、应用路径、`resources\app.asar` 哈希和事务清单仍完全匹配；
- 安装后持续启动失败、原生设置/工具栏失效、维护入口无法检查，且后来配置已经另存；
- DryRun 能找到同版本、同哈希、状态为 applied 的 feature transaction 以及匹配的 maintenance transaction。
- 若上次已恢复 feature、只剩 maintenance 失败，DryRun 可以匹配状态为 restored 且当前 ASAR 等于原始哈希的 feature transaction，随后仅重试维护恢复。

恢复前先正常退出 OpenCode。脚本不会替用户结束应用，也不会接管陌生或管理员进程。

## 何时不要恢复

遇到以下任一情况，应保留当前官方应用和事务目录，先记录错误：

- 当前应用版本或 ASAR SHA256 与事务不一致；
- 只有 `current app.asar is missing` 英文提示，但物理 `app.asar` 存在或哈希正常；这可能是 Electron 桥的 ASAR 探测误判，不能用旧 ASAR 覆盖新包；
- 目标布局未知、`resources\app.asar` 缺失、备份/manifest 不完整，或维护路径是管理员安装；
- OpenCode 仍在运行、服务有未取消的活动任务、目标进程身份无法验证；
- 目标事务来自另一 OpenCode 版本、另一应用路径或另一候选包；
- 目的是删除模型、聊天、工作区、venv 或凭据。恢复不会完成这些清理。

硬退出、任务管理器结束进程和断电不是正常恢复步骤。它们不会执行 JavaScript 退出钩子，不能承诺立即取消或恢复未提交录音/草稿；先重新启动并完成 DryRun，再判断是否需要恢复。

## Windows 受管安装的恢复

### 1. 预检并保存后来配置

把安装后新增/修改的设置、词表和凭据密文复制到维护事务目录之外，记录原路径、时间和文件哈希。不要把唯一副本留在会被事务覆盖的位置。

### 2. 只读检查

```powershell
.\windows\Restore-Voice.cmd -DryRun
```

该入口读取维护配置，检查 package manifest、当前 app 版本/哈希、feature backup 和 maintenance transaction。DryRun 不替换应用、快捷方式、运行时或配置。

Windows 受管流程只接受 `AppPath\resources\app.asar`。维护事务由 `active.json.transactionPath` 指定，并核对应用、包清单、配置和快捷方式收据；feature 旁存在 `maintenance.json` 时还必须匹配该关联。无关应用的同版本备份不会被选中。路径或父目录经过 symlink/junction 时拒绝写入。

### 3. 执行匹配恢复

DryRun 成功且 OpenCode 已正常退出后执行：

```powershell
.\windows\Restore-Voice.cmd
```

成功后从恢复的快捷方式重新启动，确认 OpenCode 正常打开。恢复到官方原包时，“语音输入”页和麦克风按钮会消失，这是预期结果；恢复到含旧插件的快照时则按该快照检查。若仍需 V0.2.0，应重新安装当前兼容候选，再按保存的清单合并后来配置。

脚本先恢复 feature，再恢复维护入口。若第一阶段失败，维护事务保持原状；若第二阶段失败，保留错误和事务目录，保持 OpenCode 退出，再运行同一 `Restore-Voice.cmd -DryRun` 和 `Restore-Voice.cmd`。匹配已 restored 的 feature 时不会再次覆盖应用或用户配置，只重试维护阶段。重试前不要通过维护启动器打开应用，以免启动检查重新应用插件。

### 4. 指定 feature transaction（高级入口）

只在明确知道事务路径、并且目标版本/哈希已经核对时使用：

```powershell
.\windows\restore-feature-preview.cmd -Transaction "<feature事务目录>" -DryRun
.\windows\restore-feature-preview.cmd -Transaction "<feature事务目录>"
```

这是 `install-feature-preview.ps1 -Restore` 的 PowerShell 封装。该脚本的公开参数是 `-AppPath`、`-VoiceHome`、`-RuntimePath`、`-BackupRoot`、`-MaintenanceRoot`、`-PythonPath`、`-Transaction`、`-Restore` 和 `-DryRun`；不要把内部 CJS 的 `--app`、`--input`、`--home` 等参数当作 PowerShell 参数。已接管的 V0.2.0 安装优先使用 `Restore-Voice.cmd`，避免只回退 ASAR 而留下不匹配的后台或快捷方式。

旧版 `restore-oc-mic.cmd` 只适用于未被受管维护入口接管、并且能明确核对其旧 manifest 的安装。不要用它跨版本覆盖，也不要手工调用 `shared\install-support.cjs` 的内部参数；不确定时停止并保留当前应用。

## macOS 完整应用恢复

Mac 以完整 `.app` 为备份单位。先关闭 OpenCode，执行只读匹配检查：

```bash
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app --dry-run
```

确认输出中的版本、app.asar 源哈希和完整 bundle 备份匹配后，才执行：

```bash
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app
```

脚本会校验完整 bundle、资源和 manifest；不匹配时拒绝交换。候选 ad-hoc 签名不等于官方 Developer ID/公证。官方更新替换 `.app` 后，旧候选不能直接恢复到新包，应重新运行与新包匹配的 apply；当前 Windows 更新恢复能力不覆盖 Mac。

## 恢复后的检查和记录

```text
版本：V0.2.0
平台 / OpenCode 版本：
恢复入口：Restore-Voice / restore-feature-preview / macOS restore
DryRun 结果：PASS / FAIL
匹配的版本、ASAR 或 bundle 哈希：
恢复事务（脱敏）：
后来配置是否已另存：是 / 否
恢复后启动和服务：PASS / FAIL / 未测
合并回来的配置项：
证据索引：
```

恢复失败时不要删除事务目录或重复覆盖当前包。保留错误、manifest、哈希和当前应用状态，按 [Windows bug 说明](windows-bugs-v0.2.0.md) 或 [真实环境清单](manual-validation.md) 记录。
