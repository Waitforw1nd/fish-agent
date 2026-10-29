# 阶段一：核心配置与扩展底座

完成时间：2026-10-29。

- 配置默认值与无磁盘副作用的编解码函数已拆出。单机和云端共用脱敏、旧配置迁移、深合并、派生标记清理及响应档位换算；脱敏视图回传时按 ID 保留数组中的已有密钥，显式空值仍可清除。
- 插件加载器依次处理内置、管理员受信目录和已确认隔离的租户目录。管理员目录覆盖同 ID 内置版本；实例数据目录中的 `blocked-extensions.json` 可屏蔽内置扩展，重扫时卸载并回收工具与生命周期资源。损坏的屏蔽文件会关闭内置扩展加载。
- 原有租户目录仍要求 `QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED=1`，云环境不会因为管理员目录而放开租户代码执行。

验证：`node --test packages/qq-agent-core/test/config-extension-foundation.test.mjs` 通过 2 项；`extensions-cloud-test.mjs` 通过 10 项；`zip-install-security-test.mjs` 通过 30 项。完整回归在阶段五统一执行。
