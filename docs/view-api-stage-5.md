# 阶段五：集成验证与文档同步

验证日期：2026-10-29（Asia/Shanghai）。运行环境：Windows、Node.js v24.22.1、npm 11.19.1。

当前状态：本地实施、集成验证与文档同步已完成。最终云端和面板完整套件均通过；核心标准测试仍有本机桌面组件缺失的环境阻塞，整套标准命令尚未全绿。

## 验证结果

所有 npm 命令从仓库根目录通过 `node .tools/node/node_modules/npm/bin/npm-cli.js` 调用；下表省略该公共前缀。

| 检查 | 命令或范围 | 实测结果 |
|---|---|---|
| 根脚本检查 | `run check` | 通过。 |
| 云端完整套件 | `--prefix packages/cloud-manager test` | 最终 135 项：133 通过，0 失败，2 项 Linux 专用测试在 Windows 跳过。包含最后的 Gateway、Agent 就绪与测试端口隔离修改。 |
| 面板完整套件 | `--prefix packages/cloud-manager/panel test` | 127 通过，0 失败，0 跳过。 |
| B 站桥接 | `--prefix packages/protocol-bili-bridge test` | 73 通过，0 失败。 |
| 核心标准链 | `--prefix packages/qq-agent-core test` | 在 `setup-qq-version.mjs` 停止：该文件 84 项通过、1 项失败，缺少 SnowLuma/便携 QQ 的 CLIENT_BUILD 诊断。 |
| 核心剩余标准命令 | 标准链中安装检查之后的 19 条命令，保持原命令顺序单独执行 | 19 条全部通过；包含角色卡、ZIP 安全、扩展和最终集成。此结果不替代整条 `npm test` 成功。 |
| 核心补充覆盖 | `--prefix packages/qq-agent-core run test:coverage` | 五组全部通过：离线 148、HTTP 116、端到端 46、静态 UI 21、真实 DOM 接线 5，共 336 项。 |
| 核心运行与传输补充 | `headless-runtime.test.mjs`、`headless-transport.test.mjs`、`config-extension-foundation.test.mjs` | IPC 就绪改动后复测 17 项：16 通过，0 失败，1 项 POSIX SIGTERM 测试在 Windows 跳过。 |
| 共享配置与扩展基础 | `node --test packages/qq-agent-core/test/config-extension-foundation.test.mjs` | 2 项通过；已纳入核心标准链。 |
| 面板客户端真实后端集成 | `node --test packages/cloud-manager/panel/test/agent-client-integration.test.mjs` | 独立复测通过，并再次包含于最终 127 项面板回归。 |
| 浏览器 | 本机 Chrome + Playwright，模拟 API | 18 个桌面路由、2 个手机路由通过，无脚本错误、未匹配 API 或整页横向溢出。 |
| 语法与补丁检查 | 变更 JS 的 `node --check`；Git `diff --check` | 最终 200 个变更 JS 文件全部通过；按 Windows CRLF 正确识别后的补丁检查通过。 |

云端的两项跳过为 Linux 进程组停止测试，核心补充检查另有一项 POSIX SIGTERM 跳过，不能用 Windows 结果代替。语法检查范围包括本轮开始前已有的工作区改动，不表示这些文件全部由本轮新增。各行存在重叠覆盖，不应相加为独立用例总数。

## 联调中修复的问题

- 共享配置抽离后保留旧迁移规则检查；修复提供商对象的 `api` 字符串被误当作嵌套配置处理的问题，恢复提供商新增、模型、密钥与删除链路。
- 校准自助改密的 PUT 方法、QQ 授权 `{token}`、B 站直播订阅字段，以及自定义渠道启用时的平台模型列表。
- 记忆读取携带成员备注，编辑未提交备注时保留原值；兼容核心的印象对象格式。
- 公共插件库按实际实例安装目录统计分发数量，批量弹窗显示每个实例当前安装状态；实例卸载可选择清配置和回退内置版本。
- 同源接口和旧 Gateway 共用配置及扩展权限检查、schema 安全参数与响应脱敏；插件抛错中的秘密不会经加载失败和工具诊断响应返回。技能能力根据可见 provider 重新计算，隐藏已屏蔽扩展提供的能力。
- 普通所有者恢复快照保留当前管理员扩展和屏蔽决定；与安装、卸载及设置写入按固定顺序加锁。
- Windows 扩展目录移动对暂时性文件句柄冲突提供最多约两秒的有界重试；真实核心在线安装、坏包回滚与错误脱敏场景连续 8 次通过。
- 最终并行回归曾出现一次渠道切换后 `ECONNREFUSED`。进一步以确定性测试证实旧 TCP 就绪检测会把临时监听器误判为 Agent；现改为实际子进程的 PID/端口 IPC 回执后再探测，9 项就绪及渠道定向测试通过。原日志不足以认定这次误判是那次连接失败的唯一原因，端口分配与绑定竞争仍可能导致明确的启动失败。
- 后续并行回归曾出现 `panel-contract` 等待授权状态超时，当时缺少租户状态与进程诊断，无法确定具体原因。检查发现各测试管理器的随机端口范围可能重叠，现以独占本地 socket 为各管理器保留互不重叠的测试端口段，正常停止或启动失败时释放。8 个并行进程互斥及管理器启动失败资源清理等 10 项定向测试通过；最终云端 135 项与面板 127 项均无失败。这证明修复后的回归结果，不将端口重叠认定为原超时的唯一原因。
- 取消离开未保存页面时恢复原地址和表单，避免再次触发确认；手机端响应档位卡片调整为单列。

授权等待超时现在记录 HTTP 状态、阶段、进程和 token 校验状态及白名单错误码，不输出凭据；原失败日志保留，以便后续对比。

## 交付文档

已同步 `README.md`、`DEVELOPMENT.md`、`docs/cloud-manager.md`、`docs/extensions.md` 和 `docs/testing.md`，覆盖使用入口、八域路由、共享配置、管理员扩展、权限、快照、测试命令及运行边界。各阶段独立记录见 [实施总记录](view-api-execution.md)。

本地验证日志和截图位于忽略目录 `.tools/`：

- `view-api-cloud-test.log`、`view-api-panel-test.log`、`view-api-bili-test.log`。
- `view-api-core-test.log`、`view-api-core-remainder-test.log`、`view-api-core-coverage-test.log`、`view-api-core-headless-test.log`。
- `view-api-cloud-prereadiness-test.log`、`view-api-cloud-preportisolation-test.log`：两次已记录的早期失败。
- `view-api-browser-smoke.mjs`、`view-api-browser/` 截图、`view-api-syntax-check.log`、`view-api-diff-check.log`。

这些是本机证据，不作为生产运行数据提交。

## 实际边界

- 本轮未部署 VPS、未操作真实 QQ/B 站账号、未使用真实模型凭据或支付渠道。已有 VPS 基线以原验收记录为准。
- 本机缺少 SnowLuma/便携 QQ，标准核心安装检查仍未通过；不能声称根 `test:all` 已全绿。
- 自定义 `CLOUD_AGENT_ENTRY` 必须实现新增 IPC 监听回执约定；默认核心入口已支持，详见云端文档。
- 会话、消息、记忆、暂停和完整系统提示词预览需要 Agent 在线。离线可保存白名单、人设、角色卡和扩展，工具运行态诊断标记未知。
- 充值仍需管理员核验与审核，不等于接入自动支付。管理员可信扩展目录也不等于运行沙箱。
- 保留启动前的全部工作区改动。用户随后授权发布到 `Waitforw1nd/fish-agent` fork 的 `main` 分支；发布提交以该远端历史为基线，在独立工作区整理本次增量，原工作区内容保留。
