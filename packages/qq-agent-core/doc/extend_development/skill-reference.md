# 扩展开发 API 与清单参考手册

本文汇总 `qq-agent-core` 插件（`plugins/`）与技能（`skills/`）共用的清单字段、`setup(api)`、`execute(ctx, args)`、生命周期与安全约束，适合作为开发速查表。

- 编写确定性插件指南：[plugin-development.md](./plugin-development.md)
- 编写 LLM 工具技能指南：[skill-development.md](./skill-development.md)
- OneBot v11 协议接口参数表：[snowluma-capabilities.md](./snowluma-capabilities.md)

---

## 1. 清单文件（`skill.json` / `plugin.json`）

两种文件名经同一套 `normalizeManifest` 解析，字段完全通用（必须保存为无语法错误的 UTF-8 JSON）：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `id` | `string` | 是 | 目录名 | 唯一标识，匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`（云端限长、不含空格与中文） |
| `name` | `string` | 否 | `id` | 界面显示名称 |
| `version` | `string` | 否 | `"0.0.0"` | 语义化版本号 |
| `apiVersion` | `number` | 否 | `1` | 当前固定为 `1` |
| `category` | `string` | 否 | `"utility"` | 仅限 `model` / `message` / `knowledge` / `media` / `utility` |
| `description` | `string` | 否 | `""` | 一句话功能说明 |
| `author` | `string` | 否 | `""` | 作者名称 |
| `enabledByDefault` | `boolean` | 否 | `true` | 首次加载时的默认启用状态 |
| `permissions` | `string[]` | 否 | `[]` | 权限声明；使用 `api.fetch` 必须声明 `["web_fetch"]` |
| `capabilities` | `string[]` | 否 | `[]` | 本扩展 `providers` 提供的能力名列表（须双向一致） |
| `requires` | `string[]` | 否 | `[]` | 硬依赖的能力名列表（未满足时状态变为 `capability-missing`） |
| `settings` | `object` | 否 | `{}` | 配置项默认值（每个键都应在 `configSchema` 中声明） |
| `configSchema` | `object` | 否 | `{}` | 设置表单与写入白名单声明（见第 2 节） |
| `prompt` | `object` | 否 | `null` | `{ sections: [{ id, title, priority, content }] }`，`priority` 强制 `≤ 99` |
| `entry` | `string` | 否 | `"index.js"` | 入口相对路径，不得越出当前扩展目录 |
| `deprecated` | `boolean` | 否 | `false` | 标记弃用 |

---

## 2. `configSchema` 配置声明

| `type` | 界面控件 | 常用附加属性 |
|---|---|---|
| `boolean` | 开关 / 复选框 | `label`、`description`、`default` |
| `number` | 数值输入框 | `label`、`description`、`default`、`min`、`max`、`step` |
| `string` | 文本输入框 | `label`、`description`、`default`、`multiline: true`、`secret: true` |
| `enum` | 下拉选择框 | `label`、`description`、`default`、`options: [{ value, label }]`（或 `values: [...]`） |
| `internal` | 不渲染 | 内部状态字段，需附 `description` |

- **脱敏规则**：标记 `secret: true` 的字段在读取 API 中恒返回掩码，前端提交空串或掩码时保留原值不覆盖；云端模式下普通用户不可读写 secret 及路径/地址/脚本类高危字段。

---

## 3. 入口文件（`index.js`）导出与 `setup(api)`

### 3.1 可选导出项

```js
export function setup(api) {}            // 加载时调用一次（兼容旧名 register(api)）
export function available(ctx) {}        // 同步自检：返回 true 或 { ok: false, reason }（严禁返回 Promise）
export async function activate(ctx) {}   // 启用时调用：启动定时器或监听
export async function deactivate(ctx) {} // 禁用时调用：必须清理定时器与监听
export function dispose() {}             // 卸载或热重载替换前调用
export function promptSections(ctx) {}   // 动态返回 [{ id, title, priority, content }]
export const providers = {};             // { 'capability.name': fn }
export const hooks = {};                 // { 'before-context' | 'before-llm-messages' | 'after-response' | 'before-tool' | 'after-tool': fn }
```

### 3.2 `setup(api)` 参数方法

| 成员 | 签名 | 说明 |
|---|---|---|
| `api.registerTool` | `(def) => string` | 注册 LLM 工具，实际名称规范为 `<skillId>__<toolId>`（总长 ≤ 64，仅允许 `[a-zA-Z0-9_-]`）；`def.category` 属于 8 类工具分类（`messaging`/`sticker`/`query`/`memory`/`web`/`knowledge`/`media`/`system`，注意与清单顶层的 5 类扩展 `category` 区分） |
| `api.config` | `() => object` | 获取合并默认值后的最新扩展配置（每次执行时动态调用） |
| `api.capability` | `(name, args?) => any` | 软依赖调用其他扩展提供的能力；无提供者时返回 `undefined` |
| `api.hasCapability` | `(name) => boolean` | 检查某能力当前是否有活跃提供者 |
| `api.isSkillActive` | `(id, ctx?) => boolean` | 检查指定扩展当前是否处于 `active` |
| `api.fetch` | `(url, init?) => Promise<Response>` | 需清单声明 `permissions: ["web_fetch"]`，否则调用直接 reject |
| `api.log / warn / error` | `(...args) => void` | 输出带 `[skill:<id>]` 前缀的日志 |
| `api.utils` | `{ sleep(ms), safeJsonParse(str, fallback) }` | 常用辅助函数 |

---

## 4. 工具执行上下文 `execute(ctx, args)`

| 字段 | 说明 |
|---|---|
| `ctx.chatKey` / `ctx.kind` / `ctx.chatId` | 会话键（`group:<id>` 或 `private:<id>`）、会话类型（`'group'` / `'private'`）与目标数字 ID |
| `ctx.selfId` / `ctx.selfNickname` / `ctx.botName` | 机器人当前登录号、群内昵称与设定名 |
| `ctx.sender` | **唯一合规出站队列**：`sendTextBatch(chatKey, msgs, opts)`、`sendImage(chatKey, img, opts)`、`sendSticker(chatKey, sticker, opts)`、`poke(chatKey, uid)`、`sendMedia(chatKey, segments, opts)` |
| `ctx.onebot` | OneBot 客户端：`getGroupInfo(gid)`、`getGroupMemberInfo(gid, uid)`、`getMsg(mid)`、`call(action, params, timeoutMs?)`（失败抛错，须 `try / catch`） |
| `ctx.store` | 消息存档：`recent(chatKey, { limit, before })`、`getChatMeta(chatKey)`、`listChats()`、`unreadCount(chatKey)`、`findByMid(chatKey, mid)`、`activeMembers(chatKey)` |
| `ctx.memory` | 群友长期记忆：`query(chatKey, opts)`、`getMember(chatKey, uid)`、`members(chatKey)`、`editMemberImpression(...)`、`append(...)` |
| `ctx.stickers` | 表情包库：`list()`、`find(ref)`、`collect(...)`、`note(id, patch)`、`markUsed(id, ctx)` |
| `ctx.reminders` | 定时提醒：`add({ chatKey, text, dueAt, createdBy })`、`cancel(id)`、`pending()` |
| `ctx.videoReader` | 视频路由：`describeRoute()`、`framesAvailable(opts)`、`probe(filePath)` |
| `ctx.session` | 当前会话运行态（`id`、`triggerText`、`sent[]`、`usage` 等） |
| `ctx.emit` | `(type, payload) => void` 向控制台推送实时状态事件 |

---

## 5. 状态错误码与硬约束清单

### 状态错误码
- `skill-not-found`：扩展不存在
- `skill-not-loaded`：清单或入口加载报错
- `skill-disabled`：用户已关闭开关（或被管理员屏蔽）
- `skill-unavailable`：`available()` 返回未就绪
- `capability-missing`：`requires` 声明的依赖能力缺失
- `skill-timeout`：钩子执行超过 5 秒超时

### 开发硬约束自检
1. **目录规范**：仅在 `skills/<id>/` 或 `plugins/<id>/` 放扩展目录，不在顶层建共享文件夹，不在包内塞 `node_modules/`、可执行文件（`.exe/.sh/.bat/.dll`）或真实密钥。
2. **命名安全**：工具 `id` 仅含字母、数字、`-`、`_`，绝不使用 `:` 或 `.`。
3. **同步自检**：`available()` 必须同步返回，绝不写 `async`。
4. **出站守卫**：发送聊天消息一律通过 `ctx.sender`，不直调 `onebot.send_*`。
5. **钩子轻量**：`hooks` 中不做网络请求、不发消息、不超时（≤ 5s）。
6. **卸载干净**：`activate` 创建的后台任务在 `deactivate` / `dispose` 中完整销毁。
