# QQ-Agent Core（`packages/qq-agent-core`）

`qq-agent-core` 是养鱼 Bot 的对话与记忆核心引擎。它既可由 `cloud-manager` 以无头（Headless）子进程方式多租户托管，也可作为独立 Web 服务或 Windows Electron 桌面应用单独运行。

## 核心设计

### 事件驱动 + 无状态单轮会话（低成本可控）
1. 群聊/私聊消息实时写入本地存档（带时间与已读标记），不立即全量喂给大模型。
2. 满足唤醒条件（1～4 档：仅 `@` / 关键词 / 概率插话 / 全量判断）时，开启一次**独立短会话**：`静态系统提示词 + 近期上下文摘要 + 本轮未读消息`。
3. 单轮回复完毕即销毁会话，Token 消耗恒定可控，不随群聊历史无限膨胀。
4. 跨会话的群友性格、梗与偏好通过**长期记忆工具**持久化并在后续对话按需注入。

### 主要能力
- **QQ + B 站双通道路由**：通过 `ChannelRouter` 按数字 ID 区间同时连接 QQ（NapCat / LLBot / SnowLuma）与 B 站（`protocol-bili-bridge`）OneBot v11 服务。
- **拟人互动与角色卡**：内置“小鲸鱼”人设，支持分群人设、表情包收发、主动话题、临时禁言指令及 SillyTavern JSON/PNG 角色卡安全导入。
- **多模态与联网**：支持图片/视频理解，内置多款联网搜索适配器（含 SSRF 内网防护）。
- **两类热插拔扩展**：确定性插件（`plugins/`）与大模型工具技能（`skills/`），支持按实例屏蔽与管理员扩展覆盖。

---

## 快速启动

进入本包目录并确保启用 Node 24（独立运行也兼容 Node 20/22+）：

```bash
cd packages/qq-agent-core
npm ci
```

### 方式一：Headless 服务端模式（Linux / 云端推荐）

```bash
export QQ_AGENT_TOKEN="replace-with-console-token"
export QQ_AGENT_DATA_DIR="$PWD/data"   # 可选，默认使用包内 data/
npm run server:headless
```

默认监听 `http://127.0.0.1:3210`（更多参数见 [modules/headless/README.md](modules/headless/README.md)）。启动后连接外部 OneBot v11 协议端（NapCat / LLBot / B 站桥接），配置模型 Key 并勾选白名单群即可对话。

### 方式二：Windows 桌面端模式

```bash
npm run setup        # 自动准备便携版 QQ 与 SnowLuma 协议组件（幂等）
npm start            # 启动 Electron 桌面控制台
```

- 若只希望在浏览器打开单机控制台而不启动 Electron 窗口，可运行 `npm run server`。
- 如需在同一台 Windows 电脑双开第二个实例，参见 [双实例说明](doc/extend_development/multi-instance.md)。
- 如需自行打包免安装便携版 QQ 归档，运行 `npm run pack:qq`（QQ 客户端为腾讯专有软件，再分发前请自行确认许可合规，归档不含任何用户数据）。

---

## 扩展开发速览

扩展放在 `plugins/` 或 `skills/` 下即可加载，统一由 `config.skills[id].enabled` 控制开关：

| 类型 | 目录 | 触发者 | 开发文档 |
|---|---|---|---|
| **确定性插件** | `plugins/<id>/` | 核心代码按 `providers` / `hooks` 条件必然触发 | [plugin-development.md](doc/extend_development/plugin-development.md) |
| **LLM 工具技能** | `skills/<id>/` | 模型根据对话语义自主调用 `registerTool` 工具 | [skill-development.md](doc/extend_development/skill-development.md) |

更多专题参考：
- 零基础入门：[doc/extend_development/skill-guide-for-beginners.md](doc/extend_development/skill-guide-for-beginners.md)
- API 与清单完整参考：[doc/extend_development/skill-reference.md](doc/extend_development/skill-reference.md)
- 扩展架构总览：[doc/extend_development/skill-system.md](doc/extend_development/skill-system.md)
- OneBot v11 接口参数表：[doc/extend_development/snowluma-capabilities.md](doc/extend_development/snowluma-capabilities.md)
- 提示词拼接与视频理解：[prompt-pipeline.md](doc/extend_development/prompt-pipeline.md) · [video-modes.md](doc/extend_development/video-modes.md)

一键生成新技能脚手架：

```bash
npm run new:skill my-skill
```

---

## 常用脚本命令

| 命令 | 说明 |
|---|---|
| `npm run server:headless` | 启动无头服务端入口（支持云端 IPC 就绪回执与双通道路由） |
| `npm start` / `npm run server` | 启动 Electron 桌面端 / 单机 Web 控制台 |
| `npm run setup` / `npm run setup:check` | 下载或检查桌面端便携 QQ 与 SnowLuma 组件 |
| `npm test` | 运行主测试套件（含桌面环境检查、双通道、角色卡、扩展与集成测试） |
| `npm run test:coverage` | 运行离线模块、HTTP 接口、E2E、UI 与接线五组覆盖测试 |
| `npm run test:headless` | 运行 Headless 运行时与协议传输测试 |
| `node scripts/sanitize-release.mjs --dry-run` | 分发副本前检查/清空本地密钥、白名单与聊天存档 |

## 致谢与许可证

- 源自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 与 [ZASENJC/QQ-agent](https://github.com/ZASENJC/QQ-agent)（Kondius）。
- 本包代码以 **MIT** 许可证发布（见 [LICENSE](LICENSE)）；第三方协议组件与 QQ 客户端分别受其各自许可条款约束。
