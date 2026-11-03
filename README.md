# 养鱼 Bot（fish）

养鱼 Bot 是一个支持 **QQ 协议 Bot、QQ 官方 Bot、桌宠客户端、B 站只读探索与评论草稿** 的多租户 AI 互动机器人平台。它既可以在云端通过 Web 面板集中托管多个机器人实例，也可以将各核心模块独立运行。

## 核心特性

- **开箱即用的用户工作台**：普通用户只需 **创建实例 → 扫码登录 QQ → 勾选互动白名单与人设 → 绑定模型渠道** 四步即可使用，无需手动配置端口或容器。
- **拟人化群聊与长期记忆**：默认内置“小鲸鱼”人设与 1～4 档响应策略（仅 `@` / 关键词 / 随机插话 / 全量判断），支持表情包、主动话题、群友印象记忆和 SillyTavern（JSON/PNG）角色卡安全导入。
- **四类入口**：QQ 协议与官方 Bot 二选一，桌宠与 B 站可独立启用。桌宠通过设备配对连接云端，复用同一套人设、记忆与模型；B 站探索仅生成日记和待审草稿，审核不自动发布。
- **多租户管理与计费中转**：管理员面板提供运营总览、租户与用户管理、实例级插件分发与屏蔽、平台模型 Relay 额度计费及充值审核。

## 项目组成

仓库包含 5 个独立子包（非 npm workspace，各自独立安装依赖）：

| 目录 | 模块 | 说明 |
|---|---|---|
| `packages/cloud-manager` | 云端管理与 Web 面板 | 多租户进程守护、同源设置 API、OpenAI 兼容计费 Relay，以及零构建原生前端 `panel/`。 |
| `packages/qq-agent-core` | Agent 核心 | 事件驱动的对话引擎、多入口路由（`ChannelRouter`）、记忆系统、插件/技能加载器及单机控制台。 |
| `packages/protocol-qq-llbot` | QQ 协议端（LLBot） | 基于 LuckyLilliaBot 的 QQ OneBot v11 协议服务（支持 Direct / Desktop 模式）。 |
| `packages/protocol-bili-bridge` | B 站协议桥接 | 将 B 站评论、动态、私信与直播间映射为标准 OneBot v11 接口与管理 API。 |
| `packages/desktop-pet` | 大肥鱼桌宠客户端 | Electron 透明窗口、对话框、设备配对、断线补发与系统加密凭据存储。 |

新入口的使用与设计差异见 [多入口实现说明](docs/multi-entry-implementation.md)、[桌宠客户端](docs/desktop-client.md)、[B 站探索](docs/bili-explore.md) 和 [计量接口](docs/billing-meters.md)。

## 快速开始（3 步跑起来）

克隆仓库并进入根目录（Windows 推荐使用 Git Bash）：

```bash
git clone https://github.com/Waitforw1nd/fish-agent.git
cd fish-agent
```

### 1. 准备 Node 24

Windows 可直接使用仓库内置的便携版 Node 24（无需全局安装）；Linux / macOS 请安装对应架构的 Node.js 24+：

```bash
# Windows Git Bash（Linux 若已安装 Node 24+ 可跳过此行）：
export PATH="$PWD/.tools/node:$PATH"
node -v   # >= v24.0.0
```

### 2. 安装依赖

```bash
npm --prefix packages/qq-agent-core ci
npm --prefix packages/protocol-bili-bridge ci
npm --prefix packages/cloud-manager ci

(cd packages/protocol-qq-llbot && corepack yarn install --immutable)
```

> `cloud-manager/panel` 是无框架静态前端，无需安装依赖或构建。若需使用 LLBot 协议端，先执行一次 `npm run llbot:build`。

### 3. 启动服务

**启动完整云端托管面板（最常用）：**

```bash
export CLOUD_HOST="127.0.0.1"
export CLOUD_ADMIN_USERNAME="admin"
export CLOUD_ADMIN_PASSWORD="change-me-strong-password"
npm start
```

启动后浏览器访问 `http://127.0.0.1:8080` 登录面板：
- 管理面板与 API：`http://127.0.0.1:8080`（未设置 `CLOUD_ADMIN_PASSWORD` 且首次启动时，控制台会打印随机初始密码）
- 模型中转 Relay：`http://127.0.0.1:8790/v1`
- 健康检查：`http://127.0.0.1:8080/healthz`

> **提示**：新建实例默认空白名单（`allowAllWhenEmpty=false`）不会对任何群发言，扫码后请在“群聊与白名单”页签勾选允许互动的群。新实例默认使用 NapCat（需宿主机配置 Docker 镜像，见 `deploy/napcat/README.md`），也可切换为 LLBot。

<details>
<summary>单独启动单个子包（本地调试用）</summary>

- **QQ-Agent 核心（Headless 模式，默认 `http://127.0.0.1:3210`）**：
  ```bash
  cd packages/qq-agent-core
  export QQ_AGENT_TOKEN="replace-with-console-token"
  npm run server:headless
  ```
  桌面 Electron 模式可执行 `npm start`（首次需 `npm run setup` 准备本地便携组件）。

- **B 站协议桥接（默认 `http://127.0.0.1:36501`，HTTP / WS / `/admin/*` 同端口）**：
  ```bash
  cd packages/protocol-bili-bridge
  export BILI_ONEBOT_TOKEN="replace-with-8char-plus-token"
  export BILI_ADMIN_TOKEN="replace-with-12char-plus-admin-token"
  npm start
  ```

- **LLBot 协议端**：
  ```bash
  npm run llbot:build
  mkdir -p var/llbot-dev && cd var/llbot-dev
  node ../../packages/protocol-qq-llbot/dist/llbot.js -q 10001
  ```
  `10001` 替换为实际登录的 QQ 号；Direct 模式需配置有效 `data/auth_token.txt`。

</details>

## 常用检查与测试命令

```bash
npm run check                                       # 检查 Node 版本与各包脚本完整性
npm test                                            # 依次运行 B 站桥接、cloud-manager 与核心主测试
npm --prefix packages/cloud-manager/panel test      # 运行前端面板测试
npm run llbot:check && npm run llbot:test           # 检查并测试 LLBot
```

## 关键概念与数据安全

区分项目中三类不同的凭据，避免混填：

| 凭据名称 | 用途 |
|---|---|
| **Relay Key（`sk-fish-*`）** | 平台自动为每个实例签发，供该实例 Agent 访问平台计费 Relay。 |
| **模型 API Key** | 用户使用“自定义模型渠道”时填写的第三方 OpenAI 兼容服务商 Key（配合 Base URL 与模型名）。 |
| **LLBot `auth_token`** | 仅 LLBot Direct 协议端登录校验所需的平台授权码，既不是模型 Key 也不是 OneBot 连接密码。 |

运行时数据默认存放在 `var/cloud/`（含 `cloud.sqlite`、`master.key` 和 `tenants/<id>/`）及 `packages/qq-agent-core/data*/`。**切勿将真实密钥、Cookie、`master.key` 或账号目录提交到仓库**；备份迁移云端数据时必须同时保留 `cloud.sqlite`、`tenants/` 和 `master.key`。

## 文档导航

- [DEVELOPMENT.md](DEVELOPMENT.md)：技术开发指南（架构图、目录结构、代码修改地图、开发规范）
- [docs/cloud-manager.md](docs/cloud-manager.md)：云端管理器、同源 API、环境变量、套餐与计费细则
- [docs/protocols.md](docs/protocols.md)：QQ / B 站双通道路由、虚拟数字 ID、OneBot 接口与扫码流程
- [docs/extensions.md](docs/extensions.md)：插件（`plugins/`）与技能（`skills/`）开发、管理端分发与角色卡安全
- [docs/testing.md](docs/testing.md)：测试体系、Fake 模块、多租户隔离验证与常见故障排查
- [docs/linux-vps-acceptance.md](docs/linux-vps-acceptance.md)：Linux / VPS 部署与上线验收清单
- [deploy/napcat/README.md](deploy/napcat/README.md)：NapCat Docker 镜像固定与容器环境配置
- [UPSTREAM.md](UPSTREAM.md)：上游代码基线与开源许可证说明
