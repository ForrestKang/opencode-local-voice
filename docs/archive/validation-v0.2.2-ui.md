# 0.2.2 原生设置 UI 预览验证

以下记录首次 UI 候选生成时的验证状态。之后已部署到本机，用户认可界面并反馈打开设置会弹出终端；该后续修复与最新验证见 [Windows 终端修复记录](windows-terminal-fix-v0.2.2.md)。

本候选独立位于 `LOCAL_FROZEN_CANDIDATE`，从 0.2.1 冻结源码包建立。基线 ZIP 的 SHA256 为 `d3aa31f0bce5680b79a6a9a8e77e700d9019da7a16b1ae9b88b01b66d8af90e3`，69 个原文件的清单已核对，没有缺失。识别服务、配置协议、Desktop/Web 通信桥、TUI、依赖与原安装/恢复核心保持基线。

本轮仅修改设置 UI。词表、标点/空格规则、模板、可选 AI 改写和新增快捷键的下一阶段开发，等待用户本机测试并同意。

## 原生组件和样式

“语音输入”位于 OpenCode 设置中，与“通用”“快捷键”同级。设置面板直接使用实际安装包导出的 Solid 控件：`SettingsRowV2`、`SettingsListV2`、`SelectV2`、`Switch`、`TextInputV2`、`TextField`、`ButtonV2`。标题、分组、分隔线和布局使用宿主设置类名。

常用输入选项在前，识别后端、设备与模型目录在下一组。高级识别参数默认折叠。保留原有保存、重新读取、预热行为，麦克风选择仍为客户端本地设置。打开设置只枚举设备，不请求麦克风录音权限。

实际 OpenCode 1.18.33 的 renderer 全局加载 `main-C-FJvlHS.css`。新版设置通过 Vite 预加载 `row-C1keQ7td.css` 与 `index-BobfRPag.css`；旧版设置缺少 V2 Row/Switch 的样式预加载。因此新语音模块按实际资产内容发现原生 Switch 样式，并以绝对 URL 去重加载该宿主 CSS。所有宿主 CSS 保持原字节，不加入自制控件样式；缺失或重复匹配时拒绝生成候选。

## 自动检查

| 检查 | 结果 | 范围 |
|---|---|---|
| Node 回归 | 36/36 PASS | 通信、鉴权、取消、TUI、安装恢复、原生组件绑定与未知布局拒绝 |
| Python 回归 | 26/26 PASS | 沿用识别服务的配置、队列、取消、HTTP 与跨语言客户端联测 |
| 合成录音界面 | 10/10 PASS | WAV 转换、草稿保护、取消、重试、录音权限恢复、麦克风选择 |
| 实际原生设置隔离运行 | 12/12 PASS | 新旧设置各 6 项，控件与原生 Tabs、保存、重开、错误恢复及窄窗口 |
| 源码与类型 | PASS | 21 个 JS 文件语法、平台 renderer 一致、CI YAML、TUI TypeScript |
| 最终补丁专项复核 | 11/11 PASS | 原生样式发现、缺失/歧义拒绝、重补丁与安装恢复 |
| 真实 ASAR 候选 | PASS | 6,954 个 packed/hashed 文件，重复补丁字节一致，安装文件未改 |

自动化用例共 84 项通过；11 项补丁专项复核为其中相关用例的再次检查，不重复计入总数。明细位于候选工作区 `test-results`：`node-ui-only.txt`、`node-patch-final.txt`、`python-ui-only.txt`、`ui-report.json`、`native-settings-report.json`。

原生设置预览从实际安装 ASAR 读取组件、Solid/Kobalte 运行时和原生样式，在隔离的 Chromium 中渲染。应用业务 Provider、非语音设置页、外层对话框壳、配置接口和设备列表使用测试替身。截图中的服务状态与模型目录是示例值。这里没有启动或替换实际 OpenCode，没有使用真实麦克风，也没有测量 GPU 推理速度。

隔离预览沿用宿主 `data-color-scheme` 的浅色/深色 token 和 ASAR 内的字体；明暗主题截图等待原生过渡结束。设置入口与语音组件从同一模块 URL 导入 Solid，卸载后的迟到配置读取不再发出事件。菜单使用原生默认定位与翻转：测试外壳改为固定布局，避免 Portal 新增节点改变对话框位置。真实鼠标展开再关闭不会改变配置；较矮窗口中设备菜单可正常选择。

## ASAR 差异证据

- 应用版本：1.18.33。
- 安装包前后 SHA256：`86b91b85b42b65124293c6fdf0b87e3e3149f9e4a4cda81a3660b718d3b4bb17`。
- 最终 UI 候选及重复补丁 SHA256：`e43d07dee834db5509dfa88684fee82138011bf2e6ce04b342ff51dd1014a8bf`。
- 仅改变两个原生设置 JS 模块与 `out/renderer/oc-voice-v2.js`，新增 `out/renderer/oc-voice-native-settings.js`；main/preload 和原生 CSS 没有改变。
- 逐项证据：`test-results/native-asar-report-v0.2.2.json` 与 `baseline-comparison.json`。

本轮没有提交、推送或覆盖安装。候选归档包含 `CONTENTS.sha256`；不包含安装包、模型、个人配置、token、node_modules 或测试输出。

## 用户本机验收

按 [UI-TEST.md](../../UI-TEST.md) 保存工作并退出 OpenCode，运行 `windows/install-ui-preview.cmd` 后重新打开。该入口仅应用 UI 补丁，自动保存版本/哈希绑定备份。真实桌面运行、明暗主题、窄窗口与实体麦克风由用户测试确认；通过后再进入下一阶段开发。

预览：

- [浅色](../previews/native-settings-v2-light.png)
- [深色](../previews/native-settings-v2-dark.png)
- [高级设置](../previews/native-settings-v2-advanced.png)
- [原生下拉框](../previews/native-settings-v2-model-dropdown.png)
