OpenCode Local Voice V0.2.0 — Windows 维护入口

日常使用：通过安装器维护后的桌面或开始菜单快捷方式启动 OpenCode。
语音入口消失：退出 OpenCode，先运行 Repair-Voice.cmd -Check 检查，再运行 Repair-Voice.cmd 修复并启动。
撤回插件：退出 OpenCode，先运行 Restore-Voice.cmd -DryRun 检查，再运行 Restore-Voice.cmd 恢复备份。

恢复可能覆盖安装后修改的语音设置和运行时文件，请先另存当前配置或导出词表。
恢复不会删除识别模型、聊天记录或工作区。
备份须与当前应用版本匹配，请勿用旧版 app.asar 覆盖刚更新的 OpenCode。

直接运行 OpenCode.exe 可能绕过启动检查。不支持的新版结构或管理员安装需要新版适配。
维护工具已保存在本目录，日常启动与修复无需保留下载 ZIP 或源码目录。

安装与更新：https://github.com/ForrestKang/opencode-local-voice
问题反馈：https://github.com/ForrestKang/opencode-local-voice/issues
