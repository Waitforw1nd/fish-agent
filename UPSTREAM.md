# 上游基线与许可证

本仓库将上游开源项目与多租户云端、双通道能力整合在同一工作树中维护；各子目录继续遵循其原有的开源许可证。

| 目录 | 上游项目 | 基线版本 | 许可证 |
|---|---|---|---|
| `packages/qq-agent-core/` | [ZASENJC/QQ-agent](https://github.com/ZASENJC/QQ-agent) | `codex/linux-headless-module` 0.4（`ca0bec135ec4301b50c50f9279ac96daebedf178`，已合入双通道与配置抽离改动） | MIT（见包内 `LICENSE`） |
| `packages/protocol-qq-llbot/` | [LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) | `v8.3.2`（`dc2b2b90092ef0f571b5546878288b83fff1e436`） | GPL-2.0（见包内 `LICENSE`） |

## 分发与合规说明

- **第三方运行时不随仓库分发**：SnowLuma、便携版 QQ 客户端、NapCat 镜像及本地运行数据（账号登录态、Token、数据库）均由部署环境按需安装或生成，不包含在源码仓库内。
- **构建产物不入库**：`protocol-qq-llbot/dist/` 与各包 `node_modules/` 不提交到 Git，统一通过源码与锁文件构建。
- **许可证义务**：对外分发包含 `protocol-qq-llbot` 的二进制包或容器镜像前，请遵守 GPL-2.0 的源码提供要求及对应协议组件的使用条款。
