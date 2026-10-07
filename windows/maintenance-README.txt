OpenCode 本地语音 0.2.0

请通过已接管的桌面、开始菜单或任务栏快捷方式打开 OpenCode。
Repair-Voice.cmd：检查并恢复语音入口，随后启动 OpenCode。
Repair-Voice.cmd -Check：只检查，不修改文件、不启动应用。
Restore-Voice.cmd -DryRun：只验证回退，不修改文件。
退出 OpenCode 后运行 Restore-Voice.cmd：恢复快捷方式及当前版本对应的应用和后台备份。

active.json 指向应用目录之外的稳定发布缓存；无需保留下载 ZIP 或工作区源码。
recovery.log 记录维护错误，不记录语音、聊天或 AI 密钥。
禁止将旧版 OpenCode 的应用备份恢复到新版应用。
直接运行 OpenCode.exe 会绕过启动恢复检查。
未来未知应用布局、需要管理员权限的更新，需要兼容插件版本或人工维护。
本方案没有安装常驻服务或 Windows 计划任务。
