# cloud-manager、panel 与 Relay 开发契约

主要源码：`packages/cloud-manager/src/{app,api,config,db,gateway,agent-runtime,qq-service,bili-service,relay/server,billing,plans,ports,crypto}.js`。API 表以 `src/api.js` 为唯一准绳，panel 静态文件由 `src/app.js` 直接托管。

## 用户旅程：目标与当前实现

目标是让用户按“交钱 → 创建实例 → 登录 QQ → 绑定 Key → 开始养鱼”完成开通：用户提供 QQ 号，用手机扫码确认登录；实例具备可用的模型渠道后开始互动。这个顺序是产品目标，不表示当前系统已实现支付前置或端到端自动开通，也不保证角色行为一定像真人。

当前实现和目标之间有以下差距：

1. **交钱**：没有支付成功校验作为创建或续费的前置条件。用户先有平台账号；用户面板的充值需要选择已有实例，提交后只是 pending 订单，不自动扣款、不代表支付成功，管理员确认后才入钱包。管理员也可直接给钱包充值。支付方式、付款核验和开通规则仍待确定。
2. **创建实例**：用户面板填写名称并可选择套餐，默认 trial；服务端创建 active 租户、初始钱包额度和本地 Relay Key，并不检查支付。普通用户可创建多实例，数量按本次新建所选套餐限制，详见第 5 节。创建不等于进程已启动，实例页提供启动操作。续费接口由 owner 调用，可延长时长、选择套餐并发放套餐续费额度，同样不检查支付；只有管理员可指定 `creditMicros`。
3. **登录 QQ**：普通用户从 `#/user/instances` 的实例卡片进入 `#/user/instances/:tenantId`，输入 5–12 位 QQ 号后准备、启动 LLBot 并打开扫码窗口；viewer 只读，owner 和 operator 可操作。普通用户无需提供平台 token；LLBot direct 仍依赖平台预先配置有效授权，缺失或无效时请联系平台管理员。管理员可从 `#/users` 进入 `#/users/:userId/instances` 管理该用户拥有的实例，并进入托管视图。具体可用性依赖部署环境和协议端；桌面模式需要外部独立 QQ 与 PMHQ 组件，平台不自带启动器或注入器。提供 QQ 号本身不等于登录成功，真实 QQ 与 VPS 环境尚未验收。
4. **绑定 Key**：创建时已自动签发本平台的租户 Relay Key，Agent 启动或写配置时会使用它。用户渠道页保留“平台 Relay Key”输入框和“绑定平台 Key”按钮，可替换这个本地 Bearer 凭据；本地格式及唯一性校验通过不代表外部上游 Key 有效，也不会验证远端。若用户自带模型服务，应在同页的自定义渠道填写 Base URL、上游 API Key 和模型；当前保存时不提供连接测试，也不会自动修改 Agent 默认模型，实际请求模型必须与自定义模型一致。平台渠道则依赖管理员配置平台上游 URL 和 API Key。
5. **开始养鱼**：需要租户有效、Agent 和 QQ 协议端可运行且 QQ 已登录，模型渠道和模型可用；平台渠道还需要可用钱包余额。还需按实际场景配置允许互动的对象（空白 allowlist 不默认放行）。这些条件并非由一条已验证的一键开通流程自动保证。

平台技术职责包括隔离租户数据和进程、管理端口及秘密、提供 QQ 协议接入、Relay 鉴权与用量记录。支付方式、付款核验和开通规则尚待确定。

## 1. 进程与网络模型

一个 cloud-manager 进程监听两类服务：

| 服务 | 默认绑定 | 用途 |
|---|---|---|
| panel + 管理 API + 租户 Gateway | `0.0.0.0:8080` | 登录、租户管理、静态 panel，以及 `<slug>.<baseDomain>` 反向代理。 |
| OpenAI 兼容 Relay | `127.0.0.1:8790` | `/v1/models`、`/v1/chat/completions`，按租户 Key 鉴权和计费。 |

每个租户由 Supervisor 分别管理 `agent`、`qq`、`bili` 子进程。Agent 默认入口是核心 `modules/headless/server.js`（对应 `npm run server:headless`），B 站是桥接 `src/main.js`，LLBot 是 `dist/llbot.js`；NapCat/SnowLuma 入口可用环境变量替换。Headless 已接入核心 `ChannelRouter`，使用 `channels` 配置和数字 ID 路由支持 QQ/B 站双通道；QQ 使用 OneBot 连接，B 站使用 OneBot 客户端，官方 QQBot OpenID 当前不受该路由支持。Headless 不自行管理桌面 QQ 或协议端，QQ/B 站协议进程独立运行。源码接入不等于真实环境验收：仍需在部署环境验证协议服务、实际登录和双通道消息收发。

Supervisor 注入租户专属 `QQ_AGENT_TOKEN`、回环 `QQ_AGENT_HOST`、租约 `QQ_AGENT_PORT` 和 `QQ_AGENT_ALLOWED_HOSTS`。Gateway 根据 Host 识别 `<slug>.<CLOUD_BASE_DOMAIN>`，检查会话、租户成员角色和 active 状态，再注入内部 `x-console-token` 转发到该租户 Agent，并把 Host 和 Origin 改写为对应回环地址。浏览器的 panel Cookie、Origin、CSRF 等不会原样透传。HTTP、SSE 和 WebSocket 都走同一租户隔离逻辑。

## 2. 关键环境变量

完整默认值在 `src/config.js`；没有 `.env` 自动加载。

| 变量 | 默认值/说明 |
|---|---|
| `CLOUD_DATA_DIR` | 仓库 `var/cloud`。 |
| `CLOUD_HOST` / `CLOUD_PORT` | `0.0.0.0` / `8080`；测试可用端口 0。 |
| `CLOUD_RELAY_HOST` / `CLOUD_RELAY_PORT` | `127.0.0.1` / `8790`。 |
| `CLOUD_BASE_DOMAIN` / `CLOUD_PUBLIC_SCHEME` | `localhost` / `http`，组成租户子域和公开 URL。 |
| `CLOUD_COOKIE_NAME` / `CLOUD_COOKIE_DOMAIN` / `CLOUD_COOKIE_SECURE` | `fm_session` / 自动 / HTTPS 时 true。 |
| `CLOUD_TRUST_PROXY` | false；只在可信反代后开启。 |
| `CLOUD_ADMIN_USERNAME` / `CLOUD_ADMIN_PASSWORD` | `admin` / 空；首次无用户时空密码会随机生成。 |
| `CLOUD_MASTER_KEY` | 32 字节 base64 或 64 位 hex；缺省从 `master.key` 读取/生成。 |
| `CLOUD_PORT_RANGE_START` / `CLOUD_PORT_RANGE_END` | `31000`–`39999`。 |
| `CLOUD_NODE_PATH` | 当前 `process.execPath`。 |
| `CLOUD_AGENT_ENTRY` / `CLOUD_LLBOT_ENTRY` / `CLOUD_BILI_BRIDGE_ENTRY` | 三个主要子进程入口。 |
| `CLOUD_NAPCAT_ENTRY` / `CLOUD_SNOWLUMA_ENTRY` | 可选 QQ 驱动入口，存在性需部署机核查。 |
| `CLOUD_UPSTREAM_BASE_URL` / `CLOUD_UPSTREAM_API_KEY` | 初始上游；管理面设置会覆盖。 |
| `CLOUD_DEFAULT_MODEL` | `deepseek-chat`。 |
| `CLOUD_LLBOT_AUTH_TOKEN` | 平台级 LLBot token 的环境回退。 |
| `CLOUD_LLBOT_DESKTOP_QQ_VERSION` | 桌面模式要求的 QQ 完整版本，需与 PMHQ 健康接口返回版本一致。 |
| `CLOUD_RELAY_CUSTOM_ALLOW_PRIVATE` | 默认 false；自定义上游默认只允许公网 HTTPS。 |
| `CLOUD_API_MAX_BODY_BYTES` / `CLOUD_RELAY_MAX_BODY_BYTES` | 1 MiB / 8 MiB。 |
| `CLOUD_SESSION_TTL_MS` | 12 小时。 |
| `CLOUD_DEV_ALLOW_ANY_ORIGIN` | false；生产不要打开。 |

## 3. 数据、端口与密钥

### 3.1 数据布局

```text
<CLOUD_DATA_DIR>/
├── master.key                  缺省生成的 32 字节主密钥
├── cloud.sqlite                SQLite + WAL
├── tenants/<tenant-id>/
│   ├── data/config.json        Agent 配置（含运行所需 Relay Key 明文）
│   ├── extensions/plugins/
│   ├── extensions/skills/
│   ├── qq/<driver>/data/       QQ 配置、session、auth_token.txt
│   └── bili/
│       ├── config.json
│       └── data/              映射、消息、轮询、桥接自己的 secrets/
├── backups/<tenant-id>/*.fmbackup
└── logs/
```

`cloud.sqlite` 当前最新迁移版本为 4，表包括：users/sessions、tenants/memberships、tenant_keys/tenant_secrets、port_leases、qq_accounts、bili_config、relay_keys、wallets/wallet_transactions、reservations/ledger、settings、audit_log、process_runs、backups、tenant_relay_custom、relay_logs、recharges。版本 4 为 ledger 增加 platform、chat_key、run_id、vision、usage_source 归因字段。

备份包含租户文件与密钥状态，使用主密钥 AES-256-GCM 加密并做 SHA-256 完整性校验；恢复会重分端口、重写配置，失败时回滚文件和运行状态。**只复制 `cloud.sqlite` 不足以恢复；主密钥丢失会导致秘密和备份不可解密。**

### 3.2 端口租约

端口池默认 31000–39999。分配器在 SQLite 事务中保证活动端口唯一，并同时检查指定 host 与 `0.0.0.0` 冲突。当前用途：

- `agent.http`：所有 Agent；
- `qq.webui`、`qq.ob11`：QQ 驱动；
- `qq.http`：NapCat/SnowLuma，LLBot 不分配；
- `qq.pmhq`：LLBot desktop 模式的专属回环端口；
- `bili.ob11`：B 站 HTTP/WS/admin 同端口。

同一租户同一 purpose 复用活动租约。停止 Agent 会释放 `agent.http`；QQ/Bili 常规 stop 默认保留端口，显式 release/remove/restore 才释放或重分。LLBot 切回 direct 时释放 `qq.pmhq`，desktop 可请求端口池内的指定端口，已有不同租约时须先切回 direct。恢复备份会清理旧租约再分配。

### 3.3 密钥分层

- 主密钥：环境 `CLOUD_MASTER_KEY` 或 `master.key`，32 字节。
- 租户 DEK：每租户随机 32 字节，由主密钥 AES-256-GCM 包装到 `tenant_keys`。
- 租户秘密：QQ/Bili/Agent token 和 Relay 明文用租户 DEK 加密到 `tenant_secrets`，AAD 含 tenantId 和秘密名。
- 平台设置：上游配置和平台 LLBot token 由主密钥加密到 `settings`。
- Relay Key：数据库索引用 SHA-256 hash + 前缀；运行所需明文另存租户秘密，签发生成 `sk-fish-*`。新绑定会吊销该租户旧活动 Key。
- 密码：scrypt 加盐哈希；panel session/CSRF 在数据库只存 SHA-256 hash。
- B 站 Cookie：桥接另有 `SecretStore`，默认在租户 B 站数据目录生成独立 `secret.key`，不是 cloud SQLite 的同一份存储。

Agent 的 `data/config.json` 必须含 Relay Key 才能调用模型，因此该文件本身是敏感文件；API 不应把它当普通可读配置返回。

## 4. 管理 API

### 4.1 认证与角色

- `POST /api/auth/login` 返回用户、CSRF token 和 HttpOnly SameSite=Lax Cookie。
- 非 GET/HEAD/OPTIONS 请求需要 `X-CSRF-Token`（也接受 `X-XSRF-Token`）或有效同源证据；所有 API 还做 Origin/跨站检查。
- 平台用户角色是 `admin/user`；租户成员角色是 `owner/operator/viewer`，权限依次降低。admin 可跨租户。
- 下表“登录”表示任意已认证用户；“成员”表示至少 viewer；“操作员”至少 operator；“所有者”至少 owner。
- 错误形状通常为 `{ok:false,error,code}`。Relay 不使用 panel Cookie，而使用 Bearer Key。

### 4.2 健康、认证、套餐与租户

| 方法 | 路径 | 权限/说明 |
|---|---|---|
| GET | `/healthz`、`/api/health` | 公开健康检查。 |
| POST | `/api/auth/login` | 公开，`{username,password}`。 |
| POST | `/api/auth/logout` | 注销当前 Cookie 会话。 |
| GET | `/api/me` | 登录，返回用户、CSRF、租户列表。 |
| GET | `/api/plans` | 登录。 |
| GET / POST | `/api/tenants` | 登录；POST 创建 `{name,slug,planId}`，admin 可指定 owner。 |
| GET / PATCH | `/api/tenants/:id` | GET 成员；PATCH 所有者。 |
| POST | `/api/tenants/:id/start` | 操作员且 active。 |
| POST | `/api/tenants/:id/stop` | 操作员。 |
| POST | `/api/tenants/:id/restart` | 操作员且 active。 |
| POST | `/api/tenants/:id/renew` | 所有者；admin 才可显式 `creditMicros`。 |
| POST | `/api/tenants/:id/suspend`、`/api/tenants/:id/resume` | admin。 |
| GET | `/api/tenants/:id/logs` | 操作员，`kind/limit`。 |
| GET | `/api/tenants/:id/audit` | 操作员，`limit`。 |
| GET / POST | `/api/tenants/:id/members` | GET 成员；POST 所有者，`userId` 或 `username` + role。 |
| DELETE | `/api/tenants/:id/members/:userId` | 所有者；租户 owner 不可被移除。 |

### 4.3 QQ 与 B 站

以下路径均前缀 `/api/tenants/:id`：

| 方法 | 后缀 | 权限/说明 |
|---|---|---|
| POST | `/qq/prepare` | 操作员 active；新实例只传 `uin`（别名 `expectedUin`/`qq`）即可默认使用 LLBot direct；也支持 `driver`（别名 `kernel`）、`mode`、`pmhqPort`、`authToken`。desktop 分配专属 PMHQ 端口。 |
| POST | `/qq/start` | 操作员 active；可按需隐式 prepare。 |
| POST | `/qq/stop` | 操作员。 |
| GET | `/qq/status` | 成员。 |
| GET | `/qq/qrcode` | 操作员 active；受 token 状态门控制。 |
| PUT / DELETE | `/qq/auth-token` | 操作员；PUT 必须有 `token` 字段。 |
| GET | `/qq/logs` | 操作员。 |
| POST | `/bili/login/qr` | 操作员 active；必要时启动桥接。 |
| GET | `/bili/login/status` | 成员。 |
| GET | `/bili/status` | 成员。 |
| GET / PUT | `/bili/config` | GET 成员；PUT 操作员，禁止 Cookie/token 字段。 |
| POST | `/bili/logout`、`/bili/start`、`/bili/stop` | 操作员；start 要求 active。 |
| GET | `/bili/logs` | 操作员。 |

B 站配置面向 panel 的订阅键是 `mentions/upVideos/privateMessages/liveRoom`，目标列表是 `videos/upMids/liveRoomIds/liveRoomId`；服务层转换为桥接的 `at/up/dm/live` 和 `videos/ups/liveRooms`。云端配置是订阅类型和目标的权威来源。`bili-watcher` 默认启用；显式禁用会暂停轮询并关闭直播连接，面板显示暂停原因。状态文件读取失败时保留进程内最后有效状态；重启后从租户 Agent 配置恢复明确禁用状态，配置损坏且没有有效状态时暂停轮询。首次尚无状态文件和禁用配置时按默认启用。状态变更由轮询调度器同步，非即时生效。`commentIntervalMs` 最低 15000，配置接口拒绝任何名称疑似 cookie/token/password/secret/auth 的字段。

### 4.4 Relay、备份与管理员

| 方法 | 路径 | 权限/说明 |
|---|---|---|
| GET | `/api/tenants/:id/relay/overview` | 成员，钱包、用量、模型、上游公开状态。 |
| GET | `/api/tenants/:id/relay/models` | 成员，返回允许模型及 allModels。 |
| PUT | `/api/tenants/:id/relay/key` | 所有者，`{key?,model?}`；绑定本平台 Relay 凭据或在无活动 Key 时按条件签发，模型受套餐白名单限制。 |
| GET / PUT / DELETE | `/api/tenants/:id/relay/custom` | GET 成员；PUT/DELETE 所有者，配置或删除自定义上游 `{baseUrl,apiKey,model}`，更新时可省略 `apiKey` 保留旧值。 |
| GET | `/api/tenants/:id/relay/logs` | 成员，支持 `days/limit/model/status` 筛选。 |
| GET / POST | `/api/tenants/:id/billing/recharges` | GET 成员；POST 所有者，`{amountMicros}` 创建待审核申请。 |
| POST | `/api/admin/recharges/:id/confirm` | admin；确认申请并到账，不校验实际支付。 |
| POST | `/api/tenants/:id/relay/topup` | admin，`{amountMicros,note}`。 |
| POST | `/api/tenants/:id/backup` | 所有者。 |
| GET | `/api/tenants/:id/backups` | 成员。 |
| POST | `/api/tenants/:id/restore` | 所有者且 active，`{backupId,restart?}`。 |
| GET / POST | `/api/admin/users` | admin；POST 创建用户，密码至少 8 位。 |
| GET | `/api/admin/users/:userId/tenants` | admin；返回 `{ok, user, tenants}`，`user` 为公开信息，`tenants` 为按所有者查询的实例摘要；未知用户 404，普通用户 403。 |
| GET / PUT | `/api/admin/upstream` | admin；PUT `{baseUrl,apiKey?,clear?}`，不返回明文 Key。 |
| GET / PUT | `/api/admin/llbot-auth-token` | admin；GET 只返回 hasToken。 |
| GET | `/api/admin/audit` | admin，可按 tenantId/limit。 |

### 4.5 Relay 独立端点

| 方法 | 路径 | 认证/行为 |
|---|---|---|
| GET | `/health`、`/v1/health` | 公开。 |
| GET | `/v1/models`（也兼容 `/models`） | Bearer Relay Key；平台渠道返回套餐允许模型，自定义渠道返回配置的模型。 |
| POST | `/v1/chat/completions`（也兼容 `/chat/completions`） | Bearer Relay Key，支持普通 JSON 和 SSE stream。 |

聊天请求必须有非空 `messages`；平台上游要求套餐允许的 `model`，自定义上游要求请求模型与所配置模型一致。`max_tokens/max_completion_tokens` 不能超过套餐上限。转发字段白名单包括 messages、采样参数、tools/tool_choice、response_format、reasoning/thinking 等；Relay 统一重写 `max_tokens` 和 `stream`，流式请求附加 `stream_options.include_usage=true`。

成功非流式响应带 `x-fish-request-id`、`x-fish-cost-micros`。上游失败、无响应或无效 JSON会释放预占；成功才按 usage 结算。缺少 usage 时按文本启发式估算，因此它不是上游原生账单。

## 5. 套餐与计费模型

金额单位统一是**微元（micro-yuan）**：`1,000,000 micros = 1 CNY`。钱包字段：`balanceMicros` 总余额、`heldMicros` 活跃预占、`availableMicros = balance - held`。

| plan | 初始额度 | 续费赠送 | 时长 | RPM | TPM | 最大输出 | 并发 | 非 admin 租户数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| trial | 10 元 | 0 | 14 天 | 10 | 50,000 | 2,048 | 2 | 1 |
| starter | 30 元 | 30 元 | 30 天 | 60 | 300,000 | 4,096 | 4 | 3 |
| pro | 150 元 | 150 元 | 30 天 | 240 | 2,000,000 | 8,192 | 12 | 10 |

非管理员创建时，统计该 owner 已拥有的所有实例，并与本次所选套餐的租户数上限比较；成员身份不计入拥有数，管理员创建不受此数量检查。默认 trial 上限为 1；选择其他套餐不意味着已付款，当前没有支付前置校验。

静态模型价格（元/百万 token）：

| model | 输入 | 缓存输入 | 输出 |
|---|---:|---:|---:|
| deepseek-chat | 2 | 0.5 | 8 |
| deepseek-reasoner | 4 | 1 | 16 |
| gpt-4o-mini | 1 | 0.5 | 4 |

平台上游请求流程：

1. 估算 prompt token 与最大输出，预占公式为 `(prompt*input + maxOutput*output)/1e6 * 1.15`，向上取整微元；实现还会用请求原始字节数作为保守 prompt 下界。
2. 检查 RPM、TPM（估算 prompt + max output）、并发和可用余额；余额不足返回 402，超额通常 429。
3. 成功后按真实/回退 usage 结算：`uncached*input + cached*cachedInput + completion*output`，从钱包扣除并写 ledger；预占本身不先扣钱包。
4. 失败释放 reservation；过期 hold 标记 expired 后不再计入 held。成功流式在结束/中断时按已获得 usage 或回退估算结算。

自定义上游仍使用本地 Relay Key 鉴权，并受租户状态、套餐速率与并发限制；不预占或扣减平台钱包，Relay 日志的费用为 0，不能据此推断外部上游实际收费。配置保存会校验 URL 和解析结果，实际调用时再次解析，但不会验证上游凭据或模型可用性。

平台 ledger 用量汇总包含 `byChat`（按 UTC 日期、模型、platform、chatKey）、`usageSources`（reported/estimated/unknown）、`visionRequests` 和 `visionRequestCostMicros`；后者是带视觉标记请求的总费用，不是单独图像费用。`run_id` 存于 ledger，汇总不按它分组；缺失归因字段可为 null，旧记录来源可为 unknown。自定义上游请求记录在 relay_logs，不进入平台钱包的 ledger 费用汇总。

平台上游新增模型不能只改上游：必须同步 `plans.js` 的 `MODEL_CATALOG`、套餐 `models` 白名单和测试，否则模型无法通过套餐门，且价格/预算语义不完整。

## 6. 云端配置锁定

Gateway 的 `config-guard.js` 不是装饰：它禁止云端 Agent 配置接口修改 `server/extensions/channels/snowluma/providers` 等云管字段，锁定 `api.baseUrl/apiKey/provider/fallbackModels`，并强制：

- `allowAllWhenEmpty=false`；
- `tools.crossChatSend=false`；
- `security.allowPrivateImageHosts=false`；
- 删除 webSearch 自定义 endpoint/URL 等 SSRF 风险字段；
- `/api/media-data` 删除本地 path/file/localPath；
- 管理 API allowlist 之外的 Agent 管理路由直接 403，例如 `/api/reset-data`。

因此租户控制台与本地控制台不是完全相同的权限面。修改核心配置字段时，要同时决定是否允许云端暴露，并补 guard 测试。
