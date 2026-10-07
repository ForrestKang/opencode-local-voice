# 0.2.1 原生设置修正与本地验证

日期：2026-10-06。基线 commit：`52d599771e38758361ee3b3953654cd7845642db`。代码在本地工作区，未提交或推送。0.2.0 的历史验证记录保留在 [原报告](validation-v0.2.md)。

## 最终界面位置

入口为 **OpenCode 设置 → 语音输入**，与“通用”“快捷键”同级，排在“快捷键”后。新版和旧版设置布局均注册真正的原生 Tabs Trigger/Content，值为 `voice-input`。原生 Tabs 负责选中状态、上下键切换、ARIA 关联、延迟挂载与面板滚动。

设置内容使用原生面板标题、分组、设置行及主题变量，包括麦克风、最长录音、预热、后端、设备、本地模型路径、语言、提示词、解码宽度、CPU 线程和空闲释放。输入框保留录音操作，移除了设置齿轮与独立语音 dialog；没有创建语音设置网站。

Web 个人脚本继续提供录音与草稿写入，读取同一服务配置；它不修改 Web 服务器的前端 bundle。共享配置可在桌面原生设置保存，或编辑 config.json 后重启服务。

## 当前验证结果

Windows 11，Node 24.15.0、隔离 Python 3.12.10/NumPy 2.2.6、Playwright 1.63.0/Chromium 153.0.8010.12。没有安装或运行真实识别模型。

| 检查 | 结果 | 范围 |
|---|---|---|
| Node 回归 | 35/35 PASS | 客户端、鉴权、取消、TUI、安装/恢复，以及原生设置注册、重入、未知或重复布局拒绝 |
| Python 回归 | 26/26 PASS | HTTP、配置、队列、识别替身进程、取消、跨语言联测、发行包清单 |
| 合成录音界面 | 10/10 PASS | 真实 MediaRecorder 合成波形、WAV、草稿保护、取消/重试，以及宿主面板内的表单读写与重开 |
| 实际 ASAR 原生设置隔离运行 | 10/10 PASS | 新旧布局各 5 项：同级标签、原生键盘和 ARIA、持久化、服务错误恢复、关闭后的迟到响应、窄窗口；导航保持在内容左侧 |
| 源码与类型 | PASS | 20 个 JS 文件语法、平台 renderer 一致、CI YAML、TUI TypeScript |
| 真实 ASAR 候选与重补丁 | PASS | 1.18.33 的 6,953 个 packed/hashed 文件校验通过，重补丁字节一致，安装文件未改动 |

合计 **81 项自动化用例通过，0 失败**。日志：`test-results/all-tests-v0.2.1.txt`、`native-settings-v0.2.1.txt`；明细：`ui-report.json`、`native-settings-report.json`。原生设置亮/暗色截图：`native-settings-v2-light.png`、`native-settings-v2-dark.png`，旧版布局也分别保存。

原生浏览器测试从实际 ASAR 读取 DialogSettings 编译体、Solid/Kobalte Tabs 实现以及原生样式，在隔离浏览器中运行。应用 Provider、非语音设置内容、外层对话框壳和识别接口使用测试替身，未启动或操作实际 OpenCode 窗口。因此这里的 PASS 不等于真实安装后的完整应用验收。

## 只读 ASAR 证据

输入是实际安装的 OpenCode 1.18.33，候选只写到临时目录。

- 输入前后 SHA256：`2936b47306ceed19e5a3596a6337ed354ee8caebe34e476ecde095778174b248`
- 候选与重补丁 SHA256：`86b91b85b42b65124293c6fdf0b87e3e3149f9e4a4cda81a3660b718d3b4bb17`
- 新版原生设置：`out/renderer/assets/index-Bn0VJlx3.js`
- 旧版原生设置：`out/renderer/assets/dialog-settings-DmYK2SOV.js`
- 证据文件：`test-results/native-asar-report-v0.2.1.json`

发现唯一的新旧设置组件后才构建；缺失、重复、未知或受管理标记损坏时中止。所有修改的 bundle 经过 JS 语法和 ASAR integrity 校验。

## 复现与交付

完整源码候选包内运行 `npm ci`，准备 `requirements-test.txt` 与 Chromium 后执行 `npm run test:all`。

读取自己安装的受支持 ASAR 做原生组件隔离验证（PowerShell）：

```powershell
$env:OC_VOICE_NATIVE_ASAR = 'C:\path\to\OpenCode\resources\app.asar'
npm run test:native-settings
```

该测试只读输入 ASAR，内存中构建候选，隔离运行组件，并检查输入文件哈希未变。应用自己的业务 Provider 和真实识别服务不参与这个测试。

0.2.1 source/windows/macos/linux 候选 ZIP 各附 `CONTENTS.sha256`，外部 `SHA256SUMS.txt` 给出归档哈希。打包排除实际应用包、测试输出、个人配置、凭据、模型和个人 Web 脚本。0.2.0 的候选 ZIP 仍保留，当前应使用 0.2.1。

真实应用安装、实体麦克风、GPU/Metal 推理速度、macOS/Linux 实机与安装恢复留给用户，按 [手工验收清单](../manual-validation.md) 检查。本轮没有替换实际 OpenCode 安装、关闭或重启应用。
