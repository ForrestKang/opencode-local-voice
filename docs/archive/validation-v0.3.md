# 0.3.0 候选验证

本次从已认可的 0.2.2 源码 ZIP 建立独立候选，原安装在候选构建和测试期间未替换。

| 检查 | 结果与范围 |
|---|---|
| Node 客户端、补丁和恢复 | 49 项通过，包含桌面/Web新路由、任务窗口归属、完整功能事务和失败回滚 |
| Python 服务和文字处理 | 52 项通过，真实 HTTP、spawn worker、模拟识别/本机 AI 端点、词表/模板/密钥保护、取消和队列恢复 |
| 录音与草稿浏览器 | 16 项通过，合成波形；Enter/Esc、IME、Space、AI本地回退、模态设置字段保护、文件提及及陈旧范围拒绝 |
| 原生设置浏览器 | 24 项通过，读取实际 ASAR 的原生控件/标签/主题；应用 providers 与弹窗外壳仍是隔离测试实现 |
| 实际 ASAR 候选 | 6954 个文件完整性哈希通过，主程序/预加载/桥/两套设置 JS 解析通过，重复补丁输出一致 |
| Windows 后台冷启动 | 实际现有 venv 的 pythonw，GetConsoleWindow=0；未新增 WindowsTerminal，启动父进程退出后服务仍可用 |
| 源码与脚本 | JavaScript/TypeScript、CI YAML、PowerShell 和六个平台 Shell 脚本的语法检查通过 |

认可的原 ASAR SHA256：`ad8d5550994c49f681576347c90e0bce1b77c113d733942d40006f8f75a02e10`。候选 ASAR SHA256：`860b0a1dd775eb6af82efd3b7070b18f765a8bd19c65c92ee994c18556386a01`。原件只读构建后哈希未变。

完整证据位于 source 工作目录的 test-results：node-v0.3.txt、python-v0.3-final.txt、ui-report.json、native-settings-report.json、asar-v0.3.json、windows-background-v0.3.json、validation-v0.3.json。测试日志和本机 ASAR 不进入平台发行包。

真实麦克风、个人口音、CUDA/Metal 识别速度、真实外部 AI 结果及 macOS/Linux 真机安装未测试。测试中的设置外壳/焦点限制不等于运行真实 OpenCode 窗口，最终外观与语音效果由用户本机验收。AI 默认关闭，无录音自动发送消息。
