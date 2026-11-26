# PG / AI Studio 流式抗截断（TauriTavern 扩展 v1.5.0）

专为 **TauriTavern（桌面端 & 手机端安卓/iOS）** 的 **Google AI Studio / Playground (`makersuite`)** 渠道打造的纯前端零依赖流式抗截断扩展。

## 核心功能

1. **真流式 + 截断自动无感接力（默认推荐）**
   - 自动将小猫（`Meowssiah` / `soliumbra_reply`）、`4ACH`（`response_body`）、`图灵 4A/4C`（`actual_content`）、`小猫 Reborn`（`game_content`）、《莱莎的秘密工坊》（`ryza_reply`）等阻塞型工具预设转为原生 `responseSchema` 结构化真流式输出，完整保留高达 **91%** 的隐式上下文缓存并大幅缩短首字等待时间。
   - 若高尺度剧情中途触发上游 `PROHIBITED_CONTENT` / `SAFETY` 安全截断，或出现 **“只吐思维链、正文 0 字却静默提前结束”**，**不断流、不乱闭合标签**，后台自动切换原生 `functionCall` 抗截断通道无感续写/补全剩余正文与状态栏变量更新，去重拼接回同一条消息。
   - 极短规划截断（未进正文）自动切原工具全量回退并无损闭合拼接；内置接力独立超时保护（失败或超时自动闭合残余标签、完整保留已输出前文并停留提示可点「继续」续写）。
2. **原生函数抗截断模式**
   - 可随时在「传输模式」切为 **原生函数抗截断（整段稳出，不流式）**，保留原工具调用并叠加 Gemini 4 思考档位桥接与超限参数修复。
3. **PG 思考强度双轨控制 & 预设防崩溃保护**
   - 自动桥接 TauriTavern 预设中的原生思考强度（含 `low`/`medium`/`high`/`xhigh`）到 `gemini-4-*`，自动清理 37 个常见预设残留的无效占位 `reasoning_effort: none` 并兼容 `SPreset` 与 `omission.js`，想低思考提速或高思考深思均可自由切换。
   - 自动修正预设附加参数里的 `reasoning_effort: max`（防止反代报 400）及真实模型输出上限（`gemini-4-carbon`/`argon` 压至 `32768`，`gemini-4-neon`/`2.5`/`3` 压至 `65535`），完整支持 YAML、JSON 与尾逗号 JSON。
4. **手机端体验与全场景兼容**
   - 聊天界面**顶部居中悬浮轻提示胶囊**（适配刘海屏安全区，彻底避开右下角小猫悬浮球、4ACH 悬浮条与底部输入法）：首字等待超 12 秒平滑提示思考/上下文体量，首字到达立刻隐藏。
   - 声明 `loading_order: 0` 与 `hooks.update` 更新钩子（手机端点击「更新扩展」后自动提示刷新加载新版，避免旧内存滞留）；与 `SPreset`、`vertex-streaming-anti-truncation`、`JS-Slash-Runner`、`LittleWhiteBox`（小白X）、`st-memory-enhancement` 和平共存，精准隔离 `quiet`、`impersonate` 与后台记忆整理请求。
   - 支持自定义标签截停（含豁免块与 `~` 标签名，如 `konatan_planning~`）。

## 安装方法

### 方式一：手机端 & 桌面端一键 Git 安装（推荐）
1. 打开手机端或桌面端 **TauriTavern** → **扩展程序** → **安装扩展**。
2. 填入仓库地址：`https://github.com/hozhuki123-design/pg-streaming-anti-truncation`（分支留空）。
3. 点击安装并重启酒馆即可；后续有更新时在扩展列表里点「更新扩展」，按提示刷新即可生效。

### 方式二：离线目录 / ZIP 手动安装
1. 将插件文件夹 `pg-streaming-anti-truncation` 完整放入 TauriTavern 数据目录：
   - 桌面端：`%APPDATA%\com.tauritavern.client\data\default-user\extensions\pg-streaming-anti-truncation\`
   - 手机端：`data/default-user/extensions/pg-streaming-anti-truncation/`
2. 完全重启 TauriTavern。

## 推荐配置

安装重启后，打开 **API 连接 → Google AI Studio (`makersuite`)**，拉到最下方找到 **「PG / AI Studio 真流式抗截断」**：
- **传输模式**：`流式抗截断（真流式 + 自动接力，推荐）`
- **PG 思考强度**：默认选 `跟随预设默认（自动桥接并防报错）`（你在酒馆预设切低/中/高思考都会自动生效）；也可直接在此处手动覆盖档位。
- 确保酒馆原生的 **「流式传输」** 开关处于勾选状态。

## 开发者本地自测

需要 Node.js 20+：

```bash
node test/pg-streaming.test.mjs
```
