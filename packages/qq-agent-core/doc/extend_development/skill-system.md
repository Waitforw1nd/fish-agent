# 扩展系统架构（Skill & Plugin）

`qq-agent-core` 的所有可插拔模块由 `SkillManager` 与 `plugin-loader.js` 统一管理：核心不硬编码具体扩展名，而是按**能力名（capability）**、**钩子（hooks）**和**工具（tools）**动态装配。

> 想动手写扩展请直接看：
> - 零基础快速上手：[skill-guide-for-beginners.md](./skill-guide-for-beginners.md)
> - 确定性插件（`plugins/`）：[plugin-development.md](./plugin-development.md)
> - 大模型工具技能（`skills/`）：[skill-development.md](./skill-development.md)
> - 完整字段与 `ctx` 手册：[skill-reference.md](./skill-reference.md)

---

## 1. 两类扩展与加载分层

| 类型 | 目录 | 清单文件 | 触发者 |
|---|---|---|---|
| **确定性插件** | `plugins/<id>/` | `plugin.json` | 核心代码按 `providers` / `hooks` 条件必然调用，不经过 LLM |
| **LLM 工具技能** | `skills/<id>/` | `skill.json` | 注册 `registerTool` 工具与 `prompt.sections`，由模型自主决定调用 |

### 多层目录覆盖（云端与单机通用）

加载器按顺序扫描以下三层目录（后层同 `id` 覆盖前层）：
1. **包内内置目录**（`plugins/`、`skills/`）：如 `bili-watcher`、`trpg-dice-hook`、`anti-ban-guard`、`bili-agent-pack`。可通过数据目录下的 `blocked-extensions.json` 按实例屏蔽。
2. **管理员受信目录**（`QQ_AGENT_ADMIN_PLUGINS_DIR` / `QQ_AGENT_ADMIN_SKILLS_DIR`）：云端管理员按实例安装或从公共库分发的扩展。
3. **租户扩展目录**（`QQ_AGENT_PLUGINS_DIR` / `QQ_AGENT_SKILLS_DIR`）：云端模式下默认锁定不加载，仅在部署方确认系统级隔离（`QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED=1`）后启用。

---

## 2. 四层状态与工具可用性链

每个扩展的生效状态由四层条件串联决定（任一不满足均给出明确 `code` 与 `reason`）：

```text
loaded（代码加载成功）
  && enabled（config.skills[id].enabled 开关开启）
  && available（manifest.requires 依赖能力就绪 + 同步 available() 返回 true）
  => active（最终生效）
```

关闭扩展开关（`enabled = false`）时，其注册的工具、能力、钩子和提示词片段**同时失效**，并立即执行 `deactivate()` 回收资源。

单个工具是否发给大模型，按以下 7 步顺序判定：
1. 全局工具开关 `tools.enabled`
2. 所属扩展处于 `active`
3. 工具 `requires` 能力就绪
4. 所属工具分类（`tools.categories.*`）开启
5. 单工具未被禁用
6. 模态依赖满足（`requiresVision` / `requiresSearch`）
7. 未被 `tool.guard` 能力动态否决

---

## 3. 核心管理接口与调试命令

| 接口或命令 | 用途 |
|---|---|
| `npm run new:skill <id>` | 生成 `skills/<id>/` 脚手架（加 `--legacy` 生成 `plugins/<id>/`） |
| `QQ_AGENT_DEV=1 npm run server` | 开启文件监听热重载（保存 500ms 内自动重扫生效） |
| `npm run test:skill` / `npm run test:audit` | 运行扩展生命周期测试与工具/能力一致性静态审计 |
| `GET /api/skills`、`POST /api/skills/:id` | 读取扩展诊断状态、切换开关或更新 `configSchema` 设置 |
| `POST /api/skills/reload` | 显式触发重扫目录与热重载（云端安装/卸载扩展后自动调用） |
