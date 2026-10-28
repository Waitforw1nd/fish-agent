# 上游基线

本仓库将上游源码与二次开发合并为单一工作树，便于云端版本一起评审和发布；各上游许可证继续适用于对应目录。

| 目录 | 上游仓库 | 固定基线 | 许可证 |
| --- | --- | --- | --- |
| `packages/qq-agent-core/` | https://github.com/ZASENJC/QQ-agent | `codex/linux-headless-module` 的 0.4，`ca0bec135ec4301b50c50f9279ac96daebedf178`（目标基线；须合入本项目双通道改动） | MIT，见目录内 `LICENSE` |
| `packages/protocol-qq-llbot/` | https://github.com/LLOneBot/LuckyLilliaBot | `dc2b2b90092ef0f571b5546878288b83fff1e436`（`v8.3.2`） | GPL-2.0，见目录内 `LICENSE` |

原始 Git 元数据仅用于本地溯源，不作为子模块提交。二次开发修改已经直接包含在上述目录中。

- QQ-agent 的 SnowLuma、便携 QQ、运行时数据和 Electron 构建产物由安装脚本生成，不随本仓库分发。
- LLBot 的 `dist/`、依赖、账号数据与 token 不提交；通过其源码和锁文件重新构建。
- 对外分发包含 LLBot 的二进制或镜像前，需同时评估 GPL-2.0 的源码提供义务及各协议端条款。
