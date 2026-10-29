# 阶段二：云端服务与接口模块化

> 工作记录：阶段二后端服务和八域路由已接入；以下保留各次验证记录，最终跨阶段复测见 [阶段五记录](view-api-stage-5.md)。

## 后端模块

- `src/api.js` 聚合路由；`src/contracts/http.js` 提供参数校验、授权、响应与中转配置更新辅助函数；`src/presenters/tenant-presenter.js` 提供兼容旧字段的租户摘要和四步就绪度。
- 既有认证、租户、QQ、B 站、中转计费及管理员路由按业务域拆分，保留原路径、状态码及原有响应字段。Agent、扩展服务按同一授权契约注入。
- 就绪度包含实例运行、QQ 在线、渠道配置与余额、互动白名单；白名单从实例配置读取，不向调用者返回秘密。
- 新增的敏感写入接口要求显式 CSRF 令牌；既有接口保留原有同源证据校验，以保持历史客户端兼容。

## 数据与运营能力

- SQLite v9 事务式迁移充值表，保留历史订单与确认信息，新增驳回状态及审核人、时间和备注；对仅含部分历史表的单元测试数据库安全跳过缺失的充值表。
- 新增全局充值筛选、确认/驳回、防重复审核、钱包流水及平台用量统计；驳回不会修改余额。
- 管理员可更新账号角色、禁用状态和密码；保护最后一位活跃管理员，禁用或重置密码时立即吊销该用户会话。当前用户改密时保留当前会话并吊销其他会话。
- 全平台审计可按租户、操作人、动作筛选，附带用户名和租户名。运营总览提供租户和用户计数、待审充值、调用消耗、上游及 QQ 驱动状态。
- 自定义上游测试复用公网地址解析与固定 DNS 地址策略，不跟随重定向，限制响应大小与请求时间，响应不返回凭据；允许使用管理员显式配置的私网测试模式。

## 验证记录

- `node --test packages/cloud-manager/test/unit.test.mjs`：6 项通过，包括历史局部表迁移。
- `node --test packages/cloud-manager/test/view-api-backend.test.mjs`：6 项通过，覆盖 v8 历史充值数据迁移、审核与防重放、管理员保护和会话撤销、SSRF 检测及重定向拒绝、配置保护绕过、快照权限。
- 所有本次修改的后端模块通过 `node --check`。
- Agent/扩展服务持续补充专项测试；最终全量回归由阶段五统一执行。

## 补充安全验证

- 通用配置补丁过滤原型污染键，禁止受云端锁定字段使用整体替换或非对象值；旧 Gateway 的通用配置接口不直接修改插件配置，插件设置通过其受 manifest 约束的专用接口完成。
- 旧 Gateway 对 `viewer` 拒绝写请求。`node --test packages/cloud-manager/test/view-api-backend.test.mjs packages/cloud-manager/test/unit.test.mjs packages/cloud-manager/test/extension-gateway-contract.test.mjs` 共 13 项通过。

## 快照权限

- 管理员扩展目录与实例屏蔽清单纳入加密快照。管理员恢复时按快照还原；非管理员恢复时保留这两处当前状态（包括目录或文件不存在），防止旧快照恢复已删除插件或解除管理员屏蔽。
- 恢复按固定顺序取得同一实例的扩展锁和设置锁，与安装、删除和离线配置写入互斥。自动化用例覆盖旧快照、当前目录缺失、管理员完整恢复以及锁顺序。

## 云端集成验证

- `node .tools/node/node_modules/npm/bin/npm-cli.js --prefix packages/cloud-manager test`：124 项通过，0 项失败，2 项 Linux 专属进程组测试在 Windows 跳过。
- 新增真实 HTTP 用例验证四步就绪度、上游探测权限及 CSRF、充值审核与防重放、管理员运营与审计、改密与禁用会话失效。
- Agent 同源设置与扩展服务已接入当前路由和服务容器；其进一步的核心与跨阶段验收由相关阶段继续记录。

## 跨层契约复核

- 管理员运营总览、平台设置、日志、成员、备份、充值及审计视图所用路径与响应字段已经核对。
- 自定义渠道启用时，模型列表新增 `platformModels` 与 `platformModel`，使平台套餐选择器仍能获取平台模型；原 `models` 和 `allModels` 契约不变。
- 成员接口限制协作角色为 `operator` / `viewer`，拒绝变更真实所有者的角色，避免其意外丧失管理权限。
- 修复记忆成员备注的读取和保存契约，以及公共插件库已分发实例计数；由 Agent/扩展专项用例验证。
- 最后执行 `node --test packages/cloud-manager/test/view-api-backend.test.mjs packages/cloud-manager/test/view-api-http.test.mjs packages/cloud-manager/test/user-tenant-permissions.test.mjs`：8 项通过。此前完整云端套件的 124 项通过、2 项 Windows 跳过是后续补充前的结果，最终以阶段五复测为准。

## 旧 Gateway 安全契约复核

- 同源服务和旧租户 Gateway 的插件设置使用同一 schema、屏蔽清单与脱敏逻辑；Gateway 的配置和插件列表、插件更新、重载与清理响应也过滤敏感设置。对应写入与扩展、配置恢复操作使用统一的锁顺序。
- `node --test packages/cloud-manager/test/view-api-gateway.test.mjs packages/cloud-manager/test/agent-extensions-view-api.test.mjs packages/cloud-manager/test/api.test.mjs packages/cloud-manager/test/extension-gateway-contract.test.mjs` 曾全部通过（4 项）。新 Gateway 用例覆盖只读角色、屏蔽扩展、越界及 secret 设置、配置和重载响应脱敏。
- 一次更大并行定向复测中，Agent 扩展安装目录重命名在 Windows 返回 `EPERM`，其余 10 项通过；同一 Agent 集成用例此前通过，已交扩展服务负责人排查竞态并在稳定后复测。此前云端完整套件结果不包含后续 Gateway 安全改动，最终以阶段五复测为准。
- 系统提示词预览目前需要 Agent 运行；离线配置仍可保存。运行时提示词生成依赖进程级配置和技能管理器，离线多租户预览需要进一步抽离无全局状态的纯函数，避免跨租户状态污染。

## 后续修复结果

- 扩展服务对 Windows 临时目录占用导致的重命名错误增加有界重试；扩展负责人报告真实在线集成连续 8 次通过。
- Gateway 重载结果使用允许字段列表及固定安全错误，插件状态复用安全诊断。`node --test packages/cloud-manager/test/view-api-gateway.test.mjs packages/cloud-manager/test/api.test.mjs packages/cloud-manager/test/extension-gateway-contract.test.mjs`：4 项通过；其中真实 headless 插件抛出含秘密的异常，直接核心接口确认含该异常，而 Gateway 插件列表与重载响应均未泄露。
- Gateway 工具可用性与技能能力诊断过滤管理员屏蔽的扩展，以固定安全文案替换可能包含插件异常的原因，并根据可见 provider 重新计算能力是否可用。上述 4 项定向测试再次通过，覆盖混合可见和屏蔽 provider、仅由屏蔽扩展提供的能力以及工具诊断中的敏感信息。
- 所有修改完成后，最终完整云端套件 133 项通过、0 失败、2 项 Linux 专用测试在 Windows 跳过；面板 127 项全部通过。阶段五另记录 Agent 就绪及测试端口隔离修复，不以此前中间结果替代最终验收。
