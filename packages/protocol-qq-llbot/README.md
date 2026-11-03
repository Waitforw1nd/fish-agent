# LLBot QQ 协议端（`packages/protocol-qq-llbot`）

基于 [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) 的 QQ 协议服务（支持 OneBot 11、Satori、Milky 接口及 Direct / Desktop 登录模式），在本项目中作为可选的 QQ 协议内核由 `cloud-manager` 编排或单独启动。

## 安装与构建

本包要求 **Node.js >= 24** 并使用 **Yarn 4.18.0**（通过 Corepack 调用）：

```bash
cd packages/protocol-qq-llbot
corepack yarn install --immutable   # 同时会通过 postinstall 安装 src/webui/FE 前端依赖
npm run build                       # 构建生成 dist/llbot.js 与运行资源
```

也可直接在仓库根目录执行快捷脚本：

```bash
npm run llbot:check    # TypeScript 类型检查
npm run llbot:test     # 运行 Vitest 单元与 WebUI 测试
npm run llbot:build    # 构建 dist/llbot.js
```

## 常用开发命令

在 `packages/protocol-qq-llbot` 目录内：

| 命令 | 说明 |
|---|---|
| `npm run dev` | 使用 `tsx watch` 热监听启动后端 |
| `npm run build` | Vite 打包输出 `dist/llbot.js`（`cloud-manager` 启动 LLBot 前必须先构建） |
| `npm run check` / `npm run check:webui` | 后端 / WebUI 前端 TypeScript 类型检查 |
| `npm test`（或 `test:unit` / `test:webui`） | 运行 Vitest 自动化测试 |
| `npm run dev-webui` / `npm run build-webui` | WebUI 前端开发调试 / 构建 |

## 独立启动与命令行参数

建议在独立工作目录运行，避免在源码包内生成账号数据：

```bash
mkdir -p ../../var/llbot-dev && cd ../../var/llbot-dev
node ../../packages/protocol-qq-llbot/dist/llbot.js -q 10001
```

常用启动参数（源码见 `src/common/utils/environment.ts`）：

| 参数 / 环境变量 | 说明 |
|---|---|
| `-q <uin>` / `--qq <uin>` | 指定预期登录的 5～12 位 QQ 号，按账号隔离 `config_<uin>.json` 与会话文件 |
| `--pmhq-port <port>`（可选 `--pmhq-host`） | 切换到 Desktop / PMHQ 模式连接外部桌面 QQ（不传则为无头 Direct 模式） |
| `--cdn cf\|china`（或环境变量 `CDN`） | 切换 Direct 签名授权接入点（默认 `cf`，国内服务器可选 `china`） |
| `-p` / `--protocol linux\|windows\|macos\|watch`（或 `PROTOCOL`） | 指定客户端协议配置档（默认 `linux`） |

- Direct 模式在获取二维码前需在运行目录 `data/auth_token.txt`（或通过 WebUI 接口）配置有效 `auth_token`；云端接入细节见根目录 [docs/protocols.md](../../docs/protocols.md)。

## 上游文档与许可证

- 上游文档：<https://luckylillia.com>
- 开源许可证：**GPL-2.0**（见包内 `LICENSE` 及仓库根目录 [UPSTREAM.md](../../UPSTREAM.md)）。
