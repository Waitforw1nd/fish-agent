# LLM 工具技能开发指南（`skills/`）

LLM 型技能通过 `api.registerTool` 向大模型的 `tools` 列表注册工具，由**大模型理解群友的自然语言意图后自主决定是否调用**（如查天气、查视频详情、计算、搜资料等）。若功能触发条件能写成固定代码规则且不允许被模型忽略，请改用 [plugin-development.md](./plugin-development.md)。

完整 API 与 `ctx` 字段参考见 [skill-reference.md](./skill-reference.md)；OneBot 接口参数见 [snowluma-capabilities.md](./snowluma-capabilities.md)。

---

## 1. 快速创建与最小模板

使用脚手架创建：

```bash
npm run new:skill dice-roller -- --name "骰子工具" --category utility
```

```text
skills/dice-roller/
├── skill.json     # 清单（必填）
├── index.js       # 工具注册与实现（必填）
└── lib/*.js       # 辅助模块（可选，切勿在 skills/ 顶层建 shared 目录）
```

**`skills/dice-roller/skill.json`**
```json
{
  "id": "dice-roller",
  "name": "骰子工具",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "按 NdM 表达式掷骰子",
  "enabledByDefault": true,
  "settings": { "maxSides": 100 },
  "configSchema": {
    "maxSides": { "type": "number", "label": "最大面数", "default": 100, "min": 2, "max": 1000 }
  },
  "prompt": {
    "sections": [
      {
        "id": "dice-note",
        "title": "掷骰子",
        "priority": 30,
        "content": "群友要求掷骰子、roll 点或比大小时调用 roll_dice 工具，不要心算编造点数。"
      }
    ]
  }
}
```

**`skills/dice-roller/index.js`**
```js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'roll_dice', // 自动添加前缀变为 dice-roller__roll_dice
    name: '掷骰子',
    description: '按 NdM 表达式（如 1d100、2d6）掷骰子并返回点数。当用户要求掷骰子、roll 或抽签时调用。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        notation: { type: 'string', description: '骰子表达式，如 1d100，默认 1d6' },
      },
    },
    async execute(_ctx, args) {
      const notation = String(args?.notation || '1d6').trim().toLowerCase();
      const match = notation.match(/^(\d{1,2})d(\d{1,4})$/);
      if (!match) return { content: `表达式格式错误：${notation}，请使用如 2d6 格式`, isError: true };

      const count = Math.min(10, Math.max(1, Number(match[1])));
      const sides = Number(match[2]);
      const limit = Number(cfg().maxSides) || 100;
      if (sides > limit) return { content: `面数不能超过 ${limit}`, isError: true };

      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const sum = rolls.reduce((a, b) => a + b, 0);
      return { content: `${notation} 结果：[${rolls.join(', ')}]，总和 ${sum}` };
    },
  });
}
```

---

## 2. 工具定义（`registerTool`）核心规范

| 字段 | 必填 | 规范与注意事项 |
|---|---|---|
| `id` | 是 | **只允许 `[a-zA-Z0-9_-]`**（长度 ≤ 38），**严禁包含 `:` 或 `.`**（否则 OpenAI / DeepSeek 接口会直接报 `400 invalid function name` 拒绝整轮对话）。 |
| `name` | 是 | 控制台与日志展示的中文名。 |
| `description` | 是 | 模型调用的唯一判据：写清**做什么 + 什么场景下调用 + 什么场景不要调用**。 |
| `parameters` | 是 | 标准 JSON Schema `object`；每个属性写明 `description`；**没有必填项时直接省略 `required` 字段**（不要写空数组 `required: []`）。 |
| `execute` | 是 | `async (ctx, args) => ({ content, isError? })`。 |
| `category` | 否 | `messaging` / `sticker` / `query` / `memory` / `web` / `knowledge` / `media` / `system`。 |
| `requiresVision` / `requiresSearch` | 否 | 设为 `true` 时，当前模型不支持看图或未开启联网搜索会自动隐藏该工具。 |

### `execute` 返回值约定
- **文本结果**：`return { content: '返回给模型参考的文本' }`（这是给模型看的工具结果，模型读完会自行组织语言回复群友）。
- **多模态结果**：`return { content: [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }] }`（**切勿把 Base64 字符串直接拼进纯文本**）。
- **可预期错误**：`return { content: '失败原因说明', isError: true }`，始终用 `try / catch` 包裹外部请求。

---

## 3. 运行时上下文（`ctx`）与联网/发送规则

- **联网请求**：必须在 `skill.json` 中声明 `"permissions": ["web_fetch"]`，然后在代码中使用 `api.fetch(url, options)`。
- **主动发消息**：若工具需要直接往当前会话发消息或媒体，**必须走 `ctx.sender`**（`sendTextBatch`、`sendImage`、`sendSticker`、`poke`、`sendMedia`），严禁绕过 `ctx.sender` 直接调用 `ctx.onebot.sendGroupMsg`，以确保白名单、`send.guard`、限频、去重与存档全部生效。
- **调用协议端其他能力**：通过 `await ctx.onebot.call(action, params)` 调用（失败会抛异常，务必 `try / catch`，写操作如禁言/撤回前务必校验 `ctx.kind === 'group'` 与目标权限）。
- **读取配置**：在 `setup(api)` 中保存 `cfg = api.config`，在 `execute` 内部每次调用 `cfg()` 读取最新用户配置，不要在 `setup` 时把配置缓存成静态常量。

---

## 4. 校验、打包与分发

1. 本地校验：在 `packages/qq-agent-core` 运行 `npm run test:skill && npm run test:audit`。
2. 打包格式：将技能目录打包为 `.zip`（包内含 `skill.json` 与 `index.js`，单包 ≤ 8 MB、解压 ≤ 32 MB、文件数 ≤ 100，不含 `node_modules/`、可执行脚本或真实密钥）。
3. 云端部署：平台管理员可在 Web 面板「插件中心」或单实例「插件与技能」页直接上传 ZIP 分发并热重载生效。

仓库内置技能示例可参考 `skills/bili-agent-pack/`。
