# 恢复安装前状态

安装器保留应用与维护配置的备份。恢复用于撤回桌面补丁，并将受备份管理的文件还原到对应快照。

**Windows 恢复可能覆盖安装后修改的语音设置和运行时文件。** 开始前请另存当前配置和凭据文件，或导出词表。恢复后需要的设置可重新填写或合并。恢复不会删除模型、聊天记录、工作区或 Python 环境。

## Windows

保存工作并完全退出 OpenCode。使用已安装维护目录中的恢复入口；它会读取安装时保存的备份信息。

先检查：

```powershell
$VoiceMaintenance = Join-Path $env:USERPROFILE '.config\opencode\voice-maintenance'
& (Join-Path $VoiceMaintenance 'Restore-Voice.cmd') -DryRun
```

检查通过后执行：

```powershell
& (Join-Path $VoiceMaintenance 'Restore-Voice.cmd')
```

脚本会恢复桌面补丁和维护入口。重新打开 OpenCode 后，如果快照是官方原包，“语音输入”设置与麦克风按钮会消失；若快照包含旧插件，则恢复其对应功能。

若应用恢复成功、维护入口恢复失败，请保持 OpenCode 退出，重新执行同一组检查和恢复命令。匹配到已恢复的应用时，脚本只重试维护阶段。此时先不要通过维护启动器打开应用，以免它再次应用插件。

高级用法：需要指定补丁备份时，可在源码目录执行以下命令。受维护安装优先使用前面的完整恢复入口。

```powershell
.\windows\restore-feature-preview.cmd -Transaction "<备份事务目录>" -DryRun
.\windows\restore-feature-preview.cmd -Transaction "<备份事务目录>"
```

## macOS

macOS 备份和恢复以完整 `.app` 为单位。退出 OpenCode 后，在源码目录执行：

```bash
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app --dry-run
bash macos/restore-oc-mic.sh --app /Applications/OpenCode.app
```

恢复会检查应用版本、包内容和备份清单。官方更新后，应使用与当前应用匹配的备份；旧应用备份不能作为跨版本修复包。

## Linux

退出 OpenCode 后，对原来的可写解包目录执行：

```bash
bash linux/restore-oc-mic.sh --app /path/to/unpacked/OpenCode
```

Linux 恢复入口会在写入前检查匹配的备份，目前没有单独的 `--dry-run` 选项。

## 恢复被拒绝时

应用仍在运行、版本或哈希不匹配、应用结构不支持、备份缺失时，脚本会停止。保留当前应用与备份目录，记录错误信息，不要手动用历史 `app.asar` 覆盖当前版本。

如果目标只是让更新后的插件重新出现，先使用 [更新指南](update-survival.md) 中的修复入口。恢复失败或找不到匹配备份时，可在 [Issues](https://github.com/ForrestKang/opencode-local-voice/issues) 中提供操作系统、OpenCode 版本、安装方式和脱敏错误信息。
