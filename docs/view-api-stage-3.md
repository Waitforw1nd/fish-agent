# 阶段三：面板数据层与复用组件

完成日期：2026-10-29。

面板 API 按认证、租户、QQ、B 站、Agent、扩展、中转、计费和管理员域拆分，保留旧扁平方法，同时提供按域分组的方法。写请求继续使用同源 Cookie 和 CSRF；租户、会话、扩展等标识在路径中编码。路由支持管理端、用户快捷设置和单租户新增页签，同时保留原有地址。归一化层补充 Agent 配置、联系人、扩展和实例就绪度。

复用组件提供 QQ 接入与切换、B 站四类订阅和监控目标、实例扩展管理及 Agent Studio。Studio 包含在线联系人选择与离线录入、群员屏蔽、人设模板与角色卡预览导入、四档响应和峰谷、工具分类与扩展参数、提示词预览、会话/记忆及备份。组件通过 `readOnly` 限制写入，使用文本节点展示外部数据，并提供销毁、刷新与未保存变更检查。

验证：执行 `node --test packages/cloud-manager/panel/test/api.test.mjs packages/cloud-manager/panel/test/normalize.test.mjs packages/cloud-manager/panel/test/router-polling.test.mjs packages/cloud-manager/panel/test/workspace-components.test.mjs`，44 项通过。测试覆盖现有 API 与归一化回归、路径编码与 CSRF、新路由、离线名单、在线联系人、只读权限、B 站订阅与目标、扩展操作及文本渲染。全量面板测试与后端联调将在后续阶段再次运行。

后续联调补充：实例扩展卸载支持选择清理配置，以及覆盖内置版本时回退内置版本。能力页展示工具分类、可用状态和不可用原因，离线时标记尚未检测。`agent-client-integration.test.mjs` 通过真实管理器验证离线名单、分群配置与角色卡的保存和清空，以及 B 站目标配置回读。
