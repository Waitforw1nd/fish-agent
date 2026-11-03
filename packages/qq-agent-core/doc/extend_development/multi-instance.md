# Windows 单机双实例指南

单机模式下支持在同一台 Windows 电脑上同时运行两个独立的 QQ Agent 实例：主实例使用默认 `data/`，第二实例通过 `QQ_AGENT_PROFILE=2` 使用 `data-2/`。

> **提示**：如果需要托管 3 个及以上账号或多人协作管理，建议直接使用根目录的 `cloud-manager` 多租户面板（`npm start`）。

## 启动步骤

1. 先正常启动并配置好主实例，确保 `packages/qq-agent-core/data/config.json` 已生成。
2. 在 `packages/qq-agent-core` 目录生成第二实例配置（若 `data-2/config.json` 已存在则不会覆盖）：

```bash
node scripts/setup-second-instance.mjs
```

3. 为两个 QQ 号分别准备不同的协议端监听端口（第二实例默认在主实例端口上整体 `+100`）：
   - 主实例：控制台 `3210`，OneBot HTTP/WS `3010 / 3011`
   - 第二实例：控制台 `3310`，OneBot HTTP/WS `3110 / 3111`
4. 正常启动主实例，再双击 `启动QQ机器人2.bat`（或设置 `QQ_AGENT_PROFILE=2` 启动）运行第二实例。

## 隔离规则

- **数据与凭据隔离**：脚本只生成基础配置骨架，不复制主实例的登录态、聊天存档或记忆，且会清空 OneBot Token，防止两个账号串号。
- **实例锁（`instance-lock.js`）**：按实际数据目录加锁（`data/` 与 `data-2/` 互不冲突）；也可用 `QQ_AGENT_DATA_DIR` 和 `QQ_AGENT_PORT` 显式指定自定义数据目录与控制台端口。
