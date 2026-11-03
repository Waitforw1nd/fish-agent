# Linux / VPS 部署与验收清单

本文提供在 Linux 服务器上部署养鱼 Bot 云端平台并完成上线前验收的标准步骤。

---

## 1. 服务器环境准备

1. **基础软件**：
   - Linux（推荐 Ubuntu 22.04+ / Debian 12+），安装对应架构的 **Node.js 24+** 与 `corepack`（勿直接拷贝 Windows 的 `.tools/node`）。
   - 如使用默认 NapCat 内核，需安装 Docker 并按 [deploy/napcat/README.md](../deploy/napcat/README.md) 拉取固定 `@sha256:...` 镜像、完成 `node deploy/napcat/preflight.mjs` 预检。
2. **账号与测试物料**：
   - 至少 1 个测试 QQ 小号、1 个允许互动的测试群、1 个非白名单对照群。
   - 可用的 OpenAI 兼容模型上游 API Key（用于配置平台公共渠道或用户自定义渠道）。
3. **目录隔离**：使用独立数据目录（如 `/var/lib/fish-cloud`），确保运行用户具备读写权限且不把 Docker Socket 挂载进租户容器。

---

## 2. 安装、构建与自检

在服务器代码根目录执行：

```bash
# 1. 安装各包依赖
npm --prefix packages/qq-agent-core ci
npm --prefix packages/protocol-bili-bridge ci
npm --prefix packages/cloud-manager ci
(cd packages/protocol-qq-llbot && corepack yarn install --immutable)

# 2. 构建 LLBot（如需支持 LLBot 内核）
npm run llbot:build

# 3. 运行服务端自动化检查与测试
npm run check
npm --prefix packages/protocol-bili-bridge test
npm --prefix packages/cloud-manager test
npm --prefix packages/cloud-manager/panel test
npm --prefix packages/qq-agent-core run test:headless
```

---

## 3. 启动服务与反向代理

项目不自动读取 `.env`，建议通过 `systemd`（如使用容器运行管理器本身，需配置 `--init` / `tini` 确保子进程与进程组正常回收）注入环境变量：

```bash
export CLOUD_DATA_DIR="/var/lib/fish-cloud"
export CLOUD_HOST="127.0.0.1"              # 由 Nginx/Caddy 反代对外提供 HTTPS
export CLOUD_PORT="8080"
export CLOUD_RELAY_HOST="127.0.0.1"
export CLOUD_RELAY_PORT="8790"
export CLOUD_PUBLIC_SCHEME="https"
export CLOUD_BASE_DOMAIN="fish.example.com"
export CLOUD_TRUST_PROXY="true"
export CLOUD_ADMIN_USERNAME="admin"
export CLOUD_ADMIN_PASSWORD="<替换为高强度管理员密码>"
export CLOUD_NAPCAT_IMAGE="<已验证的镜像仓库@sha256:完整摘要>"

npm start
```

启动后验证健康检查：

```bash
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8790/health
```

**反向代理注意事项**：
- 仅对外暴露 `CLOUD_PORT`（`8080`）的 HTTPS 入口，**严禁**将 `8790`（Relay）或 `31000–39999`（租户内部端口池）直接暴露到公网。
- 面板所有 QQ Agent 设置均已支持同源 `/api/tenants/:id/agent/*`，单域名或 IP 即可完整使用；若同时启用旧版 `<slug>.<baseDomain>` 独立子域访问，需额外配置泛域名解析与 WebSocket 反代转发。

---

## 4. 核心功能上线验收清单

正式开放给用户前，按顺序勾选确认以下 5 组场景：

### A. 账号与多实例权限
- [ ] 管理员登录后台，创建两个普通测试用户（如 Alice、Bob），在“平台设置”配好公共模型上游（或准备自定义渠道）。
- [ ] Alice 登录后新建实例，确认四步就绪向导正常显示；套餐实例数量上限生效（如 `trial` 上限 1 个）。
- [ ] Bob 登录后看不到 Alice 的实例，直接请求 Alice 实例接口返回 `403`；`viewer` 协作成员仅可查看，不能启停、扫码或改配置。

### B. 真实 QQ 扫码与群聊闭环
- [ ] 在 Alice 实例页输入测试 QQ 号并点击扫码，手机扫码确认后状态变为在线，显示的 QQ 号与昵称正确（用错误 QQ 号扫码应自动拦截并停止协议端）。
- [ ] 在“群聊与白名单”页签在线拉取群列表并勾选测试群，选择“小鲸鱼”人设与 `1 档（仅被 @ 回复）`，启动实例。
- [ ] 在白名单测试群内 `@` 机器人提问，确认收到自然回复且无自身消息死循环；在**非白名单群** `@` 机器人确认零回复。
- [ ] （可选）若同时启用了 LLBot 与 NapCat，验证实例详情页“切换内核”能安全停旧端、扫码切新端并保留人设与白名单。

### C. 模型计费与充值审核
- [ ] 平台渠道对话后，“用量与日志”和“钱包与充值”能看到准确的 Token 消耗与余额扣减；自定义渠道对话不扣减平台钱包余额。
- [ ] 普通用户提交充值申请后处于待审核状态；管理员在“充值审核”确认到账后余额增加（重复确认返回冲突），或驳回后用户可见驳回原因。

### D. 插件分发与安全边界
- [ ] 管理员在单实例“插件与技能”页屏蔽某内置插件（如 `trpg-dice-hook`）或从“插件中心”下发插件，热重载后立即生效且不影响其他租户实例。
- [ ] 保持默认关闭 `QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED`（未完成操作系统级沙箱隔离前，不开放普通用户自上传扩展代码）。

### E. 重启恢复与加密备份
- [ ] 停止并重新启动单个实例，其他运行中实例不受影响；重启 `cloud-manager` 后用户、配置与账单状态完整保留。
- [ ] 创建一次实例快照备份，修改人设后执行恢复，确认配置正常还原；将 `master.key`、`cloud.sqlite`（一致性备份）与 `tenants/` 纳入日常异地备份策略。
