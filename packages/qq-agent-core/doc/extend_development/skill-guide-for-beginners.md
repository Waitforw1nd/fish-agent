# 零基础 Skill 开发入门（3 步做出第一个技能）

本教程面向刚接触本项目的开发者，手把手带你用 3 步给机器人加上一个“查天气”技能。

> **先分清两类扩展**：
> - **技能（`skills/`，本文所教）**：给大模型增加一个工具（如查天气、算数、搜资料），由 AI 听懂人话后自己决定调用。
> - **插件（`plugins/`）**：写死触发规则（如输入 `.r` 必掷骰子、发消息前必做敏感词拦截），不经过 AI，详见 [plugin-development.md](./plugin-development.md)。

---

## 第 1 步：一行命令生成模板

进入 `packages/qq-agent-core` 目录，运行脚手架命令：

```bash
cd packages/qq-agent-core
npm run new:skill weather-query -- --name "天气查询" --category utility --desc "查询城市实时天气"
```

执行后会生成 `skills/weather-query/` 文件夹，核心只有两个文件：
- `skill.json`：**说明书**（告诉系统技能名字、需要什么权限、有哪些设置开关）。
- `index.js`：**执行代码**（登记工具并实现查询逻辑）。

启动本地开发热重载模式（修改保存后自动生效，无需重启）：

```bash
QQ_AGENT_DEV=1 npm run server
```

---

## 第 2 步：填写 `skill.json` 与 `index.js`

> 注意：使用 VS Code 或记事本保存为 **UTF-8** 编码（避免使用 Windows PowerShell 重写中文文件导致乱码）。

### 1. 修改 `skills/weather-query/skill.json`

因为查天气需要访问外网接口，加上 `"permissions": ["web_fetch"]` 声明联网权限：

```json
{
  "id": "weather-query",
  "name": "天气查询",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "查询指定城市的实时天气",
  "enabledByDefault": true,
  "permissions": ["web_fetch"],
  "prompt": {
    "sections": [
      {
        "id": "weather-tip",
        "title": "天气查询",
        "priority": 40,
        "content": "群友问天气、气温或要不要带伞时，调用 get_weather 工具查询并用自然语气回答。"
      }
    ]
  }
}
```

- `category` 只能填以下五种之一：`utility`（通用工具，拿不准就填它）、`media`、`message`、`model`、`knowledge`。
- `priority` 最大为 `99`，排在系统安全规则之后。

### 2. 修改 `skills/weather-query/index.js`

```js
export function setup(api) {
  api.registerTool({
    id: 'get_weather', // 只能用字母、数字、- 和 _，不要用 . 或 :
    name: '查询天气',
    description: '查询指定城市的实时温度、天气和湿度。当用户询问天气、气温、穿衣或带伞时使用。',
    category: 'web',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 北京 或 Shanghai' },
      },
      required: ['city'],
    },
    async execute(_ctx, args) {
      const city = String(args?.city ?? '').trim();
      if (!city) return { content: '缺少城市名参数', isError: true };

      try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await api.fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const now = data.current_condition?.[0];
        if (!now) throw new Error('未查到该城市天气');

        return {
          content: `${city}当前天气：${now.weatherDesc?.[0]?.value ?? '未知'}，温度 ${now.temp_C}°C，湿度 ${now.humidity}%`,
        };
      } catch (err) {
        return { content: `查询失败：${err.message}`, isError: true };
      }
    },
  });
}
```

**三个关键细节**：
1. **`description` 要写清“什么时候用”**：模型完全靠这句话判断是否调用你的工具。
2. **工具 `id` 只用字母、数字、`-`、`_`**：系统会自动拼成 `weather-query__get_weather`；含 `:` 或 `.` 会导致大模型接口报 `400`。
3. **出错返回 `{ content, isError: true }`**：用 `try / catch` 兜底，让模型能看到错误原因并礼貌回复群友。

---

## 第 3 步：测试与添加用户配置项

保存文件后：
1. 打开控制台「技能」页，确认「天气查询」显示 **生效中**。
2. 在白名单群里发送 `@机器人 今天北京天气怎么样？`，即可看到机器人调用工具回复实时天气。
3. 运行自检命令确认没有格式隐患：

```bash
npm run test:skill
npm run test:audit
```

### 进阶：给技能加可视化设置项

如果想让用户在界面上自己调整参数（如温度单位），只需在 `skill.json` 中增加 `settings` 与 `configSchema`，无需写任何前端代码：

```json
"settings": { "showHumidity": true },
"configSchema": {
  "showHumidity": { "type": "boolean", "label": "显示湿度", "default": true }
}
```

然后在 `index.js` 的 `setup(api)` 中保存 `const cfg = api.config;`，在 `execute` 执行时调用 `cfg().showHumidity` 读取最新值即可。

---

## 常见问题速查

| 现象 | 原因与解决方法 |
|---|---|
| 显示“加载失败：`Unexpected token`” | `skill.json` 少了引号或多了末尾逗号，检查 JSON 语法。 |
| 报错“未声明 `web_fetch` 权限” | 在 `skill.json` 顶层补上 `"permissions": ["web_fetch"]`。 |
| 状态“生效中”，但机器人从来不用它 | 把工具 `description` 写具体，明确写出“当用户询问……时调用”。 |
| 修改代码后没反应 | 启动时加上 `QQ_AGENT_DEV=1`，或在界面点击重载 / 重启服务。 |

需要查阅更完整的 `ctx` 方法（读聊天记录、读写记忆、主动发消息、调用 QQ 群管接口），请继续阅读 [skill-development.md](./skill-development.md) 与 [skill-reference.md](./skill-reference.md)。
