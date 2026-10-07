# OpenCode 更新后的插件恢复

桌面集成修改了 OpenCode 的应用包，官方更新会替换这些文件。V0.2.0 在 Windows 中加入更新交接和启动检查；恢复前会验证新版本是否兼容。

## Windows

通过安装器维护后的桌面、开始菜单或任务栏快捷方式启动 OpenCode，并使用应用内的官方更新入口。

更新准备阶段会安排一次性恢复任务。官方安装器完成并退出后，恢复任务等待新应用包稳定，检查版本与结构，再为新包应用语音补丁并重新启动 OpenCode。下载和安装由官方更新器完成。

模型和配置位于应用目录外，更新后继续复用。遇到不兼容的新结构、管理员安装或备份校验失败时，恢复会停止；应获取适配后的插件版本再安装，避免用旧包覆盖新版本。

### 语音入口没有恢复

1. 完全退出 OpenCode。
2. 在已安装的维护目录中检查状态：

```powershell
$VoiceMaintenance = Join-Path $env:USERPROFILE '.config\opencode\voice-maintenance'
& (Join-Path $VoiceMaintenance 'Repair-Voice.cmd') -Check
```

3. 检查无错误时，运行同一目录的修复入口，再查看设置和麦克风按钮：

```powershell
& (Join-Path $VoiceMaintenance 'Repair-Voice.cmd')
```

这些命令使用安装时保存的维护配置。若维护目录不存在，请按 [安装指南](install.md#windows) 重新安装；若检查提示不兼容或文件不匹配，请保留错误并提交 Issue。

直接运行 `OpenCode.exe` 或未经维护的第三方启动入口，可能绕过启动检查。更新器重建快捷方式后也可能需要重新应用插件。

### 点击更新时报错

V0.2.0 修复了 Electron 将存在的 `app.asar` 误判为缺失的问题。旧版出现 `current app.asar is missing` 时，请退出应用并安装新版插件；这条提示本身不足以判断物理文件是否丢失。不要用旧版本的 `app.asar` 覆盖刚更新的 OpenCode。

## macOS

官方更新会替换完整 `.app`，目前需要手动重新应用兼容补丁。更新完成、退出 OpenCode 后执行：

```bash
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app --dry-run
bash macos/apply-oc-mic.sh --app /Applications/OpenCode.app
```

桌面适配为实验性，签名与系统权限的影响见 [安装指南](install.md#macos)。

## Linux

更新完成后，对新的可写 Electron 解包目录重新应用补丁：

```bash
bash linux/apply-oc-mic.sh --app /path/to/unpacked/OpenCode --dry-run
bash linux/apply-oc-mic.sh --app /path/to/unpacked/OpenCode
```

Web、TUI 和 CLI 使用应用包之外的本地服务。升级这些适配器时，更新源码和运行环境；Web Origin 或凭据改变后需要重新生成个人脚本。

需要撤回桌面补丁时，使用 [恢复指南](recovery-v0.2.0.md)。
