# PMHQ 协议抓包调试工具

通过 PMHQ 暴露的 SSE 端点（`http://localhost:13000/`）捕获收发 Protobuf 数据包，并配合 OneBot HTTP 端点（`http://localhost:53000/`）触发指定接口，用于分析与调试底层 OIDB 命令字。

## 使用步骤

1. **后台保持 SSE 抓包监听**（在 `packages/protocol-qq-llbot` 目录执行）：
   ```bash
   node devtools/sse-listener.mjs sse-capture.jsonl
   ```
   每条收发记录会以 JSON Lines 格式写入 `sse-capture.jsonl`。

2. **触发单次 OneBot 接口并提取配对包**：
   ```bash
   node devtools/trigger.mjs get_profile_like '{"user_id":721011692,"start":0,"count":3}'
   ```

3. **批量扫描多个端点**：按需修改 `devtools/sweep.mjs` 中的 `targets` 列表后运行 `node devtools/sweep.mjs`。

## 注意事项

- `53000` 才是 OneBot HTTP 动作端口（`4000` 仅用于心跳）。
- 抓包期间账号已在外部 PMHQ 登录，**切勿重复启动同一 QQ 号的另一个机器人实例**，以免互踢下线。
