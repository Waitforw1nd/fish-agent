# 测试指南与常见问题排查

项目的集成链路测试采用**真实 HTTP / WebSocket + 真实子进程 + 隔离临时目录**，将外部 QQ、B 站与大模型服务替换为本地 Fake 模块，无需真实账号即可回归核心契约。单元和故障回归另有 DOM、计时器、文件系统及接口替身；它们用于验证特定边界，不能代替真实平台、Electron 原生安全或完整业务链路验收。

运行测试前请先启用 Node 24：

```bash
export PATH="$PWD/.tools/node:$PATH"
```

---

## 1. 各包测试命令速查

| 模块 | 目录 | 全量测试命令 | 常用定向测试 |
|---|---|---|---|
| **全仓** | 仓库根目录 | `npm run test:all` | `npm run check`（脚本与语法检查）、`npm test`（串联桥接、云端、面板、核心及桌宠测试） |
| **云端管理后端** | `packages/cloud-manager` | `npm test` | `node --test test/api.test.mjs test/lifecycle.test.mjs test/relay.test.mjs` |
| **云端 Web 面板** | `packages/cloud-manager` | `npm --prefix panel test` | `node --test panel/test/agent-client-integration.test.mjs` |
| **Agent 核心** | `packages/qq-agent-core` | `npm run test:all` | `npm test`、`npm run test:coverage`、`npm run test:headless`、`node test/channel-router-test.mjs` |
| **B 站协议桥接** | `packages/protocol-bili-bridge` | `npm run check && npm test` | `npm run test:unit`、`node --test test/e2e.test.mjs` |
| **桌宠客户端** | `packages/desktop-pet` | `npm test` | `node --test test/recovery-capabilities.test.mjs` |
| **LLBot 协议端** | 仓库根目录 | `npm run llbot:check && npm run llbot:test` | `npm run llbot:build` |

> **环境差异提示**：
> - `packages/qq-agent-core` 的 `npm test` 包含 `setup-qq-version.mjs` 检查；它在临时目录内运行安装检查器及版本 fixture，不依赖真实 QQ 或 SnowLuma 安装，也不启动真实 QQ。完整验收仍须运行根目录 `npm run test:all`。
> - `packages/cloud-manager` 包含 2 项 Linux 专属进程组（PGID）回收测试（Windows 下自动 skip）；若在 Linux 隔离容器或自定义 PID namespace 中运行测试，请确保由 `systemd`、`tini` 或 `dumb-init` 担任 PID 1 负责回收孤儿僵尸进程，否则进程组存活检测会因未回收僵尸进程而失败。
> - 全仓脚本按顺序执行，遇到失败立即停止；未运行的后续套件不能计作通过。`test:all` 还包含核心 headless、多入口、补充覆盖及 LLBot 检查和测试。
> - 核心覆盖检查分别报告通过、失败、已知缺陷及跳过；已知缺陷与普通失败一样令进程非零退出。未安装可选依赖、没有技能或缺少本机安装包时，相关检查明确记为跳过，不能算作通过。检查器的计数与退出码有独立子进程回归测试，并接入 `test:coverage`。
> - 第 4 轮补齐自定义测试脚本的相同口径：无打包归档、未执行真实系统 QQ 进程检测均明确报告跳过；QQ 进程解析使用中文路径夹具。渲染函数缺失直接失败；技能可用性检查使用生产加载的函数，异常不能当跳过；用量页下钻必须验证临时会话的非零统计，不再因空数据略过。
> - 第 7 轮继续收紧隔离安装检查：`setup --check` 夹具必须以预期退出码 1（未安装便携 QQ）结束，无终止信号或错误输出，并报告夹具版本。只打印 `CLIENT_BUILD` 后崩溃不算通过。本轮在隔离副本移除 B 站取消检查、注入安装检查崩溃，两类负向验证均成功触发测试失败，见 [负向验证证据](evidence/review7-negative-controls-2026-11-03.json)。
> - 第 8 轮要求隔离插件覆盖用例的子进程在 30 秒内正常退出，检查启动错误、终止信号及退出码。即使已经写出预期 trace，随后异常退出也必须失败。`checker-report.test.mjs` 用写 trace 后退出 7 的真实子进程回归这一要求。
> - 第 14 轮将此前遗漏的 6 个核心测试文件纳入 `test:all`，覆盖 Relay 归因、B 站上下文、扩展 HTTP 契约和租户隔离、NapCat 媒体与重定向安全，共 9 项。单独运行这些文件全部通过，最终全量会再次执行。
> - HTTP 路由报告区分实际覆盖、危险操作排除及未覆盖。4 条会打开窗口或影响用户进程的路由不执行，也不计作已覆盖；90% 门槛针对剩余可测路由，另行报告完整路由分母。第 3 轮本机实测为可测 81/89（91.01%）、完整 81/93（87.10%），并非全部接口已验收。

---

## 2. 测试结构与 Fake 模块

- **`packages/cloud-manager/test/`**：
  - 使用 `port-pool.mjs` 为并行测试进程分配互不重叠的独占端口段，使用临时 `CLOUD_DATA_DIR` 隔离数据库与密钥。
  - 内置 Fake 桩件（`test/fixtures/`）：`fake-agent.mjs`（控制台与配置回环）、`fake-llbot.mjs`（授权与扫码状态机）、`fake-docker-runner.mjs`（模拟 NapCat 容器编排）、`fake-bili.mjs`、`fake-upstream.mjs`（普通/流式模型响应与计费 usage）、`fake-crash.mjs`（进程退避重启）。
- **`packages/cloud-manager/panel/test/`**：
  - 基于轻量 DOM 桩件与真实后端联调（`agent-client-integration.test.mjs`），覆盖用户工作台五页签、管理员七大模块、CSRF、脱敏、轮询暂停及未保存离开提醒。
- **`packages/protocol-bili-bridge/test/`**：
  - `fake-bili.mjs` 与 `fake-danmaku.mjs` 模拟扫码、评论/私信/动态/直播入站事件、虚拟 ID 区间及只读拒绝；Explore 使用本地字幕与假模型验证日记、草稿及批准后零发布。低层写请求编码仅在显式回环 fixture 中测试，Bridge 不开放内容写入。
- **`packages/qq-agent-core/test/`**：
  - `_harness.mjs` 驱动带假 OneBot 和假 LLM 的完整核心实例，覆盖双通道路由、发送守卫、SillyTavern 角色卡过滤、ZIP 扩展安全安装、三层插件屏蔽与热重载。

### 运行多租户隔离 E2E

修改租户权限、网关、端口池或计费后，务必运行双租户隔离回归：

```bash
cd packages/cloud-manager
node --test test/api.test.mjs test/lifecycle.test.mjs test/user-tenant-permissions.test.mjs test/relay.test.mjs
```

该组合会验证：Alice 与 Bob 实例互不可见（越权 `403`）、写接口无 CSRF 拒绝、单实例停机不影响其他实例、云管配置字段锁定，以及钱包扣费和到期封禁按租户严格隔离。

---

## 3. 常见报错与排查表

| 现象或错误码 | 原因与解决办法 |
|---|---|
| 提示 Node 版本过低或找不到 `node:sqlite` | 当前终端未加载 Node 24；先执行 `export PATH="$PWD/.tools/node:$PATH"`。 |
| 机器人登录成功且在线，但群里 `@` 它完全不说话 | 检查实例**白名单**是否为空（云端强制空白名单不回复任何群），并确认未开启“暂停回复”且模型渠道可用。 |
| `CLOUD_NAPCAT_IMAGE` 相关错误 / NapCat 无法启动 | 宿主机未配置固定摘要的 NapCat Docker 镜像，或当前用户无 Docker 权限；按 [deploy/napcat/README.md](../deploy/napcat/README.md) 执行预检。 |
| `LLBOT_NOT_BUILT` | 未构建 LLBot；在仓库根目录运行 `npm run llbot:build`。 |
| `AUTH_TOKEN_REQUIRED` / `AUTH_TOKEN_INVALID` | LLBot Direct 模式缺少有效平台授权 Token；管理员在“平台设置”或实例通道页填入有效 Token，或改用 NapCat 内核。 |
| 扫码后显示 `uin_mismatch` | 手机扫码登录的 QQ 号与实例填写的目标 QQ 号不一致，系统已自动停止协议端；请用一致的 QQ 号重扫，或修改目标 QQ 号后重试。 |
| 面板登录成功，但保存/点击按钮报 `403 CSRF_FAILED` | 检查反向代理是否正确透传 `Host`、协议（HTTPS 需配 `CLOUD_PUBLIC_SCHEME=https` 与 `CLOUD_TRUST_PROXY=true`）及同源 `Origin`。 |
| Relay 返回 `401` / `402` / `403` / `429` | `401` Relay Key 无效；`402` 实例已到期或平台钱包余额不足；`403` 请求模型不在当前套餐白名单；`429` 触发 RPM/TPM/并发限流。 |
| 自定义模型渠道探测失败 | 默认仅允许公网 HTTPS 地址且禁止重定向（防 SSRF）；若在本地测试内网模型，需显式设置 `CLOUD_RELAY_CUSTOM_ALLOW_PRIVATE=true`。 |
| 核心手工直连独立 B 站桥接报 `426` 或连不上 | 独立桥接默认单端口 `36501`，需将核心 `channels.bili.httpUrl` 和 `wsUrl` 同时指向 `36501` 端口。 |
| B 站发送图片、私信、评论或弹幕被拒 | 当前 Bridge 强制只读，所有内容写入动作均返回拒绝。L1 只生成草稿，批准只修改本地状态；不可通过 `BILI_READ_ONLY=false` 恢复发布。登录与 Cookie 会话刷新属于鉴权操作，不发送互动内容。 |
| 导入角色卡后卡内的系统指令/世界书没生效 | 属正常安全设计：角色卡导入会自动剥离 `system_prompt`、`post_history_instructions`、世界书与脚本，防止提示词劫持。 |
