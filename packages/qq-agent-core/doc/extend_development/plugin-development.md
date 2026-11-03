# 确定性插件开发指南（`plugins/`）

确定性插件用于实现**只要条件满足就必须执行、不经过大模型判断**的逻辑（例如免模型前缀指令、发送前安全拦截、请求体参数适配、媒体转写等）。若需要由大模型理解自然语言后再决定是否执行，请改用 [skill-development.md](./skill-development.md)。

完整字段字典见 [skill-reference.md](./skill-reference.md)；OneBot 接口参数见 [snowluma-capabilities.md](./snowluma-capabilities.md)。

---

## 1. 最小目录与模板

可用脚手架生成：`npm run new:skill my-plugin -- --legacy`

```text
plugins/my-plugin/
├── plugin.json    # 清单声明（必选）
└── index.js       # 导出 setup / providers / hooks（必选）
```

> 加载器只扫描 `plugins/*/` 一级子目录；若有辅助模块请放在插件内部的 `plugins/my-plugin/lib/` 下，不要建 `plugins/shared/`。

**`plugins/my-plugin/plugin.json`**
```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "message",
  "description": "输入 .ping 直接回复 pong，不消耗模型 Token",
  "enabledByDefault": true,
  "capabilities": ["message.command"],
  "settings": { "prefix": ".ping" },
  "configSchema": {
    "prefix": { "type": "string", "label": "命令前缀", "default": ".ping" }
  }
}
```

**`plugins/my-plugin/index.js`**
```js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
}

export const providers = {
  'message.command': async (ctx) => {
    const prefix = cfg().prefix || '.ping';
    if (!ctx.text.trim().startsWith(prefix)) return { handled: false };
    return { handled: true, replies: ['pong!'] };
  },
};
```

---

## 2. 能力（`providers`）标准契约表

`providers` 中的每个键都必须在 `plugin.json` 的 `capabilities` 数组中双向声明。只有核心已接入的能力名会被核心主动调用（自建能力名仅供其他扩展通过 `api.capability(name)` 软依赖调用）：

### 2.1 消息入站与出站守卫（最常用）

| 能力名 | 触发位置 | 主要入参 | 返回值契约 |
|---|---|---|---|
| `message.command` | `app.js` 存档后、唤醒 LLM 前 | `{ chatKey, kind, chatId, text, senderId, senderName, atMe, platform }` | `{ handled: true, replies: string[] }` 拦截并直接经发送队列回复；`{ handled: false }` 放行 |
| `send.guard` | `sender.js` 所有出站发送前 | `{ chatKey, kind, chatId, platform, action, text, segments, proactive, surface }` | `true` 放行；`false` / `{ allow: false, reason }` / `{ block: true, reason }` 拒绝；`{ text, segments, delayMs }` 改写或延时（抛错默认拒绝） |
| `message.speaker-format` | `prompt.js` | `{ message, notes, selfLabel }` | 字符串发言人标签 |
| `message.inline-at-normalize` | `onebot.js` | `{ text, members, atUserId }` | 规范化文本或 `null` |
| `message.owner-check` | `orchestrator.js` | `{ triggerEntries, kind, selfId, persona }` | `{ persona, rules }` |
| `chat.ban-state` | `orchestrator.js` | `{ chatKey, action: 'check' }` | `{ known: boolean, muted: boolean }` |

### 2.2 媒体与大模型链路

| 能力名 | 消费模块 | 主要入参 | 返回值契约 |
|---|---|---|---|
| `media.transcribe` | `onebot.js` | `{ record, onebot }` | `{ ok, text, error? }` |
| `media.download` | `media-links.js`（多提供者） | `{ url, text, onebot, sender, kind, chatId }` | `{ ok: true, platform, kind, ... }` / `{ ok: false, skip: true }` / `{ ok: false, error }` |
| `video.frames` / `video.frames.available` | `video-reader.js` | `{ filePath, count, durationSec }` / `{}` | `{ frames, times }` / `{ ok: boolean }` |
| `image.mime-support` | `tools.js` | `{ mime }` | `{ supported: boolean }` |
| `llm.request-params` | `llm.js`（多提供者） | `{ body, api, model, messages, tools, temperature, context }` | `{ body, omitTemperature? }` |
| `llm.response` / `llm.usage` | `llm.js`（多提供者） | `{ result, usage?, ...ctx }` | `{ result }` / `{ [metric]: number }` |
| `llm.retry-advisor` | `llm.js`（多提供者） | `{ body, errorText, status, ...ctx }` | `{ body, reason }` 或 `null` |
| `llm.endpoint-pick` / `llm.endpoint-feedback` | `llm.js` | `{ model }` / `payload` | `{ id, baseUrl, apiKey, model }` / 忽略 |
| `model.thinking-detect` | `routes.js` | `{ baseUrl, model }` | 思考配置对象或 `null` |
| `tool.guard` | `tool-registry.js`（多提供者） | `{ toolId, tool, context }` | `false` 或 `{ ok: false, reason }` 禁用该工具 |
| `reply.*`（`inline-calls` / `salvage` 等） | `orchestrator.js` / `reply-rescue.js` | 回复文本与上下文 | 抢救解析后的工具调用或回复数组 |

---

## 3. 生命周期钩子（`hooks`）

```js
export const hooks = {
  'before-context': ({ triggerEntries, store, memory }) => {},
  'before-llm-messages': ({ messages }) => { /* 可原地修改 messages 数组 */ },
  'after-response': ({ response, session }) => {},
  'before-tool': ({ toolName, argsRaw }) => {
    if (toolName === 'send_message' && shouldBlock()) {
      return { block: true, reason: '当前时段禁止发送' };
    }
  },
  'after-tool': ({ toolName, result }) => {},
};
```

**钩子硬约束**：
1. 单个钩子限时 **5 秒**（超时自动跳过，异常只记日志不影响主流程）。
2. 钩子只做内存级轻量加工或拦截，**禁止在钩子内发网络请求、直接发消息或自行重试**。

---

## 4. 生命周期清理与安全边界

- **`available()` 必须同步返回**：返回 `true` 或 `{ ok: false, reason }`，切勿写 `async`（`Promise` 会被误判为 truthy）。异步二进制探测请采用“首次放行 + 后台探测缓存结果”模式。
- **资源清理**：在 `activate()` 启动的定时器、轮询或文件监听，必须在 `deactivate()` 与 `dispose()` 中彻底关闭，确保禁用或热重载后无残留。
- **消息出站必走 `SendQueue`**：绝不直接调用 `onebot.sendGroupMsg` / `sendSegments`，否则会绕过白名单、限频、去重与会话留档。

---

## 5. 仓库内置插件参考

- `plugins/trpg-dice-hook`：基于 `message.command` 实现 `.r 3d6` 免模型掷骰子。
- `plugins/anti-ban-guard`：基于 `send.guard` 实现敏感词、夜间静默、分钟/小时频控与熔断。
- `plugins/bili-watcher`：B 站轮询计划与启停状态同步。

开发完成后运行 `npm run test:skill && npm run test:audit` 校验契约一致性。
