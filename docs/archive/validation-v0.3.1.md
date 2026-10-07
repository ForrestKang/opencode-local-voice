# 0.3.1 录音快捷键修复验证

基于冻结的 0.3.0 源码 ZIP 独立修复。旧版本可复现页面焦点下 Enter 被忽略；真实已安装 ASAR 与原共享 renderer 逐字节一致。宿主 Dialog/Popover 在 window capture 调 stopPropagation，原 document capture 收不到 Esc。

修复采用 window capture，允许当前录音在页面焦点丢失后结束或取消；每次按键重新定位输入表单。设置模态窗口、其他输入字段、中文输入法、组合键、长按和普通空格保留各自行为。

- Node 49 项、Python 52 项通过。
- 合成录音浏览器 23 项通过，包含页面失焦、工具栏/表单替换、宿主 document/window 捕获、compositionend 拦截；检查轨道 ended、取消后草稿保留与不自动发送。
- 原生设置隔离浏览器 24 项通过。控件和样式来自实际 ASAR，应用 providers 与设置外壳使用测试替身。
- ASAR 6954 个文件完整性、5 个主脚本解析、重复补丁一致性通过；原件未改。候选 SHA256：765a01d445ea601626a23d96151041ca23bfa0f9df1dfa1ddc1414ff14e255ee。
- 本机现有 venv 的 pythonw 冷启动通过，无新增终端、无控制台窗口，父进程退出后服务仍可用；没有加载模型。
- JavaScript、TypeScript、PowerShell 语法检查通过。

完整证据在本目录外的 test-results；源包不含 ASAR、用户数据、密钥、模型或测试日志。真实麦克风、语音识别速度与最终本机按键验收由用户执行。安装另行记录于 deployment-v0.3.1.json，不以候选检查代替安装证明。
