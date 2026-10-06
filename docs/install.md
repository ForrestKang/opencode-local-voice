# 安装 OpenCode Local Voice（给 AI Agent 的说明）

你是一个能执行命令的 AI 编码助手。请按以下步骤帮用户在本机安装 OpenCode Local Voice。

## 0. 前置判断

- 操作系统必须是 **Windows** 或 **macOS**（暂不支持 Linux）
- 需要用户已安装 **OpenCode 桌面版**（Electron GUI 版）
- 依赖：**Python 3.10+** 与 **Node.js**（缺失时先帮用户安装）

## 1. 获取代码

```bash
git clone https://github.com/ForrestKang/opencode-local-voice
cd opencode-local-voice
```

> 也可以从 [Releases](https://github.com/ForrestKang/opencode-local-voice/releases) 下载对应平台的 zip 包解压使用。

## 2. 执行平台安装脚本

**Windows**：

```powershell
cd windows
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**macOS**：

```bash
cd macos
chmod +x *.sh
./install.sh
```

可选参数（低配机器/省磁盘）：

- Windows：`-Model small`、`-Cpu`、`-SkipModel`
- macOS：`--model small`、`--no-apply`

安装脚本会：建 Python 虚拟环境 → 安装 faster-whisper → 下载模型（约 1.6GB，可从 hf-mirror 续传）→ 部署本地识别服务 → 给 OpenCode 桌面版打补丁 → 自动重启应用。

## 3. 验证

1. 安装脚本结束应输出成功信息，OpenCode 会自动重启
2. 请用户确认：输入框工具栏的**发送键左侧出现麦克风按钮**
3. 让用户点一下麦克风说句话，再点一下 → 文字应出现在输入框

## 4. 排障

安装或使用失败时，读取并分析以下日志后再决定下一步：

- 渲染层：Windows `%TEMP%\oc-mic-debug.log`；macOS `$TMPDIR/oc-mic-debug.log`
- 识别服务：`~/.config/opencode/whisper/stt_server.log`
- 补丁失败时：重新运行 `patch-oc-mic.js`（或 apply 脚本）会打印明确的失败原因，**不会破坏已安装的应用**

## 5. 注意事项

- 识别全程本地运行，不上传音频；模型首次下载需要网络
- macOS 首次使用会弹麦克风授权，请让用户允许（系统设置 → 隐私与安全性 → 麦克风）
- OpenCode 桌面版更新后补丁会被覆盖：重新执行 apply 脚本（`apply-oc-mic.cmd` / `apply-oc-mic.sh`）即可恢复
- 需要还原官方版：运行 `restore-oc-mic.cmd` / `restore-oc-mic.sh`
