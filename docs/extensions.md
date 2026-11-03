# 插件、技能与角色卡开发指南

`qq-agent-core` 提供统一的扩展机制（插件与技能）和安全受控的角色卡导入能力。更底层的扩展 API 字段字典可参阅 [skill-reference.md](../packages/qq-agent-core/doc/extend_development/skill-reference.md)。

---

## 1. 插件（`plugins/`）与技能（`skills/`）的区别

两种扩展使用完全相同的清单语法与生命周期，仅按**由谁触发执行**划分目录：

| 类型 | 存放目录 | 清单文件 | 触发方式 | 典型场景 |
|---|---|---|---|---|
| **确定性插件** | `plugins/<id>/` | `plugin.json` | 由核心代码按能力（`providers`）或钩子（`hooks`）**固定触发**，不经过大模型 | `.r` 骰子指令、消息发送前敏感词/频控拦截、B 站链接解析 |
| **LLM 工具技能** | `skills/<id>/` | `skill.json` | 通过 `api.registerTool` 注册工具，**由大模型理解对话后决定是否调用** | 查天气、查百科、B 站视频/用户查询工具 |

一句话判断：**规则能用 `if` 写死放 `plugins/`；需要理解自然语言意图放 `skills/`**。

---

## 2. 加载优先级与云端管理员管控

核心按以下顺序扫描加载扩展（同 `id` 时后层覆盖前层）：

1. **内置目录**（`packages/qq-agent-core/{plugins,skills}`）：若实例数据目录的 `blocked-extensions.json` 包含某扩展 ID，则跳过或立即卸载该内置扩展。
2. **管理员实例目录**（`QQ_AGENT_ADMIN_PLUGINS_DIR` / `QQ_AGENT_ADMIN_SKILLS_DIR`，云端对应 `tenants/<id>/admin-extensions/`）：仅平台管理员可通过面板上传 ZIP 或从公共插件库批量下发。
3. **租户自上传目录**（`QQ_AGENT_PLUGINS_DIR` / `QQ_AGENT_SKILLS_DIR`）：由于扩展 JS 直接在 Agent Node 进程内运行，云端默认拒绝加载与上传；仅在部署方自行完成系统级沙箱隔离并设置 `QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED=1` 后才启用。

**云端分工**：
- **管理员**：可在“插件中心”维护公共插件库并批量分发/卸载，或在单实例详情页加装 ZIP、屏蔽/恢复内置插件、触发热重载（安装报错自动回滚原版本）。
- **普通用户（owner / operator）**：只能在管理员开放的扩展范围内切换启用开关，或修改 `configSchema` 声明的普通标量参数（布尔、数值、短字符串、枚举；涉及路径、URL、脚本和密钥的参数自动隐藏并禁止读写）。

---

## 3. 快速编写一个扩展

一个扩展只需一个文件夹加两个文件（也可在 `packages/qq-agent-core` 运行 `npm run new:skill my-tool` 一键生成模板）：

### 3.1 清单文件示例（`plugin.json` 或 `skill.json`）

```json
{
  "id": "demo-dice",
  "name": "简易骰子",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "message",
  "description": "输入 .demo 直接返回结果，不消耗模型 Token",
  "capabilities": ["message.command"],
  "settings": { "prefix": ".demo" },
  "configSchema": {
    "prefix": { "type": "string", "label": "触发前缀", "default": ".demo" }
  }
}
```

### 3.2 常用扩展接口示例（`index.js`）

#### 方式 A：编写免模型命令（`message.command`，放 `plugins/`）

在消息写入存档后、唤醒大模型前执行；返回 `{ handled: true, replies }` 后直接经 `SendQueue` 回复，**零 Token 消耗**：

```js
export let currentApi = null;

export function setup(api) {
  currentApi = api;
}

export const providers = {
  'message.command': async (ctx) => {
    const prefix = currentApi?.config()?.prefix || '.demo';
    if (!ctx.text.trim().startsWith(prefix)) return { handled: false };
    return {
      handled: true,
      replies: [`你好 ${ctx.senderName}，命令已命中！`],
    };
  },
};
```

#### 方式 B：编写发送守卫（`send.guard`，放 `plugins/`）

所有 `SendQueue` 出站消息在通过号段与白名单检查后都会经过 `send.guard`。抛错或返回拒绝时**默认拦截（fail-closed）**：

```js
export const providers = {
  'send.guard': async (ctx) => {
    if (ctx.text && ctx.text.includes('违禁词示例')) {
      return { allow: false, reason: '命中自定义内容拦截' };
    }
    // 也可返回 { text, segments, delayMs } 改写内容或增加延迟；返回 true 放行
    return true;
  },
};
```

#### 方式 C：注册大模型工具（`registerTool`，放 `skills/`）

```js
export function setup(api) {
  api.registerTool({
    name: 'roll_number',
    description: '当群友要求随机抽一个数字时调用',
    parameters: {
      type: 'object',
      properties: {
        max: { type: 'integer', description: '最大正整数，默认 100' },
      },
    },
    async execute(ctx, args) {
      const max = Math.max(1, Number(args?.max) || 100);
      return { result: Math.floor(Math.random() * max) + 1 };
    },
  });
}
```

> **开发注意**：
> - 工具名会被自动规范化为 `<skillId>__<toolName>`；提示词片段 `priority` 最高限制为 `99`，无法覆盖系统核心安全规则。
> - 若在 `activate()` 中创建了定时器或事件监听，必须在 `deactivate()` / `dispose()` 中清理。
> - 如需使用 `api.fetch` 访问外网，需在清单中声明 `"permissions": ["web_fetch"]`（或核心允许的网络能力）。

---

## 4. SillyTavern 角色卡安全导入规则

系统支持导入 SillyTavern **JSON（V1/V2/V3）** 与 **PNG（`ccv3` / `chara` 文本块）** 角色卡作为人设素材（单文件上限 8 MiB），为防止恶意角色卡劫持系统提示词或越狱，采用白名单提取策略：

- **允许提取的字段**：角色名、`description`、`personality`、`scenario`、`mes_example`（`first_mes` 默认不导入，勾选后仅作语气参考；自动替换 `{{char}}` / `{{user}}`）。
- **明确剥离并忽略的字段**：`system_prompt`、`post_history_instructions`、`creator_notes`、`character_book`（世界书）、`assets` 外链资源及嵌入脚本。
- **预览与落盘隔离**：`preview` 接口仅解析并返回摘要与过滤提示，不写磁盘；`import` 接口由服务端重新解析原始文件后写入 `customPersonas`（最多 200 个），不信任前端回传的拼接文本。
