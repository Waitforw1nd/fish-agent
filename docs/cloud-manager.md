# 云端管理（cloud-manager）、面板与 Relay 指南

`packages/cloud-manager` 负责多租户实例托管、同源 Web 面板、协议进程/容器编排以及 OpenAI 兼容的模型计费中转（Relay）。

## 1. 服务结构与运行模型

单个 `cloud-manager` 进程同时提供两个 HTTP 服务：

| 服务 | 默认监听 | 说明 |
|---|---|---|
| 管理 API + Web Panel + 租户 Gateway | `0.0.0.0:8080` | 托管 `panel/` 前端、提供 `/api/*` 同源接口，并兼容 `<slug>.<baseDomain>` 反向代理。 |
| 模型计费中转（Relay） | `127.0.0.1:8790` | 提供 `/v1/models` 与 `/v1/chat/completions`，使用 `sk-fish-*` Bearer Key 鉴权计费。 |

### 子进程与容器编排

每个租户拥有独立的进程与数据目录：
- **Agent 核心**：由 `Supervisor` 启动 `packages/qq-agent-core/modules/headless/server.js`，注入 `QQ_AGENT_READY_IPC=1`。子进程在 HTTP `listen` 成功后通过 Node IPC 发送 `{ type: "fish-agent-listening", pid, port }`，管理器核对 PID 与端口后再放行请求（自定义 `CLOUD_AGENT_ENTRY` 也必须发送此回执）。
- **QQ 协议端**：新建实例默认使用 **NapCat Docker**（独立容器与回环端口映射）；也支持 **LLBot**（`dist/llbot.js` 子进程，Direct 或 Desktop 模式）与 **官方机器人 qqbot**（无本地协议端，Agent 直连 QQ 开放平台网关，凭证托管在租户密钥库）。
- **B 站协议端**：按需启动 `packages/protocol-bili-bridge/src/main.js` 子进程。

### 用户开通主流程

面板围绕四步就绪检查（Readiness）引导用户完成配置：
1. **启动实例**：拉起该租户的 Agent 进程。
2. **接入 QQ**：扫码登录（NapCat / LLBot，输入预期登录的 5～12 位 QQ 号并手机扫码；若实际扫码 QQ 号与预期不一致，平台会自动停止协议端并报 `uin_mismatch`），或选择**官方机器人**接入方式，填写 QQ 开放平台的 AppID / AppSecret（保存前平台会先向官方验证凭证；机器人 AppID 充当跨实例占用键，同一 AppID 不能被两个实例同时使用）。
3. **配置模型渠道**：使用平台套餐模型（消耗实例钱包余额），或配置自定义 OpenAI 兼容上游（支持保存前一键探测连通性与模型列表）。
4. **勾选互动白名单**：在“群聊与白名单”中勾选允许发言的群或好友（支持离线预配与在线拉取真实群列表；空白名单默认不回复任何消息）。

> **说明**：当前创建实例与套餐续费未绑定第三方在线支付网关；用户提交充值申请后生成 `pending` 订单，由管理员在后台审核确认到账或填写原因驳回。

## 2. 常用环境变量

完整配置见 `packages/cloud-manager/src/config.js`（不自动加载 `.env`）：

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `CLOUD_DATA_DIR` | `<repo>/var/cloud` | 云端数据根目录（SQLite、主密钥、租户数据、备份）。 |
| `CLOUD_HOST` / `CLOUD_PORT` | `0.0.0.0` / `8080` | 面板与管理 API 监听地址和端口。 |
| `CLOUD_RELAY_HOST` / `CLOUD_RELAY_PORT` | `127.0.0.1` / `8790` | 本地模型 Relay 监听地址和端口。 |
| `CLOUD_ADMIN_USERNAME` / `CLOUD_ADMIN_PASSWORD` | `admin` / 空 | 初始管理员账号；首次启动且密码为空时随机生成并打印一次。 |
| `CLOUD_MASTER_KEY` | 空（自动生成 `master.key`） | 32 字节主密钥（base64 或 64 位 hex），用于加密租户密钥与备份。 |
| `CLOUD_BASE_DOMAIN` / `CLOUD_PUBLIC_SCHEME` | `localhost` / `http` | 公开域名与协议（HTTPS 部署时设 `https`）。 |
| `CLOUD_TRUST_PROXY` | `false` | 位于可信反向代理（Nginx/Caddy）后方时设为 `true`。 |
| `CLOUD_PORT_RANGE_START` / `CLOUD_PORT_RANGE_END` | `31000` / `39999` | 分配给各租户 Agent 与协议端的内部回环端口池。 |
| `CLOUD_DEFAULT_QQ_DRIVER` | `napcat` | 新实例默认 QQ 驱动（`napcat`、`llbot` 或 `qqbot`）。 |
| `CLOUD_QQBOT_TOKEN_URL` | 官方地址 | 官方机器人凭证校验端点（默认 `https://bots.qq.com/app/getAppAccessToken`；测试钩子，生产勿改）。 |
| `CLOUD_NAPCAT_IMAGE` | 空 | NapCat 必填固定摘要镜像（`仓库@sha256:...`），详见 [deploy/napcat/README.md](../deploy/napcat/README.md)。 |
| `CLOUD_LLBOT_AUTH_TOKEN` | 空 | 平台级 LLBot Direct 授权 Token（也可在管理面板动态配置）。 |
| `CLOUD_UPSTREAM_BASE_URL` / `CLOUD_UPSTREAM_API_KEY` | 空 | 平台公共模型上游初始配置（可在管理面板动态覆盖）。 |
| `CLOUD_DEFAULT_MODEL` | `deepseek-chat` | 新实例默认平台模型。 |
| `CLOUD_RELAY_CUSTOM_ALLOW_PRIVATE` | `false` | 自定义模型渠道默认仅允许公网 HTTPS，本地联调内网模型时可开启。 |

## 3. 数据目录、端口与密钥

```text
<CLOUD_DATA_DIR>/
├── master.key                              # 32 字节主密钥（丢失将无法解密秘密与备份）
├── cloud.sqlite                            # 核心数据库（用户、租户、钱包、账单、端口租约、审计）
├── extensions/catalog/{plugins,skills}/    # 管理员上传的平台公共插件库
├── tenants/<tenant-id>/
│   ├── data/config.json                    # 租户 Agent 配置
│   ├── data/blocked-extensions.json        # 管理员按实例屏蔽的内置扩展 ID 列表
│   ├── admin-extensions/{plugins,skills}/  # 管理员为该实例安装的受信任扩展
│   ├── extensions/{plugins,skills}/        # 租户自上传目录（默认闭锁）
│   ├── qq/<driver>/                        # QQ 登录态与协议配置
│   └── bili/                               # B 站虚拟 ID 映射、轮询状态与加密凭据
├── backups/<tenant-id>/*.fmbackup          # AES-256-GCM 加密的实例快照
└── logs/
```

- **端口租约**：从 `31000–39999` 事务分配 `agent.http`、`qq.webui`、`qq.ob11`、`qq.http`（NapCat/SnowLuma）、`qq.pmhq`（LLBot Desktop）和 `bili.ob11`。
- **密钥分层**：主密钥包装每租户随机 32 字节 DEK（`tenant_keys`），再用 DEK 加密各租户内部 Token 与 Relay Key（`tenant_secrets`）；用户密码使用 `scrypt` 哈希存储。
- **备份与迁移**：整站迁移必须同时备份 `cloud.sqlite`（使用一致性备份）、`tenants/` 目录与 `master.key`。普通用户恢复实例快照时，系统会自动保留当前管理员设置的插件与屏蔽状态，防止旧快照绕过管理员管控。

## 4. API 模块速查

后端路由统一聚合在 `src/api.js`，按职责拆分为 `src/routes/*.js` 八个模块：

- **鉴权方式**：面板 API 使用 `HttpOnly` 会话 Cookie 并拒绝跨站请求（`Sec-Fetch-Site: cross-site` 或非信任 `Origin`）；敏感写接口（`/agent/*`、`/extensions/*`、`/relay/custom/test`、`/admin/extensions/*`、`/admin/recharges/:id/reject`、`/admin/users/:id`、`/api/auth/password`）强制要求请求头携带 `X-CSRF-Token`（`panel` 客户端已自动注入）。Relay 接口仅使用 `Authorization: Bearer sk-fish-*`。
- **权限层级**：平台级为 `admin` > `user`；单实例成员级为 `owner`（计费/渠道/成员/备份） > `operator`（启停/扫码/Agent 设置） > `viewer`（只读）。
- **返回格式**：成功 `{ ok: true, ... }`，失败 `{ ok: false, code, error }`。

### 4.1 认证与租户管理（`routes/auth.js`、`routes/tenants.js`）

| 方法与路径 | 最低权限 | 说明 |
|---|---|---|
| `GET /healthz`、`/api/health` | 公开 | 服务健康检查。 |
| `POST /api/auth/login` / `logout` | 公开 / 登录 | 登录签发 Cookie 与 `csrfToken`；登出销毁会话。 |
| `GET /api/me`、`PUT /api/auth/password` | 登录 | 当前用户与实例列表（含四步 `readiness`）；修改自身密码。 |
| `GET /api/plans` | 登录 | 查询套餐配额目录。 |
| `GET / POST /api/tenants` | 登录 | 列出可访问实例；新建实例 `{ name, slug?, planId?, ownerUserId? }`。 |
| `GET / PATCH /api/tenants/:id` | `viewer` / `owner` | 实例详情摘要；修改名称或套餐。 |
| `POST /api/tenants/:id/{start,stop,restart}` | `operator` | 启动、停止、重启实例。 |
| `POST /api/tenants/:id/renew` | `owner` | 续费或更换套餐（`admin` 可指定 `creditMicros`）。 |
| `POST /api/tenants/:id/{suspend,resume}` | `admin` | 暂停或恢复实例使用资格。 |
| `GET /api/tenants/:id/{logs,audit}` | `operator` | 查看进程日志（`all/agent/qq/bili`）与实例操作审计。 |
| `GET / POST / DELETE /api/tenants/:id/members[/:userId]` | `viewer` / `owner` | 查看、添加或移除协作成员（`operator`/`viewer`）。 |
| `GET /api/tenants/:id/backups`、`POST .../backup`、`POST .../restore` | `viewer` / `owner` | 查看、创建或恢复实例加密快照。 |

### 4.2 QQ 与 B 站接入（`routes/qq.js`、`routes/bili.js`）

所有租户通道接口前缀均为 `/api/tenants/:id`：

| 方法与后缀 | 最低权限 | 说明 |
|---|---|---|
| `GET /api/qq/drivers`（全局路径） | 登录 | 查看平台支持的 QQ 驱动及宿主机可用状态。 |
| `POST /qq/prepare`、`/qq/start`、`/qq/stop` | `operator` | 配置 QQ 号与驱动、启动、停止协议端；`driver=qqbot` 时改为提交 `appId` / `appSecret` / `sandbox`（凭证经官方接口验证后托管，永不在响应中回显）。 |
| `GET /qq/status`、`/qq/logs` | `viewer` / `operator` | 查询登录与连接状态；查看脱敏日志。 |
| `GET /qq/qrcode`、`POST /qq/qrcode/refresh` | `operator` | 获取登录二维码；NapCat 未登录会话换取新二维码。 |
| `PUT / DELETE /qq/auth-token` | `operator` | 设置或清除单实例 LLBot Direct `auth_token`。 |
| `POST /qq/switch` | `operator` | 发起 NapCat ↔ LLBot 事务式内核切换（保留人设、白名单与记忆）。 |
| `GET /qq/operations/:opId`、`POST .../{advance,cancel}` | `viewer` / `operator` | 查询、推进扫码确认或安全取消回滚切换事务。 |
| `POST /bili/login/qr`、`GET /bili/login/status` | `operator` / `viewer` | 创建并轮询 B 站扫码登录。 |
| `GET /bili/status`、`GET / PUT /bili/config` | `viewer` / `operator` | 查看状态；配置四类订阅（`@`、UP 投稿、私信、直播）及监控目标。 |
| `POST /bili/{start,stop,logout}`、`GET /bili/logs` | `operator` | 启停桥接、退出账号、读取日志。 |

> **内核切换（`/qq/switch`）说明**：切换会先暂停 Agent 与旧 QQ 内核、清理旧 QQ 未读消息以防重发，再拉起新内核等待扫码；扫码校验 QQ 号一致后自动提交并恢复 Agent，取消或出错可按状态回滚至原内核。

### 4.3 同源 Agent 设置与管理员扩展（`routes/agent.js`、`routes/extensions.js`）

无需配置泛子域即可在面板管理单实例 Agent（运行中热同步，离线直接读写磁盘）：

| 方法与路径 | 最低权限 | 说明 |
|---|---|---|
| `GET / PATCH /api/tenants/:id/agent/config` | `viewer` / `operator` | 读取脱敏配置；更新白名单、黑名单、人设、响应档位、表情与工具开关。 |
| `GET / POST / DELETE .../agent/personas[/:templateId]` | `viewer` / `operator` | 管理人设模板。 |
| `POST .../agent/persona-cards/{preview,import}` | `operator` | SillyTavern JSON/PNG 角色卡安全预览与导入。 |
| `GET .../agent/{contacts,status}`、`PUT .../agent/pause` | `viewer` / `operator` | 拉取在线群/好友列表、查看运行状态、临时暂停/恢复机器人回复。 |
| `GET .../agent/sessions`、`POST .../sessions/{clear-finished,:sid/:action}` | `viewer` / `operator` | 查看最近触发会话、清空历史、重试或中止会话。 |
| `GET .../agent/chats[/:chatId/messages]`、`POST .../chats/:chatId/actions` | `viewer` / `operator` | 查看消息存档、发送白名单测试消息或标已读。 |
| `GET / PUT / DELETE .../agent/memories...`、`POST .../memories/consolidate` | `viewer` / `operator` | 查看、手动编辑、删除群友印象记忆或触发记忆整理。 |
| `GET .../agent/skills`、`PATCH .../agent/skills/:skillId` | `viewer` / `operator` | 查看 8 类工具诊断；开关可用扩展及修改安全 `configSchema` 参数。 |
| `POST .../agent/prompt-preview` | `viewer` | 在线预览完整系统提示词。 |
| `GET /api/tenants/:id/extensions` | `viewer` | 查看实例扩展列表（管理员额外可见已屏蔽项）。 |
| `POST .../extensions/{install-zip,install-catalog,reload}` | `admin` | 为单实例上传 ZIP、从公共库安装或强制热重载（加载失败自动回滚）。 |
| `DELETE .../extensions/:extId`、`POST .../extensions/:extId/restore` | `admin` | 卸载自定义扩展或按实例屏蔽/恢复内置扩展。 |
| `GET / POST / DELETE /api/admin/extensions/catalog[/:extId]` | `admin` | 维护平台公共插件库，支持 `POST .../{deploy,undeploy}` 批量分发/卸载。 |

> **配置补丁约定**：通用 `/agent/config`（同样支持 `PUT`）禁止直接写入 `skills`（须调用 `PATCH /agent/skills/:skillId`）；仅 `blocklist`、`personaByChat`、`store.groupSliderPos`、`store.groupPeakPos` 四个映射字段支持使用 `{ __replace__: {...} }` 整体替换以清理旧键。

### 4.4 中转计费与平台管理（`routes/relay-billing.js`、`routes/admin.js`）

| 方法与路径 | 最低权限 | 说明 |
|---|---|---|
| `GET /api/tenants/:id/relay/{overview,models,logs}` | `viewer` | 钱包余额、用量统计、可用模型清单与调用日志。 |
| `PUT /api/tenants/:id/relay/key` | `owner` | 轮换平台 Relay Key 或切换套餐模型。 |
| `GET / PUT / DELETE .../relay/custom`、`POST .../relay/custom/test` | `viewer` / `owner` | 配置、删除或测试自定义模型上游（含 SSRF 防护与模型拉取）。 |
| `GET / POST .../billing/recharges`、`GET .../billing/transactions` | `viewer` / `owner` | 提交充值申请、查看审核进度与钱包收支流水。 |
| `POST /api/tenants/:id/relay/topup` | `admin` | 管理员手工充值或扣减实例余额。 |
| `GET /api/admin/overview`、`/api/admin/audit` | `admin` | 平台全局运营指标、驱动健康度与审计检索。 |
| `GET / POST / PATCH /api/admin/users[/:userId]`、`GET .../users/:userId/tenants` | `admin` | 用户搜索、创建、禁用/启用、重置密码、角色修改（保护最后活跃管理员）及名下实例。 |
| `GET /api/admin/recharges`、`POST .../recharges/:id/{confirm,reject}` | `admin` | 全局充值审核队列：确认入账或填写原因驳回。 |
| `GET / PUT /api/admin/{upstream,llbot-auth-token}` | `admin` | 配置平台公共模型上游与平台级 LLBot Direct 授权 Token。 |

### 4.5 Relay 独立接口（默认 `127.0.0.1:8790`）

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /health`、`/v1/health` | 公开 | Relay 服务存活检查。 |
| `GET /v1/models`（兼容 `/models`） | `Bearer sk-fish-*` | 返回当前渠道可用模型列表。 |
| `POST /v1/chat/completions`（兼容 `/chat/completions`） | `Bearer sk-fish-*` | OpenAI 兼容普通 JSON 与 SSE 流式对话；支持附加归因对象 `{ platform: "qq"\|"bili", chatKey, runId, vision }` 用于按会话与平台统计账单。 |

## 5. 套餐与计费规则

平台金额统一以**微元（micros）**存储：`1,000,000 micros = 1 元（CNY）`。

| 套餐 | 初始赠送 | 续费赠送 | 周期 | RPM | TPM | 单次最大输出 | 并发 | 普通用户拥有上限 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `trial` | 10 元 | 0 元 | 14 天 | 10 | 50,000 | 2,048 | 2 | 1 个实例 |
| `starter` | 30 元 | 30 元 | 30 天 | 60 | 300,000 | 4,096 | 4 | 3 个实例 |
| `pro` | 150 元 | 150 元 | 30 天 | 240 | 2,000,000 | 8,192 | 12 | 10 个实例 |

内置平台模型定价（元 / 百万 Token，定义于 `src/plans.js`）：
- `deepseek-chat`、`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision`、`deepseek-v4.1-flash`：输入 `2` / 缓存命中 `0.5` / 输出 `8`
- `deepseek-reasoner`：输入 `4` / 缓存命中 `1` / 输出 `16`
- `gpt-4o-mini`：输入 `1` / 缓存命中 `0.5` / 输出 `4`

**扣费流程**：
- **平台渠道**：请求前按预估输入与 `max_tokens` 预占额度（`×1.15` 安全系数），检查 RPM/TPM/并发与可用余额；上游成功后按实际 `usage`（缺省时按文本估算并标记 `estimated`）扣款写账本，上游失败则释放预占。
- **自定义渠道**：仍通过本地 Relay 校验租户有效期与速率限制，但不预占、不扣减平台钱包余额（账单记录平台费用为 `0`）。
- 若需在平台渠道新增模型，需同步修改 `src/plans.js` 中的 `MODEL_CATALOG` 与套餐白名单。

## 6. 云端配置安全锁定（`config-guard.js`）

在多租户环境下，云端配置接口与 Gateway 会自动拦截越权字段，保障宿主机与其他租户安全：
- 禁止用户修改 `server`、`extensions`、`channels`、`snowluma`、`providers` 及 `api.baseUrl / apiKey` 等云管字段。
- 强制锁定 `allowAllWhenEmpty = false`（空白名单禁发）、`tools.crossChatSend = false`（禁跨群发消息）、`security.allowPrivateImageHosts = false`（防内网探测），并剔除自定义搜索接口 URL。
- 屏蔽 `/api/reset-data` 等高危单机接口及媒体接口中的宿主机本地文件路径。
