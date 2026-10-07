# Windows 设置页弹出终端修复

用户在本机确认原生语音设置 UI 基本符合预期，但打开面板会弹出 Windows Terminal。设置面板读取配置时按需启动本地语音服务，旧桌面桥启动 `whisper-venv/Scripts/python.exe`；虚拟环境的控制台启动器再启动底层 Python 时会创建终端，即使第一层已设置 `windowsHide`。

Windows 桌面桥现在选择同一目录、同一虚拟环境的 `pythonw.exe`。保留日志重定向、隐藏启动、进程分离和 `unref`，使服务无窗口启动并保持多个客户端共享的生命周期。无对应无窗口解释器时返回安装不完整的错误；不回退到其他全局 Python。macOS/Linux 解释器选择保持不变。

不能只取消进程分离：真实进程验证发现，这会让 Windows 上的服务随启动它的 Node 进程退出而终止。最终方案已同时验证无控制台和父进程退出后的服务可用性。

本次候选与已展示的原生 UI 包相比，只更改 ASAR 中的 `out/main/oc-voice-bridge.cjs`。原生设置组件、渲染器、应用主入口、预加载脚本和识别服务代码均一致。

## 验证

- 完整 Node 回归：41/41 通过，包括 Windows 无窗口解释器选择、缺失解释器拒绝启动、macOS/Linux 路径和共享服务生命周期。
- JavaScript 源码检查、渲染器同步检查、CI YAML 检查和 TypeScript 检查通过。
- 使用本机已安装的 Python 虚拟环境和真实识别服务代码，在独立临时配置与端口上冷启动；控制台句柄为 0，启动前后 Windows Terminal 进程列表一致。
- 启动服务的 Node 进程退出后，另一客户端仍能通过身份验证读取服务状态；随后仅关闭该隔离服务。
- 真实 1.18.33 ASAR 构建与全部 6,954 个文件完整性校验通过，重复构建字节一致，界面与预加载脚本字节一致。

隔离验证不加载语音模型，也不录音。真实设置页是否符合视觉预期及麦克风录音继续由用户在本机验收。本修复不推进词表、文本规则、AI 改写等后续功能。

## 复现隔离启动验证

在项目根目录执行，替换为当前安装环境的绝对路径：

```powershell
node tools/verify-windows-background.cjs "C:\path\to\user\.config\opencode\whisper-venv\Scripts\python.exe" "C:\path\to\user\.config\opencode\whisper\stt_server.py" "test-results/windows-background-report.json"
```

该脚本使用隔离端口和临时配置，验证结束后关闭自身启动的空闲服务，不改动用户的语音配置与模型。
