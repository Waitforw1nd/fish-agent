# QQ 与 B 站协议接入指南

项目通过 OneBot 形态的适配器将 QQ 协议、官方 QQ Bot、桌宠和 B 站接入 `qq-agent-core`。`ChannelRouter` 使用不重叠的数字 ID 区间及官方 Bot 专用字符串 ID 隔离入口，未知目标直接拒绝。

对应主要源码：
- 核心路由与发送：`packages/qq-agent-core/src/{channel-router,onebot,sender}.js`
- B 站协议桥接：`packages/protocol-bili-bridge/src/{bridge,mapping/ids,onebot/*,bili/*}.js`
- 云端协议编排：`packages/cloud-manager/src/{qq-service,bili-service}.js`、`src/qq/{napcat,llbot,switch}.js`

---

## 1. 双通道数字 ID 路由（`ChannelRouter`）

QQ 协议与 B 站使用数字 ID；官方 Bot 保留 `qqbot_*` 字符串会话 ID。桌宠会话使用独立数字段，消息使用 UUID。安全整数空间按下表分配：

| 平台 | 默认数字 ID 区间 | 用途 |
|---|---|---|
| **QQ** | `[1, 4503599627370495]`（`1 ~ 2^52-1`） | 真实 QQ 号、QQ 群号与消息 ID。 |
| **B 站** | `[4503599627370496, 7318349394477055]` | 现有五类映射，不迁移已分配 ID。 |
| **桌宠** | `[7318349394477056, 7881299347898367]` | 私聊用户使用 `[7459086882832384, 7599824371187711]`；云端分配。 |
| **保留** | `[7881299347898368, 9007199254740991]` | 未启用；官方 Bot 继续使用字符串，避免破坏现有会话和白名单。 |

旧配置恰为完整 B 站默认段时自动收窄为五类实际映射范围；自定义重叠或侵占保留段的配置拒绝启动。桌宠协议见 [desktop-protocol.md](desktop-protocol.md)，设计取舍见 [multi-entry-implementation.md](multi-entry-implementation.md)。

### B 站内部虚拟 ID 子区间

`protocol-bili-bridge` 将 B 站区间按 `2^49` 步长细分为 5 类虚拟 ID，映射关系按租户持久化在 `<BILI_BRIDGE_DATA_DIR>/mapping.json` 中：

| 子类型 | 起点 | 终点 | 映射对象 |
|---|---:|---:|---|
| `video` | `4503599627370496` | `5066549580791807` | 视频评论区（作为虚拟群 `group:<id>`） |
| `dynamic` | `5066549580791808` | `5629499534213119` | 动态评论区（作为虚拟群 `group:<id>`） |
| `live` | `5629499534213120` | `6192449487634431` | 直播间（作为虚拟群 `group:<id>`） |
| `user` | `6192449487634432` | `6755399441055743` | B 站用户 UID（含机器人自身 `self_id`） |
| `message` | `6755399441055744` | `7318349394477055` | OneBot `message_id` |

### 路由安全规则

- **严禁跨平台回退**：目标 ID 超出区间、对应平台未启用、或显式指定的 `platform` 与 ID 所属区间冲突时，直接抛错拒绝发送，绝不会退回到默认 QQ 通道。
- **保留动作前缀**：`bili_*` 开头的自定义动作固定路由到 B 站通道。
- **自发消息与去重**：自动过滤机器人自身发出的消息（`sender === self_id`），并按平台独立维护 10 分钟事件去重窗口。

---

## 2. QQ 协议接入（NapCat 与 LLBot）

### 2.1 NapCat（云端新实例默认）

- **运行方式**：每个实例对应独立 Docker 容器，容器内 OneBot HTTP（`3000`）、OneBot WS（`3001`）、WebUI（`6099`）仅映射至宿主机 `127.0.0.1` 的动态租约端口。
- **扫码与换码**：面板通过同源 API 代理 NapCat WebUI 获取登录二维码；未登录状态下支持调用 `POST /api/tenants/:id/qq/qrcode/refresh` 刷新二维码。
- **媒体策略**：容器模式下图片和表情采用受限 `inline-base64` 发送（单图上限 5 MiB），拒绝直接读取容器本地路径，防止路径越界。
- **镜像准备**：宿主机需预先拉取并固定 `CLOUD_NAPCAT_IMAGE`（见 [deploy/napcat/README.md](../deploy/napcat/README.md)）。

### 2.2 LLBot（Direct / Desktop 模式）

- **构建要求**：使用前需在仓库根目录执行 `npm run llbot:build` 生成 `packages/protocol-qq-llbot/dist/llbot.js`。
- **Direct 模式与 `auth_token`**：
  - Direct 模式无需安装桌面 QQ，但在拉取二维码前必须具备有效的登录签名授权 `auth_token`（注意：它不是 OneBot 连接密码）。
  - 云端按 **单实例 `qq.auth_token` → 平台设置 `llbotAuthToken` → 环境变量 `CLOUD_LLBOT_AUTH_TOKEN`** 顺序查找授权；授权校验为 `valid` 后才可获取二维码。
- **Desktop 模式**：连接宿主机已运行的独立桌面 QQ 与 PMHQ 端口（需版本与 `CLOUD_LLBOT_DESKTOP_QQ_VERSION` 严格一致），不使用 Direct `auth_token`。
- **常用命令行参数**：`-q <uin>` / `--qq <uin>`（指定账号并隔离配置）、`--pmhq-port <port>`（启用 Desktop/PMHQ 模式）、`--cdn cf|china`（或环境变量 `CDN`，切换签名授权接入点）、`--protocol linux|windows|macos|watch`（默认 `linux`）。
- **错号保护**：无论使用 NapCat 还是 LLBot，扫码登录后的实际 QQ 号若与实例预设 QQ 号不一致，云端会立即停止协议端并标记 `uin_mismatch`。

### 2.3 官方 QQBot（QQ 开放平台，headless 模式）

不走 NTQQ 协议、不受个人号风控影响的官方接入：`modules/headless/qqbot.js` 的 `QQBotClient` 直连 QQ 开放平台 WebSocket 网关，把官方事件归一化为 OneBot v11 形态进入核心。

- **启用方式**：headless 控制台连接页（或 `connection` 配置）选择 `type: 'qqbot'`，填写 AppID / AppSecret，`sandbox` 对应沙箱环境，`intents` 默认 `1 << 25`（群 @ 消息 + C2C 私聊；纯群/私聊机器人不要叠加频道公域位 `1 << 30`，否则网关以 4013/4014 断开）。
- **会话 ID**：官方 OpenID 包装为字符串 ID —— `qqbot_group_<openid>`（群）、`qqbot_user_<openid>`（C2C 私聊）、`qqbot_channel_*` / `qqbot_dm_*`（频道）。`ChannelRouter` 与 `SendGuard` 识别该形态并固定路由到启用了官方适配器的 QQ 通道；数字号段规则对其他通道不变。白名单（`allow.groups` / `allow.private`）需填写这些字符串 ID。
- **前置条件**：q.qq.com 机器人管理后台需配置**本机公网出口 IP 白名单**（否则 `getAppAccessToken` 失败）、开启事件订阅、把机器人拉进目标群。
- **本仓库适配器行为**
  - 被动回复必须绑定未过期入站消息 `msg_id`。代码将群和 C2C 回复窗口分别限制为 5 分钟、1 小时，单条入站消息分别最多回复 5 次、4 次。
  - 缺少回复锚点、窗口过期或次数用尽时，发送操作明确报错，需等待新的入站消息。创建定时提醒时同样返回不支持，避免承诺无法送达的提醒。
  - **全量消息接收**：群主开启「接收群内全部消息」后推送 `GROUP_MESSAGE_CREATE`（与群 @ 共用 intent `1 << 25`，无需改配置）；事件中 `mentions` 含机器人时按 @ 处理。
  - 图片仅支持公网 HTTP(S) URL（先经 `/files` 上传），不支持本地文件 / base64。
  - 不支持拍一拍、指定 @、合并转发、禁言等 OneBot 扩展动作（调用会明确报错，不会静默落到别处）。
  - 群列表 / 好友列表只包含活跃会话（官方 API 不提供全量列表）。
- **冒烟测试**：`QQBOT_APP_ID=... QQBOT_APP_SECRET=... node packages/qq-agent-core/scripts/qqbot-smoke.mjs [--sandbox] [--listen 120]`，连接网关、等待 READY、收到第一条消息后被动回显一次，用于验证凭证 / IP 白名单 / 事件订阅是否就绪。

---

## 3. B 站协议桥接（`protocol-bili-bridge`）

### 3.1 端口、环境变量与鉴权

独立运行时默认在 `127.0.0.1:36501` **单端口同时提供三类接口**（启动成功后向 `stdout` 输出单行 `{"event":"ready",...}` JSON，运行日志统一输出到 `stderr`）：
- `GET /health`：无鉴权健康检查。
- **OneBot v11 HTTP & 正向 WS**：`POST /`、`POST /<action>` 以及 WebSocket（`/`、`/ws`、`/onebot/v11/ws`），校验 `BILI_ONEBOT_TOKEN`（至少 8 位）。
- **管理接口 `/admin/*`**：用于扫码登录、订阅配置与状态查看，校验请求头中的 `BILI_ADMIN_TOKEN`（至少 12 位，且不能与 OneBot Token 相同）。
- **常用环境变量**：`BILI_BRIDGE_DATA_DIR`（默认 `./var/bili-bridge`）、`BILI_BRIDGE_TENANT`、`BILI_ONEBOT_HOST` / `BILI_ONEBOT_PORT`（默认 `127.0.0.1:36501`）、`BILI_SUBSCRIBE_{AT,UP,DM,LIVE}`、`BILI_WATCH_{VIDEOS,UPS,LIVE_ROOMS}`。

> **手工直连提示**：`qq-agent-core` 单机默认示例端口为 `3100/3101`，手工直连独立桥接器时，请将 `channels.bili.httpUrl` 和 `channels.bili.wsUrl` 均设为 `http://127.0.0.1:36501` / `ws://127.0.0.1:36501`（云端模式下由 `cloud-manager` 自动分配并写回）。

### 3.2 支持的 OneBot Action 与自定义动作

- **标准动作**：`get_login_info`、`get_status`、`get_version_info`、`send_group_msg`、`send_private_msg`、`send_msg`、`get_msg`、`get_group_info`、`get_group_list`、`get_group_member_info`、`get_group_member_list`（桥接本身还实现 `get_friend_list`、`get_stranger_info`、`can_send_image`、`can_send_record`；若需从核心透传新动作，须同步更新核心 `channel-router.js` 的 `BILI_SUPPORTED_ACTIONS`）。
- **B 站专属动作（`bili_*`）**：
  - `bili_get_video_context`：读取视频详情、分 P、热评与字幕。
  - `bili_inspect_user`：读取 B 站用户公开资料与近期投稿/动态。
  - `bili_reply_comment`：回复指定视频或动态评论。
  - `bili_like`：评论点赞或取消点赞。
  - `bili_live_send_msg`：向直播间发送弹幕。

### 3.3 消息段与限频保护

- **支持的消息段**：`text`、`at`（须引用已映射的 B 站虚拟用户 ID）、`reply`、`image`（**仅限私信**：支持单张 ≤ 5 MiB 的 PNG/JPEG/GIF `base64://` 或 Data URL 图片；评论区与直播弹幕不支持发图）。
- **内置防刷屏限频**：评论间隔 ≥ 15 秒（最多 1000 字，超长拒绝而不拆条刷屏）、私信间隔 ≥ 6 秒（≤ 2000 UTF-8 字节）、直播弹幕间隔 ≥ 3 秒（默认 ≤ 20 字）。

### 3.4 `/admin/*` 管理接口速查

| 方法与路径 | 说明 |
|---|---|
| `GET /admin/health`、`/admin/status`、`/admin/account` | 服务存活、轮询/直播状态与公开账号信息（不回显 Cookie）。 |
| `POST /admin/login/qr`、`GET /admin/login/qr?key=...` | 生成 B 站 App 扫码登录二维码并轮询状态（成功后自动加密保存 `SESSDATA` 与 `refresh_token`）。 |
| `POST /admin/refresh`、`/admin/logout`、`/admin/risk/clear` | 保活刷新 Cookie、退出登录、清除风控标记。 |
| `GET / PUT /admin/subscriptions` | 开关四类订阅 `{ at, up, dm, live }`。 |
| `GET / PUT /admin/watches` | 配置监控列表 `{ videos, ups, liveRooms }`。 |
| `GET /admin/mapping`、`/admin/messages`、`POST /admin/live/reconnect` | 查看虚拟 ID 映射、最近消息或重连直播间。 |
