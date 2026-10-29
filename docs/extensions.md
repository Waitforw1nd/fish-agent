# 扩展、发送守卫与角色卡安全

对应实现：`qq-agent-core/src/plugin-loader.js`、`skills/{manifest,manager}.js`、`sender.js`、`app.js`、`personas.js`。扩展示例在 `plugins/` 和 `skills/`。

## 1. 扩展目录与加载模型

| 目录 | 语义 | 推荐内容 |
|---|---|---|
| `plugins/<id>/` | 确定性型 | `providers`、`hooks`，由核心按能力名直接调用，不经过 LLM。 |
| `skills/<id>/` | LLM 型 | `api.registerTool` 注册工具，由模型决定是否调用，可附提示词。 |

两型使用同一套 manifest 和生命周期，不是两种不同的文件格式。每目录优先读 `skill.json`，其次 `plugin.json`；入口默认 `index.js`，可用 `entry` 指定，但必须留在本目录内，符号链接越界也会拒绝。

本地默认扫描包内目录。云端按以下顺序加载，后层同 ID 覆盖前层：

1. 包内 `plugins/`、`skills/`，可由实例数据目录中的 `blocked-extensions.json` 屏蔽。
2. `QQ_AGENT_ADMIN_PLUGINS_DIR`、`QQ_AGENT_ADMIN_SKILLS_DIR`，仅由管理员安装的受信代码。
3. `QQ_AGENT_PLUGINS_DIR`、`QQ_AGENT_SKILLS_DIR`，只有确认隔离后才加载的租户代码。

cloud-manager 将管理员目录注入为 `tenants/<id>/admin-extensions/{plugins,skills}`，将租户目录注入为 `tenants/<id>/extensions/{plugins,skills}`。管理员专用接口不需要开启租户隔离声明；普通用户不能通过这些接口安装、删除或屏蔽代码。租户目录或云模式存在时，默认拒绝租户上传并跳过租户扩展；部署者只有在完成实际隔离后，才可为该进程设置 `QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED=1`。该开关是部署者的声明，不提供或验证隔离。

两种安装入口均限制 ZIP 不超过 8 MiB，并校验清单、入口、路径和解压资源。管理员安装或覆盖失败会恢复原目录并重载原版本；删除管理员覆盖版时默认同时屏蔽同 ID 内置版本，也可显式选择回退内置。屏蔽只影响当前实例，损坏的屏蔽清单不会被当作空清单放行内置扩展。包升级不改写实例扩展目录。扩展代码在宿主进程执行，上线开放租户上传前仍须完成 Linux 用户、文件、网络及进程隔离和真实验收。

其他开关：

- `QQ_AGENT_EXTENSIONS_ALLOW=id1,id2`：白名单外条目不 import，并卸载已加载实例。
- `QQ_AGENT_HOT_RELOAD=1/0`：显式控制热重载；桌面默认开，loader 检测到 `QQ_AGENT_CLOUD=1`、`QQ_AGENT_DEPLOYMENT=cloud` 或 `QQ_AGENT_MULTI_TENANT=1` 时默认关。
- cloud-manager 显式设置 `QQ_AGENT_CLOUD=1`、四个扩展目录变量、`QQ_AGENT_TELEMETRY=0`、`QQ_AGENT_COMMUNITY=0`。管理员操作使用显式重载接口，不依赖目录自动监听。

扩展不是沙箱：入口 JS 在 Agent 进程内执行。`web_fetch` 权限只限制扩展通过 `api.fetch` 获取网络能力，不能阻止模块自行 import 或访问 Node API。只安装可信代码。

### 云端管理与安全参数

管理员可在插件中心上传公共库 ZIP，再选择实例批量分发、升级或移除；公共库位于 `<CLOUD_DATA_DIR>/extensions/catalog/{plugins,skills}`。单实例插件页支持直接上传、从库安装、移除、恢复内置和热重载。列表显示来源、版本、加载状态及真实安装实例，批量操作逐项报告结果。删除公共库条目不会删除已经安装的实例副本。

普通 owner/operator 通过 `/api/tenants/:id/agent/skills/:skillId` 修改启用状态和 `configSchema` 声明的安全参数；支持布尔、数字、整数、短字符串及枚举。secret 字段以及名称涉及地址、路径、命令、脚本或凭据的参数不能读取或修改，未声明参数也会拒绝。通用配置写入不能直接修改 `skills`；viewer 始终只读。配置、schema 默认值和错误响应都不能用于回显凭据。

在线操作写入后重载并回收旧工具、定时器和监听器；离线操作持久化到实例目录，下次启动生效。管理员扩展和屏蔽文件包含在加密快照中，普通所有者恢复快照时保留当前管理员决定；管理员恢复可还原快照中的版本。恢复与实例扩展变更共用锁，避免并发覆盖。

对应云端实现为 `extension-service.js`、`agent-settings.js` 及 `routes/extensions.js`、`routes/agent.js`。接口表见 [云端扩展接口](cloud-manager.md#47-管理员扩展)，阶段验证见 [核心底座](view-api-stage-1.md) 与 [同源服务](view-api-stage-2-services.md)。

## 2. Manifest 与入口最小形状

`plugins/example/plugin.json`：

```json
{
  "id": "example",
  "name": "示例插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "message",
  "capabilities": ["message.command"],
  "settings": { "prefix": ".demo" },
  "configSchema": {
    "prefix": { "type": "string", "label": "命令前缀", "default": ".demo" }
  }
}
```

常用字段：`id/name/version/apiVersion/category/description/author/requires/capabilities/settings/configSchema/prompt/enabledByDefault/deprecated`。当前 API 版本为 1；id 允许字母、数字、`.`、`_`、`-`。`requires` 是硬能力依赖，`api.capability()` 是软依赖。

入口可导出：

- `setup(api)` 或旧式 `register(api)`：注册工具、读取配置。
- `providers`：能力名到函数。
- `hooks`：如 `before-tool`、`after-tool`、`before-context`、`before-llm-messages`、`after-response`。
- 可选 `available/activate/deactivate/dispose/promptSections`。

`api.registerTool` 会把工具名规范为 `<skillId>__<toolId>`，满足模型 function name 约束。`api.config()` 返回合并后的本扩展设置；只有 manifest 声明 `web_fetch` 时 `api.fetch` 才可用。禁用和热重载必须清理定时器、监听器、工具与能力；加载失败的新版本不会直接替换正在运行的旧版本。

Skill 提示词片段 `priority` 最高被钳到 99，低于核心规则；不要把角色卡或扩展提示词当作安全边界。

## 3. `message.command` 开发指南

真实入站位置在 `app.js`：

```text
OneBot event → 文本/媒体解析 → 白名单/屏蔽与存档
  → skillManager.runMessageCommands(...)
  → handled: SendQueue.sendTextBatch(...) 并 return
  → 未 handled: orchestrator.onIncoming(...) 进入正常 LLM 触发流程
```

因此命令原文会存档；命中回复仍经过发送队列，不创建 LLM 会话、不消耗模型 token。多个 provider 按注册顺序执行，第一个 `{handled:true}` 生效；provider 抛错会被隔离并继续后续流程。

provider 返回契约：

```js
export const providers = {
  'message.command': async (ctx) => {
    if (!ctx.text.startsWith('.demo')) return { handled: false };
    return { handled: true, replies: ['demo ok'] };
  }
};
```

可用上下文包括 `chatKey/kind/chatId/text/event/entry/senderId/senderName/atMe/platform`。`replies` 应为非空字符串数组；也可返回单个 `reply`，manager 会规范化。不要直接调用 OneBot 发送，否则会绕开白名单、限频、去重和留档。

参考 `plugins/trpg-dice-hook`：`.r 3d6+2`、`!r d20`、`。r 3#1d20`、`掷骰 2d6`。该插件文件头关于“核心尚未接入”的注释已经过时，以 `app.js` 的真实调用点为准。

验证至少覆盖：命中不调用 LLM、回复实际经过 OneBot、普通消息仍进入 LLM、provider 异常回落、禁用后不再触发。对应 `extensions-test.mjs` 和 `final-integration-test.mjs`。

## 4. `send.guard` 开发指南

所有 `SendQueue` 文字、图片、表情、媒体和 poke 出口都先执行目标校验，再执行 guard：

1. 数字号段与平台、目标合法性；这一项永远生效。
2. app 注入的白名单 `isAllowed`；提醒、主动发言、工具也不能绕过。
3. action 与消息段平台能力校验。
4. `send.guard` provider 链和 B 站节流/长度。

`send.guard.enabled=false` 只跳过后两项，不会关闭号段、白名单和能力闸。

provider 上下文主要字段：

```text
chatKey, kind, id/chatId, platform, action, onebotAction,
text, segments, sticker, targetUserId,
atUserId, replyToMessageId, urgent, proactive, surface, options
```

返回形式：

- `true`/`undefined`：放行。
- `false` 或 `{allow:false,reason}`：拒绝。
- `{ok:false}` 或 `{block:true,reason,code?,retryAfterMs?}`：同样拒绝，兼容 anti-ban-guard。
- `{text,segments,delayMs}`：改写内容或增加等待。

provider 抛错按 fail-closed 拒绝，不能静默放行。改写后的 segments 会再次做平台校验。多个 guard 会叠加，副作用型计数器要明白每次发送尝试都会经过。

B 站默认保护还包括：评论最小 15 秒 + 抖动、私信 6 秒、直播 3 秒；评论最多 1000 字，直播默认 20 字，私信另限 2000 UTF-8 字节；评论把批量文本合并成一条，超长拒绝而不是拆分刷屏。`surface` 可为 `comment/dm/live`，private 默认 dm。

参考 `plugins/anti-ban-guard`：敏感内容、夜间静默、预热、分钟/小时频率和熔断。它默认关闭，开启后 provider 计数与核心限频是两层独立机制。

## 5. B 站扩展注意事项

`skills/bili-agent-pack` 注册：

- `bili_get_video_context`
- `bili_inspect_user`
- `bili_reply_comment`
- `bili_like`

写工具要遵守：

- 只在 B 站会话路由 custom action；QQ 会话不得借用 B 站动作。
- 回复评论/点赞必须 `confirm=true`，回复还要过 `send.guard`。
- 不把 `{ok:false}` 当成功，不编造字幕、视频或用户信息。
- 核心出站能力与桥接实际能力有差异，新增动作需同步核心 `BILI_SUPPORTED_ACTIONS`、桥接 `SUPPORTED_ACTIONS` 和 fake 测试。

`plugins/bili-watcher` 提供订阅计划与去重能力；其状态和计划文件可由 `BILI_WATCH_STATE_FILE`、`BILI_WATCH_PLAN_FILE` 重定向，测试使用临时目录。

## 6. 角色卡安全偏离

这里“安全偏离”指：系统支持 SillyTavern 角色卡作为人设素材，但有意不兼容其中能劫持系统行为的字段。

### 6.1 支持格式与内容

- JSON V1/V2/V3；无 spec 但有典型 `data` 时按 V2 兼容。
- PNG `tEXt/zTXt/iTXt` 中的 `ccv3`（优先）和 `chara` base64 JSON；校验文本块 CRC、IEND、大小和解压上限。
- 可作为素材：description、personality、scenario、mesExample；firstMes 默认不导入，勾选后只作语气参考。
- `{{char}}/{{user}}`、`<BOT>/<USER>` 会替换，`<START>` 会移除。

### 6.2 明确不进入提示词的内容

- `system_prompt`
- `post_history_instructions`
- `creator_notes`
- `character_book` / 世界书
- `assets`（不下载、不启用）
- 备选开场白、群专用开场白
- 卡片中的脚本/越狱指令（不执行）

greeting 不自动发送。导入模板会额外声明“核心安全规则、工具协议和平台限制始终优先”。preview 不落盘；import 在服务端重新解析原始卡片，不信任客户端回传的解析结果，再写入 `customPersonas`，最多 200 个自定义人设。

### 6.3 限额与配置覆盖风险

主要限额：请求体 12 MiB、JSON/PNG 文件各 8 MiB、base64 最多 `12 * 1024 * 1024` 字符、PNG 文本块 4 MiB、深度 24、节点 50000、模板 100000 字符、名称 50 字符；同时清理 `__proto__/prototype/constructor` 等危险键。

`persona.systemPromptOverride` 是另一个高级功能：非空时会整体替换内置行为准则，可能移除安全规则、工具协议和反 AI 味约束。它不是角色卡导入字段，角色卡无法自动设置它；手工启用时必须自行保留必要安全约束。

`personaUnified=true` 时忽略 `personaByChat`；false 时每个会话只能覆盖 `roleText/participation/customRules/systemPromptOverride`，不能覆盖账号级 `botName/selfNickname`。云端修改这些字段仍需考虑提示词安全，不可把“扩展 priority ≤99”误当成对任意文本的内容过滤。

验证使用 `persona-card-test.mjs`、`persona-card-route-test.mjs`、`persona-import-ui.mjs`，重点断言被排除的标记文本没有进入模板，而不只是“文件能打开”。
