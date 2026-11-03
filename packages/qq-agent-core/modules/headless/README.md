# Headless 无头运行模块

`modules/headless` 提供不依赖 Electron 与桌面 GUI 的服务端入口（要求 Node.js 22 或 24）。协议端进程（NapCat / LLBot / B 站桥接）由外部或 `cloud-manager` 独立运行管理。

## 本地直接启动

在 `packages/qq-agent-core` 目录下执行：

```bash
export QQ_AGENT_DATA_DIR="/path/to/data"
export QQ_AGENT_TOKEN="replace-with-random-console-token"
npm run server:headless
```

常用环境变量：
- `QQ_AGENT_HOST` / `QQ_AGENT_PORT`：监听地址与端口（默认 `127.0.0.1:3210`）。
- `QQ_AGENT_TOKEN`：控制台登录令牌（访问 `/runtime/connection` 登录，签发 `HttpOnly` 会话 Cookie）。
- `QQ_AGENT_ALLOWED_HOSTS`：允许访问的 `Host` 白名单（校验 `Origin` / `Referer`）。
- `QQ_AGENT_READY_IPC=1`：由 `cloud-manager` 子进程模式启用，监听成功后通过 Node IPC 发送 `fish-agent-listening` 就绪回执。

## 容器启动与测试

Docker Compose 启动：

```bash
cp modules/headless/.env.example .env
# 编辑 .env 设置管理令牌后启动：
docker compose --env-file .env -f modules/headless/compose.yaml up -d --build
```

运行无头模块测试：

```bash
npm run test:headless
```

> **通道说明**：Headless 复用核心 `channels` 配置与数字 ID `ChannelRouter` 同时支持 QQ（OneBot v11 正向/反向 WS 或 HTTP）与 B 站桥接；暂不支持使用字符串 OpenID 的官方 QQBot 协议。
