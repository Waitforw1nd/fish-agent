# 测试、fake、E2E 与故障排查

NapCat P1 本地实现待 P0 真实容器验收，不代表 P1 已完成。`node --test packages/qq-agent-core/test/headless-runtime.test.mjs packages/qq-agent-core/test/headless-transport.test.mjs packages/qq-agent-core/test/napcat-media.test.mjs packages/qq-agent-core/test/napcat-redirect.test.mjs` 验证 headless HTTP/WS fixture：图片工具经下载后首次 action 为 base64，断开和短超时均只请求一次，三个入站路径拒绝宿主读取，超限拒绝；受控 DNS 夹具确认公网首跳实际返回 302 后拒绝私网目标。`node --test packages/cloud-manager/test/headless.test.mjs packages/cloud-manager/test/napcat-agent-contract.test.mjs` 验证配置代际、实际身份、健康缓存和 HTTPS 网关跳转。核心 `npm run test:coverage` 通过；根 `npm test` 因本机缺少 SnowLuma/便携 QQ，`setup-qq-version.mjs` 的 CLIENT_BUILD 检查失败。Windows 不支持 POSIX SIGTERM 的测试跳过。以上模拟测试不证明真实容器或 QQ 可用；VPS SSH 公钥认证失败，真实验收仍受阻，P2/P3 不属于已完成范围。

原则：用真实 HTTP/WS、真实子进程和临时目录验证集成，但外部 QQ/B 站/模型服务使用 fake。编译或 import 成功不能代替场景测试。

统一运行时：

```bash
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
```

目标上游 0.4 headless 支持 Node 22/24；cloud-manager 使用 Node 24。完成核心迁移后，可在 `packages/qq-agent-core` 运行 `npm run test:headless`，以及上游 Docker 测试入口：

```bash
docker build --target test -t qq-agent-headless-test -f modules/headless/Dockerfile .
docker run --rm --network none qq-agent-headless-test
```

此测试使用模拟协议和模型，不代表真实 QQ 或 B 站联调通过。

## 1. 标准命令与重点测试

| 包 | 全量/标准命令 | 重点契约命令 |
|---|---|---|
| qq-agent-core | `npm test`；补充 `npm run test:coverage`；全量 `npm run test:all` | `node test/channel-router-test.mjs`、`node test/send-guard-test.mjs`、`node test/extensions-test.mjs`、`node test/final-integration-test.mjs` |
| protocol-bili-bridge | `npm run check && npm test` | `npm run test:unit`、`node --test test/e2e.test.mjs test/onebot.test.mjs` |
| protocol-qq-llbot | `npm run check && npm test && npm run build` | `npm run test:unit`、`npm run test:webui` |
| cloud-manager | `npm test` | `node --test test/api.test.mjs test/lifecycle.test.mjs test/qq-llbot.test.mjs test/bili.test.mjs test/relay.test.mjs` |
| cloud panel | `npm --prefix panel test`（在 cloud-manager 目录） | 无构建步骤。 |

核心安装检查依赖本机组件。缺少 SnowLuma/便携 QQ 时，应先 `npm run setup` / `npm run setup:check`，或把该环境阻塞写清楚并运行不依赖这些组件的专项测试；不要静默跳过失败后声称 `npm test` 全绿。

## 2. 测试与 fake 清单

### 2.1 qq-agent-core

主链测试文件：

- 基础与端到端：`selftest.mjs`、`coverage-offline.mjs`、`coverage-http.mjs`、`coverage-e2e.mjs`、`coverage-ui.mjs`、`coverage-wiring.mjs`。
- 社区/Skill/工具：`community-test.mjs`、`skill-test.mjs`、`tools-skill-audit.mjs`、`skill-modal-ui.mjs`、`sticker-context.mjs`。
- OneBot/消息：`onebot-whitelist-test.mjs`、`message-id-test.mjs`、`sender-file-uri-test.mjs`、`sender-send-path-test.mjs`、`channel-router-test.mjs`、`send-guard-test.mjs`。
- 表情/媒体/下载：`sticker-collect-test.mjs`、`safe-fetch-file-test.mjs`、`market-zip-test.mjs`、`zip-install-security-test.mjs`。
- UI/用量：`render-test.mjs`、`scroll-test.mjs`、`usage-e2e.mjs`、`usage-daily-test.mjs`。
- 提示词/唤醒：`test-prompt.mjs`、`prompt-anchor-test.mjs`、`wake-semantics-test.mjs`。
- 安装运行：`setup-qq-version.mjs`、`setup-download.mjs`、`qq-pack.mjs`、`qq-process-detect.mjs`、`vendor-mirror-test.mjs`。
- 角色卡：`persona-card-test.mjs`、`persona-card-route-test.mjs`、`persona-import-ui.mjs`。
- 扩展与最终集成：`extensions-test.mjs`、`extensions-cloud-test.mjs`、`final-integration-test.mjs`。
- 其他：`web-search-parse.mjs`。

测试支撑：`_harness.mjs` 启动带 fake OneBot/LLM 的核心应用，`_ui-load.mjs` 加载 UI，`judge-cases.json` 是评审用例。`final-integration-test.mjs` 实际验证骰子命令存档和出站、不调用 LLM、普通消息回落、插件异常隔离及 `bili_*` 超时。

### 2.2 protocol-bili-bridge

测试文件：`auth.test.mjs`、`config.test.mjs`、`wbi.test.mjs`、`mapping.test.mjs`、`message.test.mjs`、`onebot.test.mjs`、`video.test.mjs`、`live.test.mjs`、`pollers.test.mjs`、`util.test.mjs`、`e2e.test.mjs`。

fake：

- `test/support/fake-bili.mjs`：passport 扫码、账号、评论、私信、UP、视频、点赞、Cookie 保活等 B 站 HTTP API。
- `test/support/fake-danmaku.mjs`：直播 WS、认证、心跳、zlib/brotli 弹幕事件。
- `test/support/helpers.mjs`：临时目录、端口 0、测试 token、HTTP/admin 调用和等待。

`e2e.test.mjs` 真实启动桥接和 WS/HTTP，完成“fake 扫码 → 订阅 → 评论/私信/UP/直播事件 → OneBot WS → action 回复 → fake B 站”，并检查所有 ID 位于 B 站安全号段。

### 2.3 cloud-manager

测试文件：`api.test.mjs`、`bili.test.mjs`、`gateway-ws.test.mjs`、`lifecycle.test.mjs`、`panel-contract.test.mjs`、`qq-drivers.test.mjs`、`qq-llbot.test.mjs`、`relay.test.mjs`、`unit.test.mjs`。

`test/helpers.mjs` 使用临时 `CLOUD_DATA_DIR`、panel/Relay 端口 0、动态端口池和 fake 子进程入口。fake 清单：

- `fake-agent.mjs`：Agent 控制台、配置写入、请求/SSE。
- `fake-llbot.mjs`：WebUI 密码、auth token 状态、二维码、OneBot WS、`__fake/online` 手工上线。
- `fake-qqproto.mjs`：NapCat/SnowLuma 驱动生命周期。
- `fake-bili.mjs`：B 站 admin 登录状态、订阅和手工上线。
- `fake-upstream.mjs`：模型列表、普通/流式 chat completions、usage 和错误。
- `fake-crash.mjs`：Supervisor 崩溃退避。

这些 fake 证明管理面与进程 wiring，不证明真实协议端可用。

### 2.4 panel 与 LLBot

panel：`api.test.mjs`、`dom-views.test.mjs`、`view-data-validate.test.mjs`、`normalize.test.mjs`、`format.test.mjs`、`router-polling.test.mjs`；支撑为 `helpers/dom-stub.mjs`、`helpers/fake-timers.mjs`。覆盖同源 API、CSRF、秘密脱敏、二维码轮询、账单格式化和页面隐藏时暂停轮询。

LLBot：`test/unit` 与 `test/webui` 由 Vitest 运行，覆盖 Direct session/sign token/重连、OneBot/Satori/Milky、登录路由、WebUI auth 和前端 store/utils。当前不是手机扫码 E2E。

## 3. 双租户 E2E

### 3.1 自动执行

```bash
cd /e/bigPeach/fish/packages/cloud-manager
export PATH="/e/bigPeach/fish/.tools/node:$PATH"
node --test test/api.test.mjs test/lifecycle.test.mjs test/relay.test.mjs
```

覆盖的隔离契约：

1. admin 创建 Alice/Bob 两个用户，分别创建 Alice/Bob 租户。
2. 普通用户只列出自己的租户；访问对方详情或启动对方租户返回 403。
3. 缺少 CSRF 的写请求返回 403 `CSRF_FAILED`，跨站 Origin 也被拒绝。
4. 两租户启动不同 Agent 子进程；`<alice-slug>.test.local` 与 `<bob-slug>.test.local` 各自只能访问自己的控制台。
5. Bob 的有效会话不能访问 Alice 子域，证明隔离不只依赖“知道 slug”。
6. 停掉第一个租户，第二个 Agent 仍 running 且健康；不同 Agent 端口不同。
7. 并发分配多个端口租约无重复，同 purpose 重取会复用。
8. 云端 `/api/config` 会锁定 Relay/通道/server 等字段，强制白名单与 cross-chat 安全设置；代理请求注入正确内部 token，不带 panel Cookie。
9. Relay Key 按租户签发，账单/钱包/用量按 tenantId 记录；过期会同时封锁 Gateway 和 Relay，续费后可重启。
10. SSE 和 WS 代理也执行相同鉴权与过期关闭。

`api.test.mjs` 和 `lifecycle.test.mjs` 是双租户 fake E2E 的基准。修改租户模型后必须同时跑，不要只测一个租户能启动。

### 3.2 B 站与 LLBot 专项链路

```bash
cd /e/bigPeach/fish/packages/cloud-manager
node --test test/bili.test.mjs test/qq-llbot.test.mjs test/relay.test.mjs
```

- B 站：fake QR waiting → fake online → 配置热应用 → Agent `channels.bili` 写回 → 停止。
- LLBot：prepare/start → 无 token 时 QR 409 → 设置 token → validating/valid → fake QR → fake online → Agent `channels.qq` 写回 → 错误 UIN 停止。
- Relay：模型白名单、普通/流式响应、结算、失败释放、余额不足、充值和 RPM。

## 4. 真实环境验收（当前均未执行）

以下不能由 fake 结果替代，部署后应逐项记录实际结果：

- [ ] 真实 LLBot auth token 校验、手机 QQ 扫码/确认、session 恢复、预期 UIN 一致性。
- [ ] 真实 QQ OneBot 收发、@/reply、图片/表情、断线重连和自消息过滤。
- [ ] 真实 B 站扫码、SESSDATA/refresh token 保活、评论/私信/UP/直播事件和回复。
- [ ] 真实 B 站风控、频控、长文/图片失败语义；不把 fake 发图路由当在线发图能力。
- [ ] 真实 OpenAI 兼容上游的模型列表、普通/流式 usage、价格和错误映射。
- [ ] 双真实租户同时在线时的账号、数据、扩展、端口和账单隔离。

## 5. 常见故障

| 症状/错误 | 优先检查 |
|---|---|
| `node` 版本不对、找不到 `node:sqlite` | 当前终端未执行便携 PATH；cloud-manager 需要 Node 24。 |
| 核心 B 站 WS/HTTP 一个通一个不通，或 HTTP 426 | 核心默认 3100/3101 与独立桥接同端口 36501 不一致；HTTP 不可指向 WS-only 端口。云端应使用动态同端口。 |
| B 站管理 API 503 | 未设置 `BILI_ADMIN_TOKEN`；admin 与 OneBot token 不同。 |
| OneBot/admin 401 | 检查 token 来源、Bearer/header、是否误把 LLBot auth token 当 OneBot token；admin token 不应放 URL。 |
| 非回环启动直接报配置错误 | 必须配置两种 token且长度/不同值合规；不要用弱开关代替生产鉴权。 |
| B 站目标被报“不在任何通道号段”或“未启用” | ID 必须是 B 站映射生成的安全整数，不能直接使用 mid/BVID/rpid；检查 channels.bili.enabled。 |
| `message_id` 无法判定/撞号 | 双通道下传显式 `platform`；不要按默认 QQ 猜，重启前旧 ID 也没有内存归属。 |
| B 站发图失败 | 当前桥接明确不支持图片，`can_send_image=false`；核心路由允许不代表桥接能发。 |
| B 站回复过长/被限频 | 核心和桥接都有长度与低频保护；评论不会拆成多条，缩短内容并等待，不要重试风暴。 |
| `LLBOT_NOT_BUILT` | 在 protocol-qq-llbot 执行 `npm run build`，或修正 `CLOUD_LLBOT_ENTRY`。 |
| `AUTH_TOKEN_REQUIRED/INVALID/VALIDATING` | 普通用户联系平台管理员检查平台授权；管理员检查平台或租户 token，等待 `/qq/status` 中 validation=valid 再取 QR，不要频繁重启。 |
| QQ 扫码后 `uin_mismatch` | 登录账号与 prepare 的 expected UIN 不一致，管理器已主动停止；用正确账号重新扫码或重新 prepare。 |
| B 站扫码 success 但无登录态 | 成功回调必须含 SESSDATA；过期重新生成，Cookie/refresh 文件解密失败时核对 secret key，不要删除唯一备份。 |
| 云 panel 登录成功但写操作 403 | Cookie 不等于 CSRF；检查 X-CSRF-Token、Origin/Referer、反向代理 host/scheme。 |
| 租户子域 404/503 | 检查 slug + baseDomain、DNS/Host、成员权限、active 状态和 Agent running；`127.0.0.1` 访问的是管理面而非租户面。 |
| Relay 401/402/403/429 | 分别检查 Bearer Key、租户到期/余额、套餐模型白名单、RPM/TPM/并发。 |
| Relay 上游 502/503 | 管理面 `/api/admin/upstream` 是否配置，base URL 是否应含 `/v1`（Relay 会兼容两种），真实上游是否在线；fake 通过不代表真实通过。 |
| 余额一直预占 | 检查 reservations 状态与过期清理；成功 settle、失败 release，stream 中断也会按已获内容结算。 |
| 修改 Agent config 没生效 | 云管字段由 `AgentRuntime` 重写且 Gateway 锁定；不要手改租户文件期待持久，应该改对应管理 API/服务。 |
| 扩展“加载成功但模型看不到” | 只有 `registerTool` 会进入模型 tools；providers/hooks 应放 plugins。检查启用、requires 和目录 env 是否替换掉了包内扩展。 |
| 禁用扩展仍有定时器/工具 | 实现 deactivate/dispose，跑热重载与禁用测试；不能仅改前端开关。 |
| 角色卡的系统指令“没生效” | 这是安全设计：system_prompt/post_history/creator_notes/世界书/assets 被有意排除，不是解析故障。 |
| 核心全量测试在 setup QQ 检查失败 | 本机缺 SnowLuma/便携 QQ；先 setup 或记录环境阻塞，再运行专项，不要改测试来掩盖。 |

## 6. 修改后验证清单

- [ ] 被改包标准 check/test/build 已执行，退出码和失败项已记录。
- [ ] 改动涉及两个包时，跨包契约测试已执行，而非只跑单包。
- [ ] fake 使用临时数据目录，未读取或修改真实账号数据。
- [ ] 安全负例已测：跨平台误发、越权、跨租户、秘密泄露、失败释放、异常 fail-closed。
- [ ] 文档中的路径、API、配置键和默认值已重新对照源码。
- [ ] 真实 QQ/B 站/上游 Relay 的未验证项仍明确标注。

## 7. 历史验证结果

在当前工作区使用便携 Node `v24.22.1`、npm `11.19.1` 实测：

- protocol-bili-bridge：`npm run check && npm test` 通过，61/61。
- cloud-manager：`npm test` 通过，19/19；panel 54/54。
- protocol-qq-llbot：`npm run check`、`npm test`（24 个文件、230/230）和 `npm run build` 通过。测试中 WebUI 访问日志目录缺失会打印 stderr，但测试断言全部通过。
- qq-agent-core：主 `npm test` 在 `setup-qq-version.mjs` 因本机缺 SnowLuma/便携 QQ 出现 1 项失败并停止；此前执行的用例通过。
- 随后单独执行 `channel-router-test`、`send-guard-test`、角色卡三组、zip 安全、extensions 两组和 `final-integration-test`，全部通过。

这些结果只覆盖上述 fake/本地场景。真实 QQ、真实 B 站、真实上游 Relay 均未验证。

## 8. 2026-10-29 本次收口验证

Windows 本地工作区，Node v24.22.1、npm 11.19.1；其他模块并行修改期间执行，结果反映执行时工作区，最终集成后需重跑。未进行部署或真实账号联调。

- 根 `npm run check` 通过。修复 npm CLI 调用后，根 `npm run test:all` 不再出现 Windows `spawnSync npm.cmd EINVAL`；Bili 桥 72/72、cloud-manager 28/28 通过，核心在 `setup-qq-version.mjs` 停止：84 通过、1 失败，`--check` 无法报告 CLIENT_BUILD，输出显示 SnowLuma 与便携 QQ 缺失。标准全量命令因此仍失败。
- panel 独立 `npm test` 通过 65/65。根 cloud-manager 测试不包含 panel。
- 核心主测试阻断点之后的 18 个文件逐个运行，全部退出 0：`setup-download`、`qq-pack`、`qq-process-detect`、`sender-file-uri-test`、`sender-send-path-test`、`vendor-mirror-test`、`safe-fetch-file-test`、`market-zip-test`、`web-search-parse`、`channel-router-test`、`send-guard-test`、`persona-card-test`、`persona-card-route-test`、`persona-import-ui`、`zip-install-security-test`、`extensions-test`、`extensions-cloud-test`、`final-integration-test`。
- 核心五个 coverage 文件逐个运行：`coverage-http`、`coverage-e2e`、`coverage-wiring` 通过；`coverage-offline` 147 通过、1 失败，`example.com` 被 DNS 检查判为内网/本机；`coverage-ui` 20 通过、1 失败，测试要求小写 `qq-agent-v...-setup.exe`，页面实际使用 `QQ-Agent-V0.4-Preview-Setup.exe`，断言与页面不一致。未更改测试或产品文件掩盖失败。
- 根测试在核心 setup 处停止，故上述 18 个文件和 coverage 并非通过根命令执行；LLBot check/test/build 本次未重复运行，历史结果见第 7 节。根脚本不包含独立 panel 和 headless 命令。

以上是本地及 fake 测试，不代表真实服务验收。QQ 扫码与收发、B 站登录和动作、真实模型用量与成本、双租户隔离、ZIP 上传到实际调用均待 VPS 验证。租户上传代码在 Agent 进程执行，Linux 用户、文件、网络和进程隔离是上线阻塞；环境变量声明本身不提供隔离。

## 9. 2026-10-29 coverage 修复后复验

- `coverage-offline` 在独立子进程使用受控 DNS 替身验证公网解析、混合私网结果拒绝和解析失败拒绝；生产 SSRF 校验未更改。`coverage-ui` 将安装页链接与 `package.json` 的 electron-builder `artifactName` 精确比对，并检查相对文件名和版本。两项此前失败均已修复。
- 核心 `npm run test:coverage` 的五组全部通过；其中 offline 148/148、UI 21/21。核心 `test:headless` 13 通过、1 项 POSIX SIGTERM 测试因 Windows 跳过。核心 attribution、Bili context、扩展 HTTP 和双租户四文件共 5/5 通过；根 `npm run check` 通过。
- 根 `npm run test:all` 复验：Bili 73/73、cloud-manager 29/29 通过；核心仍在 `setup-qq-version.mjs` 以 84 通过、1 失败停止，因为未安装 SnowLuma/便携 QQ 时 `--check` 未显示 CLIENT_BUILD。根命令未执行核心后续主测试和 coverage；本次 coverage 为单独运行。第 8 节记录的后续 18 个主测试是之前执行结果，并非本次重跑。
- 双租户测试改为使用测试文件自身路径，适用于从包目录运行；扩展 HTTP 测试按当前 Bili watcher 默认启用的清单更新断言。测试在本地 fake 环境运行，未安装或伪造 QQ 组件，也未验证真实账号与 VPS 隔离。

## 10. 用户实例权限与扫码接口复验

在 Windows 本地以 Node 24 运行 cloud-manager `npm test`，30/30 通过。`test/user-tenant-permissions.test.mjs` 使用真实 HTTP、临时数据和 fake LLBot：验证 Alice 两实例与 Bob 一实例、成员列表与按 owner 查询的区别、管理员全量和按用户查询、trial 限额及选择 starter 的现有规则；验证跨租户、viewer、暂停、过期和无会话的拒绝，且被拒绝时未调用 QQ 协议方法。预先配置平台测试授权后，普通 owner 只传 QQ 号即可使用默认 LLBot prepare/start 和获取 fake QR，响应不包含测试平台授权或协议密码；平台授权缺失时返回提示联系管理员。

最终 panel 独立测试 75/75 通过，根 `npm run check` 通过。内置浏览器使用隔离 fake fixture 验证了普通用户“我的鱼”→实例详情→二维码弹窗、管理员用户列表及用户实例子页、为指定用户创建实例，以及全局总览中显示实例所属用户 `fixtureuser`。首次残留和新 fixture 临时目录均已确认删除，相应进程已退出、端口无监听，浏览器标签已关闭。

浏览器与 HTTP 测试均使用 fake，尚未验证真实手机 QQ 扫码、真实 LLBot 授权或 VPS 环境。


## 11. NapCat P1 本地集成验证与真实验收边界

以下为本次 Windows / Node 24 本地与 fake 验证结果：cloud-manager 后端 46/46、panel 80/80；核心 headless、传输和媒体测试 18 通过、1 项因 Windows 不支持 POSIX SIGTERM 跳过；核心 `npm run test:coverage` 和根 `npm run check` 通过。根 `npm test` 在 `setup-qq-version.mjs` 以 84 通过、1 失败停止，本机缺少 SnowLuma 和便携 QQ，无法报告 CLIENT_BUILD。

浏览器使用 fake 验证了两类实例相关流程，不能代表真实 QQ。核心测试覆盖 NapCat HTTP 图片首发 base64、发送超时与断开后不重发、媒体路径拒绝、下载超限及公网首跳重定向至私网拒绝；Agent 健康和 HTTPS 网关使用本地 fixture 验证。

这些结果不构成 P0 或 P1 真实验收：目标 VPS 的 SSH 返回 `Permission denied (publickey)`，真实 NapCat 容器、扫码、QQ 消息、模型对话及 HTTPS 控制台均未验证。P1 是本地实现待 P0 真实容器及 P1 单实例闭环验收，不能标为完整交付；P2 完整切换事务和 P3 全量恢复尚未完成。
