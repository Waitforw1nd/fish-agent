# 养鱼 Bot（fish）

养鱼 Bot 由四个可独立运行的包组成：QQ-Agent 核心、LLBot QQ 协议端、B 站 OneBot 桥接，以及多租户 cloud-manager 与原生 Web panel。各包独立安装依赖；根目录提供 `npm test`、`npm run test:all` 和 `npm run check`。

> 本文命令以 Windows + Git Bash 为例。NapCat P1 本地实现和模拟测试不能代替真实验收：VPS SSH 公钥认证受阻，真实容器、扫码、QQ 消息、模型和公网 HTTPS 尚未验证。P2 切换事务和 P3 全量恢复仍未完成。

## 产品目标与当前能力

面向用户的最简目标是：**交钱 → 创建实例 → 登录 QQ → 绑定模型 Key → 开始养鱼**。平台应提供默认的“大肥鱼”人设与合理档位，隐藏协议配置和日常运维；用户在开始养鱼时首次选择允许互动的群，不能默认在所有群开口。提供 QQ 号只能指定要登录的账号，仍需本人用手机扫码或确认登录。

这是产品目标，不代表整条流程已经交付或完成真实账号验收。用户面板的“我的鱼”支持多实例、套餐选择、启停及实例详情中的 QQ 号扫码入口；管理员可通过用户管理查看各用户拥有的实例并为其创建实例。新实例默认使用 NapCat，已配置实例保留原内核；NapCat 需管理员准备 Docker 镜像，LLBot Direct 需有效平台授权。普通用户无需填写协议技术配置。自定义渠道首次配置仍需填写 Base URL、API Key 和模型，充值需管理员审核，并非在线支付自动开通。首次群白名单选择的简化体验、默认人设和档位仍需结合实际产品流程确认。

密钥各有用途：平台会为实例自动签发并配置租户 Relay Key，供 Agent 访问平台 Relay；用户绑定的模型 Key 是自有模型上游的 API Key，当前自定义渠道还需上游地址和模型名。LLBot 的 `auth_token` 则用于 QQ 协议端认证，既不是模型 Key，也不是 Relay Key。平台渠道仍保留现有套餐、额度与 Relay 计费模式；具体配置和充值流程见 [云端管理文档](docs/cloud-manager.md)，QQ 认证见 [协议文档](docs/protocols.md)。

## 文档导航

- [DEVELOPMENT.md](DEVELOPMENT.md)：开发约定、架构、各包命令、二次开发修改地图。
- [docs/protocols.md](docs/protocols.md)：QQ/Bili `ChannelRouter`、数字虚拟 ID、B 站 OneBot/admin/custom actions、LLBot `auth_token` 与真实扫码流程。
- [docs/cloud-manager.md](docs/cloud-manager.md)：云端 API、数据目录、端口、密钥、套餐和计费。
- [docs/extensions.md](docs/extensions.md)：扩展目录、`send.guard`、`message.command`、角色卡安全边界。
- [docs/testing.md](docs/testing.md)：测试/fake 清单、双租户 E2E、故障排查和修改后验证清单。

## 1. 准备便携 Node 24

仓库自带 Node 24，不需要也不应全局安装 Node：

```bash
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
node --version
npm --version
```

对应 Windows 目录是 `E:\bigPeach\fish\.tools\node`。每个新终端都要执行上面的 `export`，不要依赖系统 Node。cloud-manager 启动子进程时默认继承当前 `process.execPath`，也可用 `CLOUD_NODE_PATH` 显式指定 Node 可执行文件。

## 2. 安装依赖

以下命令分别在不同终端或按顺序执行；只写入包内 `node_modules`，不全局安装：

```bash
cd /e/bigPeach/fish/packages/qq-agent-core
npm ci

cd /e/bigPeach/fish/packages/protocol-bili-bridge
npm ci

cd /e/bigPeach/fish/packages/cloud-manager
npm ci

cd /e/bigPeach/fish/packages/protocol-qq-llbot
corepack yarn install --immutable
```

LLBot 使用 `yarn@4.18.0` 和 `nodeLinker: node-modules`，其 `postinstall` 还会安装 `src/webui/FE` 依赖。panel 是无框架、无构建的静态前端，没有依赖安装或构建步骤。

## 3. 各包最短启动路径

### 3.1 QQ-Agent 核心

```bash
cd /e/bigPeach/fish/packages/qq-agent-core
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
npm run server:headless
```

Headless 迁移已落地，入口接入本项目的 QQ/B 站双通道 `ChannelRouter`；上游基线为 ZASENJC `codex/linux-headless-module` 的 0.4（`ca0bec135ec4301b50c50f9279ac96daebedf178`）。Headless 支持 Node 22/24，cloud-manager 本身要求 Node 24；启动前需设置 `QQ_AGENT_TOKEN` 或配置 `server.token`。协议端独立运行，不由 headless 安装或管理。双通道的真实在线表现仍需验收。

默认控制台为 `http://127.0.0.1:3210`。桌面 Electron 入口是 `npm start`，安装/检查便携 QQ 与 SnowLuma 分别用 `npm run setup`、`npm run setup:check`。

首次完整对话还需要：

1. 在控制台填写 OpenAI 兼容 API 的 `baseUrl/apiKey/model`，或使用云端签发的 Relay 配置。
2. 准备 QQ OneBot 协议端，或启用 B 站桥接。
3. 配置 `data/config.json` 中的白名单；`allowAllWhenEmpty` 默认是 `false`，空白名单不会自动放开所有会话。

核心默认数据目录是包内 `data/`。可用 `QQ_AGENT_DATA_DIR` 重定向；`QQ_AGENT_PROFILE=2` 使用 `data-2/` 并把默认端口组偏移 `+100`，`QQ_AGENT_PORT` 可单独覆盖控制台端口。

### 3.2 LLBot

先构建，再从专用实例工作目录启动：

```bash
cd /e/bigPeach/fish/packages/protocol-qq-llbot
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
npm run build

mkdir -p /e/bigPeach/fish/var/llbot-dev
cd /e/bigPeach/fish/var/llbot-dev
node /e/bigPeach/fish/packages/protocol-qq-llbot/dist/llbot.js -q 10001
```

`10001` 只是格式示例，应替换为预期登录的 5–12 位 QQ 号。Direct 模式在扫码前需要有效 `data/auth_token.txt`，也可以先启动 WebUI，再通过其 API 录入；完整流程见 [LLBot auth_token 和真实扫码](docs/protocols.md#5-llbot-auth_token-与真实扫码流程)。不要把示例 QQ 号或 token 当作可用凭据。

### 3.3 B 站桥接

```bash
cd /e/bigPeach/fish/packages/protocol-bili-bridge
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
export BILI_BRIDGE_DATA_DIR="E:/bigPeach/fish/var/bili-bridge"
export BILI_ONEBOT_TOKEN="replace-with-a-long-onebot-token"
export BILI_ADMIN_TOKEN="replace-with-a-different-admin-token"
npm start
```

独立桥接默认在 `127.0.0.1:36501` 同端口提供 HTTP action、正向 WebSocket 和 `/admin/*`。`BILI_ONEBOT_TOKEN` 至少 8 字符，`BILI_ADMIN_TOKEN` 至少 12 字符，二者不能相同；未设置 admin token 时管理 API 返回 503。扫码通过 `POST /admin/login/qr` 创建，再由 B 站 App 扫码并轮询状态。

若直接连接核心，核心 `channels.bili.wsUrl` 与 `channels.bili.httpUrl` 必须都指向这个实际端口。核心独立默认的 `3101/3100` 是分离示例端口，不能直接套到桥接的 `36501`；cloud-manager 会为每个租户动态分配同端口并自动写回配置。

### 3.4 cloud-manager + panel

启动管理器；使用 LLBot 时需先构建 LLBot，使用默认 NapCat 时需由管理员准备目标 Linux 主机的 Docker 镜像：

```bash
cd /e/bigPeach/fish/packages/cloud-manager
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
export CLOUD_DATA_DIR="E:/bigPeach/fish/var/cloud"
export CLOUD_HOST="127.0.0.1"
export CLOUD_ADMIN_USERNAME="admin"
export CLOUD_ADMIN_PASSWORD="replace-with-a-strong-password"
npm start
```

开发默认地址：

- panel/API：`http://127.0.0.1:8080`
- Relay：`http://127.0.0.1:8790/v1`
- 健康检查：`GET /healthz` 或 `GET /api/health`

未配置 `CLOUD_ADMIN_PASSWORD` 且数据库没有用户时，首次启动会生成只打印一次的管理员密码。生产环境不要沿用开发回环绑定和 HTTP 配置；默认 `CLOUD_HOST=0.0.0.0`，应显式评估暴露面并配置 HTTPS、域名、Cookie 与反向代理。

云端启动依赖核心 `modules/headless/server.js`、B 站 `src/main.js`，选择 LLBot 时还需 `dist/llbot.js`；NapCat 使用管理员准备的 Docker 镜像。目标部署机仍需验证镜像、入口、双通道接线和真实租户链路，不能凭 fake 测试认定可用。

## 4. 标准验证命令

```bash
export PATH="/e/bigPeach/fish/.tools/node:$PATH"

cd /e/bigPeach/fish/packages/qq-agent-core
npm test

cd /e/bigPeach/fish/packages/protocol-bili-bridge
npm run check && npm test

cd /e/bigPeach/fish/packages/cloud-manager
npm test && npm --prefix panel test

cd /e/bigPeach/fish/packages/protocol-qq-llbot
npm run check && npm test && npm run build
```

最近的本地验证与限制见 [docs/testing.md](docs/testing.md)：根 `check` 和单独执行的核心 coverage 已通过，根 `test:all` 仍因缺少便携 QQ/SnowLuma 组件在核心 setup 检查处失败，后续测试不能据此视为通过。测试期间工作区存在并行修改，最终集成后仍需复验；真实账号、上游及部署环境均待验收。本次 README 文档调整未运行软件测试。

## 5. 数据与秘密不要提交到文档或仓库

重点数据位置：

- 核心：`packages/qq-agent-core/data*/`，或由 `QQ_AGENT_DATA_DIR` 指定的目录。
- 独立 B 站桥接：默认 `<cwd>/var/bili-bridge/`，或由 `BILI_BRIDGE_DATA_DIR` 指定。
- cloud-manager：默认仓库 `var/cloud/`，或由 `CLOUD_DATA_DIR` 指定。
- 云租户：`var/cloud/tenants/<tenant-id>/`。
- 云数据库与主密钥：`var/cloud/cloud.sqlite`、`var/cloud/master.key`。

文档中的 token、密码、QQ 号均为占位符。不要粘贴真实 Cookie、`SESSDATA`、`refresh_token`、`auth_token`、Relay Key 或主密钥；迁移云数据时必须同时备份数据库、租户目录和 `master.key`。
