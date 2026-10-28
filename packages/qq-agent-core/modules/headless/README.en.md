# Headless runtime

From `packages/qq-agent-core`, use Node.js 22 or 24:

```sh
npm ci --omit=dev --ignore-scripts
export QQ_AGENT_DATA_DIR=/absolute/private/data
export QQ_AGENT_TOKEN='replace-with-random-console-token'
npm run server:headless
```

The console listens on `127.0.0.1:3210` by default. Set `QQ_AGENT_HOST`, `QQ_AGENT_PORT` and `QQ_AGENT_ALLOWED_HOSTS` as needed. Sign in at `/runtime/connection` with the console token. The session cookie is HttpOnly; Origin and Referer must match the allowed Host.

QQ and Bilibili use the core `channels` configuration and ID routing. QQ can also use `connection` for forward or reverse OneBot WebSocket; reverse connections require a separate protocol token. Bilibili uses the existing OneBot client. Protocol services are managed separately. Official QQBot OpenIDs are incompatible with the current numeric ID router and cannot be enabled.

Run `npm run test:headless` for authentication, transport and runtime checks. The SIGTERM test requires Linux; Windows does not implement equivalent POSIX signal delivery.
