# 0.2.0 候选版本地验证报告

此文件保留 0.2.0 的历史验证记录。原生设置接入已在 0.2.1 修正；当前交付与验证见 [0.2.1 报告](validation-v0.2.1.md)。

日期：2026-10-06。修整基线 Git commit：`52d599771e38758361ee3b3953654cd7845642db`。当前改动保留在本地工作区，未提交或推送；候选包的 `CONTENTS.sha256` 标识交付的具体文件内容。

修整前保存了原工作区的已跟踪文件、已有未提交补丁和 BASE_COMMIT。原先国内镜像下载与官方回退的功能保留，并修复了 Hugging Face endpoint/导入缓存问题。

## 本地环境与结果

Windows 11（10.0.26200），Node 24.15.0，Python 3.12.10。最终全套测试使用单独 `.venv-test`，仅安装测试依赖 NumPy 2.2.6；没有安装推理或 CUDA 运行库。TypeScript 7.0.2；Playwright 1.63.0 / Chromium 153.0.8010.12。

| 验证 | 结果 | 范围 |
|---|---|---|
| Node 回归 | 33/33 PASS | Desktop/Web协议客户端、身份校验、并发启动、窗口取消隔离、TUI合成FFmpeg与宿主API、补丁/恢复、安装服务预检、镜像回退 |
| Python 回归 | 26/26 PASS | 真实HTTP、受限配置/队列/结果、进程持久化、可终止fake推理、配置提交竞态/失败、空闲停服、CLI时间限制、Node真实HTTP联测、个人Web配对、发行包清单 |
| 浏览器交互 | 10/10 PASS | 合成音频通过真实MediaRecorder、WAV转换、设置保存、Enter/Esc、失败重试、权限错误、取消迟到结果、会话切换、IME、提及节点与草稿保护 |
| 源码检查 | PASS | 19个JavaScript文件、共享渲染器一致性、CI YAML结构、TUI TypeScript类型检查 |
| 平台脚本 | PASS | 3个PowerShell Parser检查，6个Bash独立`bash -n`检查，Python compileall，Git diff空白检查 |
| 已安装ASAR只读候选 | PASS | OpenCode 1.18.33，6,953个packed/hashed文件，重复补丁字节一致，安装文件哈希未变 |

总计 **69 项自动化用例通过，0 失败**。完整原始日志保存在本机 `test-results/all-tests-final.txt`；浏览器明细和截图为 `test-results/ui-report.json`、`ui-settings-light.png`、`ui-settings-dark.png`。这些运行输出不进入发行包。

## 真实 ASAR 的只读检查

输入为当前已安装的 OpenCode 1.18.33，带旧语音标记的现有包；检查包含迁移旧标记并保留后续代码。仅在临时目录构建候选，没有替换安装文件、关闭或重启 OpenCode。

- 输入前/后 SHA256：`2936b47306ceed19e5a3596a6337ed354ee8caebe34e476ecde095778174b248`
- 候选和重补丁候选 SHA256：`cc3c6639a013db5b0a49e91cd58095ea7aa5efe2cb3cd231c2e1007b1f5ddab7`
- 主线程再次核对了 patcher、desktop bridge、renderer 源文件 SHA256 与 dry-run记录一致。
- 本机完整记录：`test-results/real-asar-report.json`。候选ASAR不放入源码发行ZIP。

## 已覆盖的故障

陌生端口拿不到凭据或录音；Python/FFmpeg启动失败不会造成未处理异常；上传或轮询中断会取消可能已接受的任务；取消先于上传保留短期取消记录。一个窗口关闭不停止共用服务，其他任务继续。

配置改动与任务提交串行；模拟配置写盘失败后磁盘和运行态均保持旧值。安装器先核对并停止本项目空闲服务，再改依赖/配置；陌生或忙碌服务中止。长文件在上传前明确拒绝，不静默丢掉尾部。

补丁重复应用保持字节一致；未知权限布局拒绝；旧标记迁移不删除后续代码；恢复拒绝版本/哈希不匹配。最终manifest提交失败会尝试回滚应用文件。macOS完整bundle摘要覆盖文件内容、路径和symlink目标，单改Info.plist或Mach-O会令恢复拒绝；xattrs、ACL和原签名由完整包复制保留，需要真机验收。

## 验证边界

推理使用fake/injected后端。CUDA DLL搜索、MLX greedy参数、FFmpeg与TUI宿主接口有替身测试，**没有在本轮加载真实Whisper模型或录制实体麦克风**。界面使用接近原生锚点的隔离表单，未在实际OpenCode窗口操作。

macOS签名/fuse/Gatekeeper、Linux安装/音频驱动、Windows实际CUDA推理与驱动兼容尚未实机验证。三系统CI已配置，远端尚未执行；本机Windows通过不代替macOS/Linux运行成功。

这轮移除了重复识别、冷启动串行等待等明确开销，并增加了可观察状态；没有测出真实硬件的提速比例，也不承诺固定秒数。按 [真实环境验收清单](../manual-validation.md) 比较冷/热加载、队列、推理耗时和文字质量。

## 交付与复现

从完整源码 `source-candidate.zip` 或 Git 工作区根目录安装开发依赖后运行；平台ZIP用于安装和真实环境验收：

```bash
npm ci
python -m pip install -r requirements-test.txt
npm run test:all
```

浏览器可用 `OC_VOICE_TEST_BROWSER` 指定已有Chromium，或 `npx playwright-core install chromium` 安装。测试浏览器使用合成波形，不请求真实麦克风。

发行候选包括 source/windows/macos/linux 四个ZIP，各带 `CONTENTS.sha256`；ZIP哈希在相邻 `SHA256SUMS.txt`。打包采用路径/类型白名单并排除个人配置、token、`.personal.user.js`、模型、node_modules与测试输出。安装和恢复命令见 [install.md](../install.md)。
