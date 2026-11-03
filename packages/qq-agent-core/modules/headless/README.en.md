# Headless Runtime Module

`modules/headless` runs `qq-agent-core` as a standalone Node.js server (Node.js 22 or 24) without Electron or desktop GUI dependencies. Protocol services (NapCat, LLBot, or Bilibili bridge) run separately.

## Quick Start

From `packages/qq-agent-core`:

```bash
export QQ_AGENT_DATA_DIR="/path/to/data"
export QQ_AGENT_TOKEN="replace-with-random-console-token"
npm run server:headless
```

Key environment variables:
- `QQ_AGENT_HOST` / `QQ_AGENT_PORT`: Bind address and port (defaults to `127.0.0.1:3210`).
- `QQ_AGENT_TOKEN`: Console access token (sign in at `/runtime/connection` to obtain an `HttpOnly` session cookie).
- `QQ_AGENT_ALLOWED_HOSTS`: Allowed `Host` header list (validated against `Origin` / `Referer`).
- `QQ_AGENT_READY_IPC=1`: Used by `cloud-manager` to receive the `{ type: "fish-agent-listening", pid, port }` Node IPC readiness message.

## Docker & Testing

```bash
cp modules/headless/.env.example .env
# Edit .env to set a strong token, then start:
docker compose --env-file .env -f modules/headless/compose.yaml up -d --build

# Run headless authentication, transport, and runtime tests:
npm run test:headless
```

> **Channel note**: Headless uses the core `channels` configuration and numeric ID `ChannelRouter` for both QQ (OneBot v11 forward/reverse WebSocket or HTTP) and Bilibili. Official QQBot string OpenIDs are not supported.
