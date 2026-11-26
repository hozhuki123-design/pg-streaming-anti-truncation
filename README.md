# PG / AI Studio 流式抗截断（TauriTavern 扩展）

专为 **TauriTavern（桌面端 & 手机端安卓/iOS）** 的 **Google AI Studio / Playground (`makersuite`)** 渠道打造的纯前端零依赖流式抗截断扩展。

## 核心功能

1. **真流式 + 截断自动无感接力（默认推荐）**
   - 自动将小猫（`Meowssiah` / `soliumbra_reply`）、`4ACH`（`response_body`）、`图灵 4A/4C`（`actual_content`）、`小猫 Reborn`（`game_content`）、《莱莎的秘密工坊》（`ryza_reply`）等阻塞型工具预设转为结构化真流式输出，大幅缩短首字等待时间。
   - 若高尺度剧情中途触发上游 `PROHIBITED_CONTENT` / `SAFETY` 等安全截断，**不断流、不乱闭合标签**，后台自动切换原生 `functionCall` 抗截断通道无感续写剩余正文与状态栏变量更新，去重拼接回同一条消息，并在聊天右下角弹出轻提示胶囊（电脑与手机端均清晰可见）。
   - 若开头 0 字即遭 `promptFeedback` 拦截，自动全量回退原始工具通道补发。
2. **原生函数抗截断模式**
   - 可随时在「传输模式」切为 **原生函数抗截断（全程防截断 + 思考提速，不流式）**，保留原工具调用并叠加 Gemini 4 思考档位与超限参数修复。
3. **PG 思考强度双轨控制 & 预设防崩溃保护**
   - 绕过旧版 TauriTavern 对 `gemini-4-*` 思考档位不生效的问题，支持一键设为 **低思考（最快出字，推荐）** / 中 / 高 / 恢复模型默认（对 Gemini 4 自动将不支持的 `minimal` 平滑降档为 `low`）。
   - 自动修正预设附加参数里的 `reasoning_effort: max`（防止反代报 400）及 `max_tokens > 65536`（自动压回 `65535`），完整支持 YAML、JSON 与尾逗号 JSON。
4. **全场景隔离与兼容**
   - `loading_order: 5`，与 `vertex-streaming-anti-truncation`、`JS-Slash-Runner`、`LittleWhiteBox`（小白X）、`st-memory-enhancement` 等扩展和平共存、互不干扰。
   - 自动识别并静默放行 `quiet`、`impersonate`、后台记忆/总结并发请求以及末尾助手预填充预设；「继续（Continue）」模式无缝续接不重套思考块。
   - 支持自定义标签截停（含豁免块与 `~` 标签名，如 `konatan_planning~`）。

## 安装方法

### 方式一：手机端 & 桌面端一键 Git 安装（推荐）
1. 打开手机端或桌面端 **TauriTavern** → **扩展程序** → **安装扩展**。
2. 填入仓库地址：`https://github.com/hozhuki123-design/pg-streaming-anti-truncation`（分支留空）。
3. 点击安装并重启酒馆即可；后续有更新时只需在扩展列表里点「更新扩展」。

### 方式二：离线目录 / ZIP 手动安装
1. 将插件文件夹 `pg-streaming-anti-truncation` 完整放入 TauriTavern 数据目录：
   - 桌面端：`%APPDATA%\com.tauritavern.client\data\default-user\extensions\pg-streaming-anti-truncation\`
   - 手机端：`data/default-user/extensions/pg-streaming-anti-truncation/`
2. 完全重启 TauriTavern。

## 推荐配置

安装重启后，打开 **API 连接 → Google AI Studio (`makersuite`)**，拉到最下方找到 **「PG / AI Studio 真流式抗截断」**：
- **传输模式**：`流式抗截断（真流式 + 截断自动无感接力，推荐）`
- **PG 思考强度**：想最快出字选 `低思考（最快出字，推荐提速）`；按预设自带走选 `跟随预设默认`
- 确保酒馆原生的 **「流式传输」** 开关处于勾选状态。

## 开发者本地自测

需要 Node.js 20+：

```bash
node test/pg-streaming.test.mjs
```
