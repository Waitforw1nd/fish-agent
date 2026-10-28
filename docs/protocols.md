# QQ / Bili 协议与身份契约

对应源码：

- `packages/qq-agent-core/src/{channel-router,config,onebot,sender}.js`
- `packages/protocol-bili-bridge/src/{bridge,mapping/ids,onebot/*,bili/auth}.js`
- `packages/cloud-manager/src/{qq-service,qq/llbot,bili-service,agent-runtime}.js`
- `packages/protocol-qq-llbot/src/main/qqProtocol/direct.ts`

## 1. ChannelRouter 数字虚拟 ID 契约

### 1.1 顶层号段

核心默认把整个安全整数空间划成两个不重叠区间：

| 平台 | 默认闭区间 | 约束 |
|---|---|---|
| QQ | `[1, 4503599627370495]`，即 `[1, 2^52-1]` | 真实 QQ 号/群号。 |
| Bili | `[4503599627370496, 9007199254740991]`，即 `[2^52, 2^53-1]` | 桥接生成的虚拟群、用户、消息和 self ID。 |

可通过 `channels.qq.idRange`、`channels.bili.idRange` 覆盖，接受 `{start,end}` 或 `[start,end]`，但必须是正的安全整数、start 不大于 end，且两个区间不得重叠。配置解析和 Router 构造都会拒绝重叠。

`chatKey` 仍是 `group:<数字>` 或 `private:<数字>`。Router 按目标 ID 而不是调用顺序选通道；以下情况直接抛错，绝不回落到默认 QQ：

- ID 非正安全整数、落在所有已配置区间之外；
- 落入未启用通道；
- 显式 `platform` 与 ID 所属通道冲突；
- B 站不支持的 action 或消息段；
- `at.qq`、`atUserId`、群成员 ID 与目标群不属于同一平台。

显式平台可用 `call(action, params, timeout, {platform:'bili'})`，也可在 params 中写 `__platform`/`__channel`；这两个内部字段会在调用协议端前剥掉。

### 1.2 B 站内部五个子号段

桥接每类分配 `2^49 = 562949953421312` 个 ID：

| 类型 | base（闭区间起点） | 闭区间终点 | OneBot 含义 |
|---|---:|---:|---|
| video | 4503599627370496 | 5066549580791807 | 视频评论区虚拟群。 |
| dynamic | 5066549580791808 | 5629499534213119 | 动态虚拟群。 |
| live | 5629499534213120 | 6192449487634431 | 直播间虚拟群。 |
| user | 6192449487634432 | 6755399441055743 | B 站用户虚拟 ID，也用于账号 self。 |
| message | 6755399441055744 | 7318349394477055 | OneBot `message_id`。 |

剩余高位空间当前未分配。分配以 `tenantId + 类型 + 原生键` 的哈希为起点，冲突时线性探测；映射持久化在 `<BILI_BRIDGE_DATA_DIR>/mapping.json`，同租户可逆、跨租户拒绝加载。BVID、aid、dynamicId、roomId、mid、超精度 rpid 等原生字符串只留在内部记录，不能直接代替 OneBot 数字 ID。

### 1.3 message_id 与事件语义

- B 站消息 ID 使用 message 子号段和持久化 ring，默认容量 500；事件中的 `self_id/group_id/user_id/message_id` 都必须是安全整数。
- 核心另记录“见过的 message_id → 平台集合”，保留 24 小时、默认最多 5000 个键。两个平台撞号时必须显式给 `platform`，不能猜。
- 重启前或从未见过的消息，在双通道启用时没有归属记录，也必须显式给平台；只有单通道启用时才可安全回落。
- `message_sent` 和发送者等于本通道 self 的事件被过滤；重复事件按平台隔离，默认 10 分钟去重。
- `get_group_list` 默认聚合所有支持它的已启用通道；单通道失败不抹掉另一通道结果。`get_friend_list` 也走聚合能力筛选，当前核心不把 B 站实现列入默认能力。
- Router 顶层兼容状态锚定默认通道（QQ 优先），每个通道的真实状态在 `status().channels.qq/bili`。

## 2. B 站 OneBot 服务

### 2.1 传输与鉴权

独立桥接默认监听 `127.0.0.1:36501`，同一端口提供：

- `GET /health`：无认证健康信息。
- HTTP action：`POST /` 接收 `{action,params,echo}`，或 `POST /<action>` 直接接收参数。
- 正向 WS：默认 `/`，另允许 `/ws`、`/onebot/v11/ws`；事件推送，也接受 `{action,params,echo}`。
- admin：`/admin/*`，与 OneBot token 独立。

OneBot token 可放 `Authorization: Bearer ...`、`x-access-token` 或 WS/HTTP query 的 `access_token`。admin token 只接受请求头：`Authorization: Bearer ...`、`x-admin-token`（实现也兼容 `x-access-token`），不要放 URL。

绑定非回环地址时必须同时设置两种 token，除非显式允许 `BILI_ALLOW_REMOTE_WITHOUT_TOKEN`；即使该开关放开 OneBot，非回环仍强制 admin token。生产不应依赖回环裸奔。

### 2.2 标准 action 清单

桥接 `SUPPORTED_ACTIONS` 当前为：

| 分类 | action |
|---|---|
| 身份/状态 | `get_login_info`、`get_status`、`get_version_info` |
| 发送 | `send_group_msg`、`send_private_msg`、`send_msg` |
| 消息/群 | `get_msg`、`get_group_info`、`get_group_list`、`get_group_member_info`、`get_group_member_list` |
| 用户 | `get_friend_list`、`get_stranger_info` |
| 能力探测 | `can_send_image` 对私信图片返回支持；`can_send_record` 返回 `{yes:false}` |
| 自定义 | `bili_get_video_context`、`bili_inspect_user`、`bili_reply_comment`、`bili_like`、`bili_live_send_msg` |

未知 action 返回 OneBot failed envelope，通常 `retcode=1404`，不会伪装成功。

**核心与桥接能力表不是同一个列表。** 核心 `BILI_SUPPORTED_ACTIONS` 默认放行发送、消息/群查询和身份状态，但当前未列入桥接已有的 `get_friend_list`、`get_stranger_info`、`can_send_image`、`can_send_record`。通过核心调用时应以核心能力表为准；直接连接桥接时才以桥接表为准。新增 action 要同步两侧及测试。

### 2.3 custom action 参数

| action | 主要参数 | 行为 |
|---|---|---|
| `bili_get_video_context` | `bvid`/`aid`/`url` 或视频映射 `group_id`，可选 `cid`、`includeSubtitles`、`includeComments`、`download` | 视频详情、分 P、可选字幕/热评。 |
| `bili_inspect_user` | `mid` 或 `user_id`，可选 `includeVideos`、`includeDynamics` | 用户公开资料，可带近期投稿和动态。 |
| `bili_reply_comment` | `bvid`/`oid`/`aid`，`message` 或 `text`，可选 `root/rootId`、`parent/parentId` | 回复评论。 |
| `bili_like` | `rpid` 或 `commentId`，视频定位 `oid`/`bvid`/`aid`，`action` | 评论点赞/取消；底层按参数处理。 |
| `bili_live_send_msg` | `room_id`/`roomId`，`text`/`message` | 发直播弹幕。 |

核心把 `bili_*` 视为 B 站保留命名空间，即使没有目标 ID 也不会误发 QQ。其他无目标未知 action 默认仍走默认通道，因此新增非 `bili_` 前缀的 B 站动作必须显式 `platform:'bili'`，并在 `channels.bili.extraActions` 声明。

`bili-agent-pack` 注册四个 LLM 工具：视频上下文、用户资料、回复评论、点赞。后两者要求 `confirm=true`；评论回复还经过 `send.guard`。工具只允许在 B 站会话直接调用 Router，避免从 QQ 会话发起跨平台操作。

### 2.4 消息段的实际有效交集

核心允许 B 站 `text/at/reply/image`，并拒绝 video、face、record、合并转发等。桥接私信支持单张不超过 5 MiB 的 PNG/JPEG/GIF，接受 `base64://` 或图片 data URL，先上传再发送图片消息；文字需单独发送。评论和直播弹幕仍不支持图片，普通 URL 或文件路径不由桥直接读取。此链路目前只经过模拟协议测试，真实账号仍需验收。动态通知按动态 ID 映射群，评论主体从详情的 `comment_type` 和 `comment_id_str` 获取，type 11 的 OID 不等同动态 ID。

@ 必须引用已映射的 B 站虚拟用户，并校验昵称与 mid；reply 引用消息 ID 必须是非零整数。评论/弹幕/私信不会静默丢弃不支持的段，而是返回错误。

## 3. B 站 admin API

所有路径都以 `/admin` 开头并要求 admin token；未配置 admin token 时整个管理面返回 503。响应外层为 `{ok:true,data}` 或 `{ok:false,error:{kind,code,retcode,wording}}`，不返回 Cookie、refresh token 等秘密。

| 方法 | 路径 | 用途/主要输入 |
|---|---|---|
| GET | `/admin/health` | 服务、版本、tenantId、uptime。 |
| GET | `/admin/status` | 账号、轮询、直播、队列等运行状态。 |
| GET | `/admin/account` | 公开账号状态。 |
| GET | `/admin/version` | OneBot 版本信息。 |
| POST | `/admin/login/qr` | 创建 B 站扫码。 |
| GET | `/admin/login/qr?key=...` 或 `/admin/login/qr/<key>` | 轮询扫码状态。 |
| POST | `/admin/logout` | 清除登录会话和 QR 状态。 |
| POST | `/admin/refresh` | Cookie 保活，`{force?:boolean}`。 |
| POST | `/admin/risk/clear` | 清除风控状态。 |
| GET / PUT / POST | `/admin/subscriptions` | 读取/修改 `{at,up,dm,live}`。 |
| GET / PUT / POST | `/admin/watches` | 读取/修改 `{videos,ups,liveRooms}`。 |
| GET | `/admin/mapping` | 虚拟 ID 映射快照。 |
| GET | `/admin/messages?limit=20` | 最近消息，limit 1–200。 |
| POST | `/admin/live/reconnect` | 重连直播，`roomId` 可放 body/query。 |

### 3.1 B 站扫码与凭据

真实实现调用 B 站 passport：

1. `GET /x/passport-login/web/qrcode/generate` 获取登录 URL 和 `qrcode_key`。
2. admin 创建接口返回 `pending` 状态、URL、180 秒本地 TTL；cloud-manager 再把 URL 渲染成 PNG data URL。
3. 轮询 `/x/passport-login/web/qrcode/poll`，状态映射为 `pending/scanned/success/expired`。
4. 成功时从 Set-Cookie 或跳转 URL 收集凭据，必须拿到 `SESSDATA`；保存 `refresh_token`，再读取 `/x/web-interface/nav` 获取公开账号信息。
5. Cookie 和 refresh token 写入 AES-256-GCM `SecretStore`，管理状态只暴露公开快照。

未登录但执行写操作时会要求重新扫码；缺少 `bili_jct` 也会失败。二维码 key 和登录 URL 只按需在登录接口返回，例行 status 会删除它们。

## 4. 独立桥接与核心的端口配置

核心独立默认：

```text
channels.bili.wsUrl   = ws://127.0.0.1:3101   （PROFILE 会偏移）
channels.bili.httpUrl = http://127.0.0.1:3100 （PROFILE 会偏移）
```

独立桥接默认却是同端口 `36501`。手工连接时，例如桥接监听 36501，则核心应配置：

```json
{
  "channels": {
    "bili": {
      "enabled": true,
      "wsUrl": "ws://127.0.0.1:36501",
      "httpUrl": "http://127.0.0.1:36501",
      "accessToken": "<BILI_ONEBOT_TOKEN>",
      "httpAccessToken": "<BILI_ONEBOT_TOKEN>"
    }
  }
}
```

这里只展示结构，不要写入真实 token。cloud-manager 不使用上述静态端口：它从端口池分配 `bili.ob11`，同时写入 Agent 的 WS/HTTP URL。

## 5. LLBot `auth_token` 与真实扫码流程

### 5.1 token 不是 OneBot token

LLBot Direct 的 `auth_token` 用于 native sign/登录授权，不是核心连接 OneBot 的 Bearer token。云端每租户还有独立的 `qq.onebot_token` 和 WebUI 密码，三者不可混用。

云端 token 来源优先级：

1. API 显式提交并保存的租户 token（`tenant_secrets` 中的 `qq.auth_token`）；
2. 管理面 `platform.llbotAuthToken`；
3. 环境变量 `CLOUD_LLBOT_AUTH_TOKEN`；
4. 都无则为 `none`，启动后状态是 `auth_required`。

租户 token 格式要求 8–4096 字符且不含换行。管理 API 只返回是否存在和校验状态，不回显 token。LLBot 本身按 `data/auth_token.txt` 优先、`AUTH_TOKEN` 环境变量兜底。

### 5.2 cloud-manager 驱动流程

1. `POST /api/tenants/:id/qq/prepare`，body 至少 `{driver:'llbot',uin:'5-12位QQ号'}`，可带 `authToken`。驱动写入 `config_<uin>.json`、`webui_token.txt` 和可选 `auth_token.txt`。
2. `POST .../qq/start`，实际命令为 `node dist/llbot.js -q <uin>`，WebUI/OneBot WS 绑定动态回环端口。缺 `dist/llbot.js` 返回 `LLBOT_NOT_BUILT`。
3. `GET .../qq/status` 读取 LLBot `/api/login-info` 和 `/api/auth-token/status`。
4. 没有 token、token invalid/error 时，`GET .../qq/qrcode` 分别被 409 `AUTH_TOKEN_REQUIRED`/`AUTH_TOKEN_INVALID` 拦截；validating 时返回 `AUTH_TOKEN_VALIDATING`。
5. `PUT .../qq/auth-token` 设置租户 token；运行中会调用 LLBot `POST /api/auth-token`。`DELETE` 清除租户 token，运行中清空文件后需要重启语义。
6. token valid 后，二维码接口代理 LLBot `/api/login-qrcode`，返回 `qrcodeUrl/pngBase64/expireAt/pollTimeInterval`。
7. 手机 QQ 扫码并确认，之后轮询 `qq/status`，直到 `online=true` 且 uin/nickname 正确。
8. 若实际登录 UIN 与预期不一致，cloud-manager 停止协议端并标记 `uin_mismatch`，不会把错误账号继续挂到 Agent。

管理员可通过 `GET/PUT /api/admin/llbot-auth-token` 查看/设置平台级 token 的存在性/内容；PUT 接受 `{token}`，空字符串删除。

LLBot 的 action 通过 OneBot WS 传输；云端不分配 HTTP action 端口。其他驱动使用各自的 HTTP action 端口。独立核心可用 `channels.qq.apiTransport` 显式选择 `ws` 或 `http`；旧配置默认 HTTP，显式 `connection` 优先。

`prepare` 可选 `mode: 'direct'` 或 `mode: 'desktop', pmhqPort: <端口>`；端口可留空由平台端口池分配，指定端口必须在池内且空闲。平台持久化租户专属租约并展示端口，启动时核对租约后将端口交给 LLBot 的 `--pmhq-port`。桌面模式要求已有本机专属 PMHQ，读取其 `/health` 版本和账号，且必须与平台环境配置 `CLOUD_LLBOT_DESKTOP_QQ_VERSION` 完全一致。未知版本、连接失败或账号不一致会阻止启动。此功能尚不负责启动独立 QQ 或注入 PMHQ；租约不是操作系统级权限隔离，必须由部署环境提供隔离后才能上线。桌面模式不使用 Direct 的 Auth Token。

NapCat 扫码使用上游 WebUI `/api/auth/login` 和 `/api/QQLogin/{CheckLoginStatus,GetQQLoginQrcode}`，返回 `pending`、`ready`、`scanned` 或 `success`，返回的 QR URL 由服务端生成 PNG；上游不提供有效期时不推测到期时间。部署应验证所选发行版的启动路径及 WebUI 配置。SnowLuma 当前公开版本要求 QQ 客户端登录并接入进程，尚无已验证的远程取码接口；云端返回 `QRCODE_UNSUPPORTED`，需提供支持独立客户端扫码的组件后才能完成面板扫码。

### 5.3 LLBot Direct 内部真实状态机

`authTokenWatcher` 启动和文件变化时读取 token，先调用 `validateAuthToken`：

- `valid`：回调 `DirectQQProtocol.onAuthTokenValid`，初始化 native Direct client。
- `invalid`：不进入登录，避免 native sign 崩溃循环。
- 网络 `error`：不冒险登录，15 秒后重试。

Direct client 先尝试恢复加密 session；恢复失败则 fresh QR。拉码使用 QQ native 连接，后台每 2 秒轮询，区分等待、待确认、confirmed、expired/cancelled；确认后完成 native 登录、等待 sign token、注册上线、保存 session 并启动心跳。WebUI `/api/login-info` 才是云端判断在线的来源。

**验证边界：仓库 `fake-llbot.mjs` 只模拟 WebUI token 状态、二维码响应和手工上线，不执行 native sign、真实 QQ TCP、手机确认或 session 恢复。上述真实 QQ 流程当前未在线验证。**
