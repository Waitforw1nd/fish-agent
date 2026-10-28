# Headless 运行模块

在 `packages/qq-agent-core` 目录使用 Node.js 22 或 24：

```sh
npm ci --omit=dev --ignore-scripts
export QQ_AGENT_DATA_DIR=/absolute/private/data
export QQ_AGENT_TOKEN='replace-with-random-console-token'
npm run server:headless
```

默认监听 `127.0.0.1:3210`。`QQ_AGENT_HOST`、`QQ_AGENT_PORT` 和 `QQ_AGENT_ALLOWED_HOSTS` 可设置监听地址、端口和允许访问的 Host。使用管理令牌登录 `/runtime/connection`；Cookie 为 HttpOnly，Origin 和 Referer 必须与允许的 Host 一致。

QQ 和 B站沿用核心的 `channels` 配置和 ID 路由。QQ 也可通过 `connection` 配置 OneBot 正向或反向 WebSocket，反向连接需要独立的协议令牌。B站使用现有 OneBot 客户端；协议服务由外部单独管理。官方 QQBot 的 OpenID 不兼容当前数字 ID 路由，不能启用。

容器示例：

```sh
cp modules/headless/.env.example .env
# 修改 .env 的管理令牌
docker compose --env-file .env -f modules/headless/compose.yaml up -d --build
```

运行 `npm run test:headless` 验证认证、协议和运行时。Linux 中可运行 SIGTERM 测试；Windows 不提供同等 POSIX 信号语义。
