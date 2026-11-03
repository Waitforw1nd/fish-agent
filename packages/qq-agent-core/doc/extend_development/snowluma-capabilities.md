# OneBot v11 协议端接口速查（73 个 Action）

本文汇总 QQ OneBot v11 协议端支持的全部 73 个 `action` 参数与返回值，供扩展通过 `await ctx.onebot.call(action, params)` 调用参考。

> **调用注意**：
> 1. **普通发消息请走 `ctx.sender`**（自动获得白名单、`send.guard`、限频、去重和存档保护），仅在查询信息或执行群管等特殊操作时直接调用 `ctx.onebot.call()`。
> 2. `ctx.onebot.call()` 在 HTTP 非 2xx 或 `retcode !== 0` 时**直接抛错**，调用处必须加 `try / catch`。
> 3. 写操作（撤回、踢人、禁言、改名片、发公告/说说）无内置二次确认，调用前请校验 `ctx.kind === 'group'` 与操作权限。

---

## 1. 账号信息与消息基础

| Action | 参数（`*` 为必填） | 返回 / 说明 |
|---|---|---|
| `get_login_info` | 无 | `{ user_id, nickname }` 当前登录 QQ 与昵称 |
| `get_status` | 无 | `{ online, good }` 在线与健康状态 |
| `get_version_info` | 无 | `{ app_name, app_version, protocol_version }` |
| `can_send_image` | 无 | `{ yes: boolean }` 是否支持发图 |
| `can_send_record` | 无 | `{ yes: boolean }` 是否支持发语音 |
| `send_msg` | `*message` (段数组), `message_type` (`group`/`private`), `group_id`, `user_id`, `auto_escape` | `{ message_id }`（建议改用 `ctx.sender`） |
| `send_private_msg` | `*user_id`, `*message`, `group_id`, `auto_escape` | `{ message_id }`（建议改用 `ctx.sender`） |
| `send_group_msg` | `*group_id`, `*message`, `auto_escape` | `{ message_id }`（建议改用 `ctx.sender`） |
| `get_msg` | `*message_id` | 消息详情对象（含 `sender`、`message`、`real_id`） |
| `delete_msg` | `*message_id` | 撤回指定消息 |
| `get_group_msg_history` | `*group_id`, `message_id`, `count` (默认 20), `reverse_order` | `{ messages: [...] }` 获取群历史消息 |
| `get_friend_msg_history` | `*user_id`, `message_id`, `count` (默认 20), `reverse_order` | `{ messages: [...] }` 获取私聊历史消息 |
| `mark_group_msg_as_read` | `*message_id`, `group_id` | 标记群消息已读 |
| `mark_private_msg_as_read` | `*message_id`, `user_id` | 标记私聊消息已读 |
| `mark_msg_as_read` | `*message_id`, `target_id` | 自动路由标记消息已读 |
| `upload_forward_msg` | `*messages` (转发节点数组), `group_id` | `{ res_id, forward_id }` 上传合并转发消息 |

---

## 2. 好友、群资料与加群/好友请求

| Action | 参数（`*` 为必填） | 返回 / 说明 |
|---|---|---|
| `get_friend_list` | 无 | 好友数组 `[{ user_id, nickname, remark }]` |
| `get_stranger_info` | `*user_id` | 陌生人公开资料（昵称、性别、年龄、签名等） |
| `get_group_list` | `no_cache` | 群列表 `[{ group_id, group_name, member_count }]` |
| `get_group_info` | `*group_id`, `no_cache` | 单群资料对象 |
| `get_group_member_list` | `*group_id`, `no_cache` | 群成员数组 `[{ user_id, nickname, card, role }]` |
| `get_group_member_info` | `*group_id`, `*user_id`, `no_cache` | 单个群成员资料对象 |
| `set_friend_add_request` | `*flag`, `approve` (默认 `true`) | 同意或拒绝好友申请 |
| `set_group_add_request` | `*flag`, `sub_type`, `approve` (默认 `true`), `reason` | 同意或拒绝加群/邀请请求 |

---

## 3. 群管理、精华与公告

| Action | 参数（`*` 为必填） | 返回 / 说明 |
|---|---|---|
| `set_group_kick` | `*group_id`, `*user_id`, `reject_add_request` | 踢出单个群成员 |
| `set_group_kick_members` | `*group_id`, `*user_id` (`number[]`), `reject_add_request` | 批量踢出群成员 |
| `set_group_ban` | `*group_id`, `*user_id`, `duration` (秒，`0` 为解禁，默认 `1800`) | 禁言或解除禁言 |
| `set_group_whole_ban` | `*group_id`, `enable` (默认 `true`) | 开启或关闭全员禁言 |
| `set_group_admin` | `*group_id`, `*user_id`, `enable` (默认 `true`) | 设置或取消群管理员 |
| `set_group_card` | `*group_id`, `*user_id`, `card` (空串清除) | 修改成员群名片 |
| `set_group_add_option` | `*group_id`, `add_type`, `group_question`, `group_answer` | 修改加群验证方式 |
| `get_group_admin_settings` | `*group_id` | 查询当前群管理设置 |
| `set_essence_msg` | `*message_id` | 设为群精华消息 |
| `delete_essence_msg` | `*message_id` | 移出群精华消息 |
| `get_essence_msg_list` | `*group_id` | 获取群精华消息列表 |
| `_send_group_notice` | `*group_id`, `*content`, `image`, `pinned`, `send_to_new_members` | 发布群公告 |
| `_get_group_notice` | `*group_id` | 获取群公告列表 |

---

## 4. 互动、表情与收藏表情

| Action | 参数（`*` 为必填） | 返回 / 说明 |
|---|---|---|
| `send_like` | `*user_id`, `times` (默认 `1`) | 给资料卡点赞 |
| `friend_poke` | `*user_id`, `target_id` | 私聊拍一拍 |
| `group_poke` | `*group_id`, `*user_id` | 群聊拍一拍 |
| `send_poke` | `*user_id`, `group_id` | 自动路由拍一拍（群聊传 `group_id`） |
| `set_group_reaction` | `*message_id`, `*code`, `group_id`, `is_set` (默认 `true`) | 群消息贴表情回应 |
| `add_custom_face` | `*file` (路径/URL/base64) | `{ emoji_id }` 添加收藏表情 |
| `delete_custom_face` | `*emoji_id` | 删除收藏表情 |
| `modify_custom_face` | `*emoji_id`, `desc` | 修改收藏表情备注 |
| `fetch_sys_faces` | `refresh` | `{ packs: [...] }` 获取系统表情目录 |
| `fetch_face_entity` | `*face_id`, `refresh` | 按编号查询单个系统表情详情 |
| `search_sys_faces` | `*query` | `{ faces: [...] }` 按关键词搜索系统表情 |

---

## 5. 群文件、媒体、群相册、QQ 空间与流式传输

| 分类 | Action | 参数（`*` 为必填） | 返回 / 说明 |
|---|---|---|---|
| **群/私聊文件** | `upload_group_file` | `*group_id`, `*file`, `name`, `folder` | `{ file_id }` 上传群文件 |
| | `upload_private_file` | `*user_id`, `*file`, `name` | `{ file_id }` 上传私聊文件 |
| | `get_group_file_url` | `*group_id`, `*file_id` | `{ url }` 获取群文件下载链接 |
| | `get_group_root_files` | `*group_id` | `{ files, folders }` 获取群根目录文件 |
| | `get_group_files_by_folder` | `*group_id`, `*folder_id` | `{ files, folders }` 获取群子文件夹内容 |
| **媒体与凭据** | `get_image` | `file` 或 `file_id` | 获取图片信息 |
| | `get_record` | `file` 或 `file_id`, `out_format` (`mp3`/`wav` 等) | 获取语音信息（指定格式时含 base64） |
| | `fetch_ptt_text` | `*message_id` | `{ text }` 获取语音转文字结果 |
| | `get_cookies` | `*domain` | `{ cookies }` 获取指定域名 Cookie |
| **群相册** | `get_group_album_list` | `*group_id` | 获取群相册列表 |
| | `get_qun_album_list` | `*group_id`, `attach_info` | `{ album_list, attach_info, has_more }`（NapCat 风格） |
| | `upload_image_to_qun_album` | `*group_id`, `*album_id`, `*album_name`, `*file` | 上传图片至群相册 |
| | `get_group_album_media_list` | `*group_id`, `*album_id`, `attach_info` | `{ mediaList, nextAttachInfo }` 获取相册内媒体 |
| **QQ 空间** | `get_qzone_msg_list` | `target_uin`, `pos` (默认 `0`), `num` (默认 `20`) | `{ total, msglist }` 获取说说列表 |
| | `get_qzone_feeds` | `page_num` (默认 `1`), `count` (默认 `10`) | `{ feeds, has_more }` 获取空间好友动态 |
| | `send_qzone_msg` | `*content`, `images` (`string[]`), `ugc_right` | 发表说说 |
| | `delete_qzone_msg` | `*tid` | 删除指定说说 |
| | `like_qzone` | `*tid`, `target_uin` | 给说说点赞 |
| **流式文件** | `upload_file_stream` | `*stream_id`, `chunk_data`, `chunk_index`, `total_chunks`, `is_complete` | 分块流式上传文件 |
| | `download_file_stream` | `file`, `chunk_size` | 流式下载通用文件 |
| | `download_file_image_stream` | `file`, `chunk_size` | 流式下载图片 |
| | `download_file_record_stream` | `file`, `chunk_size` | 流式下载语音 |

---

## 6. 常用 OneBot 消息段（Segment）类型

构造 `segments` 数组时支持：`text`（纯文本）、`at`（`@` 某人）、`reply`（引用回复）、`face`（系统表情）、`image`（图片）、`record`（语音）、`video`（视频）、`file`（文件）、`forward`（合并转发）、`poke`（戳一戳）、`json` / `xml`（卡片消息）。

> 注：若目标会话为 **B 站通道**，仅支持 `text`、`at`、`reply` 与私信单张 `image`（详见根目录 `docs/protocols.md`）。
