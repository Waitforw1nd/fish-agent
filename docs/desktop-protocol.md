# 桌宠协议 v1

桌宠是云端租户的用户入口。设备不能调用 OneBot action、控制台 API 或选择另一个租户或用户。

## 配对与设备权限

1. 在用户工作台或管理员租户页启用桌宠入口，启动实例并配置模型渠道。
2. owner/operator/admin 调用 `POST /api/tenants/:id/desktop/pairing-codes` 获取 8 位、10 分钟有效、一次性的配对码和二维码。
3. 客户端向服务地址发送 `POST /desktop/v1/pair`，JSON 为 `{code, deviceName, os}`。
4. 响应含 `{deviceId, deviceToken, desktopUserId, tenantSlug, wsUrl}`。令牌明文仅在此响应返回；数据库保存 SHA-256，客户端使用 Electron safeStorage，安全存储不可用时拒绝配对。
5. `GET /api/tenants/:id/desktop/devices` 列出不含令牌的设备资料；`DELETE .../devices/:deviceId` 吊销设备并关闭已有连接。

设备令牌不能作为面板登录凭据。设备继承绑定用户在租户内的权限；用户失权、租户到期或停用、入口关闭均使凭据不可用。每用户最多三台设备；套餐配置有限席位时，配对检查资源上限，不新增货币扣款。

外部服务通过 `CLOUD_PUBLIC_SCHEME`、`CLOUD_BASE_DOMAIN`、可选 `CLOUD_PUBLIC_PORT` 生成地址，客户端不信任任意跨源 wsUrl。生产连接使用 HTTPS/WSS；开发客户端仅允许 loopback 明文连接。

## WebSocket 与能力协商

连接 `/desktop/v1/ws`，由 Electron 主进程设置 `Authorization: Bearer fdt_...`。不接受 URL 令牌、Cookie 鉴权、任意路径或浏览器 Origin。网关只转发至对应租户的 loopback `/channels/desktop/ws`，重新生成 console token、device id 和数值用户 ID 请求头，不透传客户端伪造的身份头。

帧为 `{v:1, op, id?, seq?, ts?, d}`，仅接受文本 JSON；连接后 10 秒内发送 hello，每 30 秒应用心跳，90 秒无响应关闭。`hello.d` 包含 `deviceId`、回复游标 `resumeSeq`，并可包含 `capabilities`、`epoch` 和输入游标 `inputResumeSeq`。当前客户端请求三项能力，服务端在 `ready.d.capabilities` 返回双方支持的交集：

| 能力 | 行为 |
|---|---|
| `recovery.v1` | 返回 epoch、回复回放范围和缺口信息，以及 `replay.end`；恢复状态无效时返回 `RESUME_INVALID` 并以 1008 关闭。 |
| `receipt.v1` | 支持 `msg.status` 查询当前设备消息的接收状态，`ready` 返回保留策略。 |
| `input-history.v1` | 以独立游标回放用户输入，通过 `input.push` 和 `input.replay.end` 同步多设备。 |

未声明能力的旧客户端仍可使用原有文本交互、逐帧回复回放和在线 `msg.echo`。当前客户端首次连接、尚无持久 epoch 时也兼容旧服务端的内嵌 `ready.replay`。已有 epoch 的会话若失去全部恢复能力，或非零回复/输入游标失去对应能力，客户端暂停自动发送并保留原快照；不能把降级视为全新会话。恢复能力仍在但缺少 `receipt.v1` 时，已尝试的消息保持结果待确认，不自动重发。不得假设未协商的扩展帧一定存在。

| op | 方向 | 主要字段或含义 |
|---|---|---|
| `ready` | 服务端→客户端 | `selfName`、`aiLabel`、`replay`、`serverSeq`；协商后附能力及恢复元数据。当前服务端 `replay` 为空数组。 |
| `msg.send` | 客户端→服务端 | 唯一 `id`、`d.segments`。 |
| `msg.ack` | 服务端→客户端 | `d.id`、`d.messageId`；确认入站已接收并进入处理/调度，不保证模型运行或回复完成。 |
| `msg.status` | 双向 | 请求使用帧 `id`；响应 `d.id`、`d.status` 为 `accepted`、`in_progress` 或 `unknown`，accepted 附 `messageId`。 |
| `msg.push` | 服务端→客户端 | 顶层 `seq`、`d.messageId`、`d.segments`、`d.aiLabel`；Bot 回复。 |
| `replay.end` | 服务端→客户端 | 回复回放结束及范围元数据，需协商 `recovery.v1`。 |
| `input.push` | 服务端→客户端 | 顶层 `inputSeq`、`d.messageId`、`d.segments`、`d.deviceId`、`d.clientMessageId`；需协商输入历史。 |
| `input.replay.end` | 服务端→客户端 | 输入回放结束及独立范围元数据，需协商输入历史。 |
| `msg.echo` | 服务端→同用户其他旧设备 | 在线输入广播，包含 `messageId`、`segments`。 |
| `state` | 服务端→客户端 | `d.mood`：idle/thinking/talking/sleeping。 |
| `pet.poke`、`ping`/`pong`、`error` | 双向或对应方向 | 戳一戳、心跳及安全错误；可关联的请求错误带 `d.id`。 |

协议接受 text、face、reply 及不超过 2 MiB 的 PNG/JPEG/GIF/WebP 内嵌图片；图片检查文件签名，拒绝本地路径和远程 URL，reply 必须引用本用户消息。当前桌宠界面提供文字发送；不提供文件传输或任意动作，也不承诺撤回协议。

## 恢复、回执与边界

同租户、同面板用户的设备共享 `private:<desktopUserId>`。数值 ID 落在 `[7459086882832384,7599824371187711]`，与 QQ/B 站隔离；客户端不能提交目标 ID。

桌宠模型不读取共享 QQ 表情库，提示词不注入该库；发送、列出、查看、备注和收藏共享表情的五个内置工具在执行前拒绝桌宠会话。模型取消提醒时，只能操作当前会话尚未触发的提醒，知道其他会话的提醒 ID 也不能删除。

每用户 Bot 回复与用户输入各自保留最近 200 条、最多 24 小时，各有独立递增游标；回放按序逐帧发送。`ready` 和对应结束帧给出 epoch、服务端游标、最早保留序号、实际回放起止及缺口标志。输入元数据使用 `inputServerSeq`、`inputOldestSeq`、`inputReplayFrom`、`inputReplayTo`、`inputHasGap`；回复对应字段为 `serverSeq`、`oldestSeq`、`replayFrom`、`replayTo`、`hasGap`。无可回放帧时，from 为服务端当前序号加 1，to 为当前序号；这是空区间，不表示收到了一帧。客户端只按实际收到并成功保存的帧推进游标，不合成缺失历史。

`epoch` 标识用户恢复状态的世代，用于识别服务端状态重置；epoch 不匹配或游标超过服务端值时停止自动恢复并要求人工检查。声明的保留缺口会提示历史不完整；缺少结束帧、帧不连续或本地持久化失败时客户端暂停自动发送。保存失败时保留原游标和快照，修复存储后手动重连。

内嵌 `ready.replay` 同样逐帧检查。任一帧触发恢复错误或保存失败后立即结束该批处理，保留错误状态与最后成功保存的游标，后续回放帧等待人工恢复。

客户端收到 `ready` 后继续显示连接中，等待协商的回复和输入回放结束标记均校验成功、恢复状态保存成功，才显示已连接。流式回放失败时直接保留恢复错误状态。

已有回复或输入游标的客户端，连续三次 WebSocket 已打开却未完成 `ready` 握手时，会暂停自动重连并提示恢复错误。收到 `ready` 后若回放尚未完成就断线，同样计入失败，即使是没有游标的首次连接。尚未打开的连接失败不计入次数；完成所有协商的回放或手动重连会清零。仅收到过用户输入、尚无 Bot 回复的会话同样适用。

客户端还交叉检查本地游标、最早保留序号和回放起点：`from = max(本地游标 + 1, oldest)`，缺口标记也必须与这三个值一致。回复和输入各自独立校验；声称无缺口却跳过历史、或结束帧更改起点，都会暂停自动发送，不会推进游标。

去重和回执按用户作用域保存最近 1000 个 `deviceId + clientMessageId` 键，最旧键先淘汰，**没有时间保留保证**。不同设备使用相同客户端 ID 不冲突。入站消息 ID 稳定派生；同一设备重试应沿用原 ID。`unknown` 只表示当前没有保留的回执，并不表示消息未执行，不能据此自动重发或宣称恰好一次。`in_progress` 表示处理尚在进行，等待后续 ACK；`accepted` 的含义与 ACK 相同。

已尝试但未确认的操作显示为结果不明，由用户明确选择重试或放弃；未尝试的离线消息可在恢复完成后发送。Agent 的 `desktop-processing` 标记用于防止崩溃或故障窗口内可能已发生的副作用重复执行；标记残留时需人工核查操作结果，不得直接删除后重跑。超出上述有限保留范围不保证恢复。

这条规则同样适用于没有恢复/回执能力的旧服务器：即使只是短暂断线、客户端进程未重启，也不会自动重发已经尝试但未确认的消息。首次连接时从未尝试的队列仍可发送。

## 错误与关闭

配对或升级可能返回 `PAIRING_EXPIRED`、`SEAT_LIMIT`、`TOKEN_REVOKED`、`ENTRY_DISABLED`、`USER_FORBIDDEN` 或 `TENANT_INACTIVE` 等安全错误。在线权限复核将设备撤销映射为 4001 / `TOKEN_REVOKED`；入口停用、用户失权和租户不可用分别使用 4003 / `ENTRY_DISABLED`、`USER_FORBIDDEN`、`TENANT_INACTIVE`。客户端针对这些状态停止自动重试并显示相应提示。

网关保留受控上游关闭码（包括恢复策略拒绝 1008），未知码映射为 1011；内部异常和上游关闭原因不透传。一般网络故障指数退避重连，恢复异常和结果不明按上述规则处理。

托管实例、发送队列和 Relay 计量说明见 [billing-meters.md](billing-meters.md)，客户端运行见 [desktop-client.md](desktop-client.md)。
