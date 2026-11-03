# NapCat Docker 部署配置指南

`cloud-manager` 默认使用 **NapCat Docker** 为每个租户实例提供隔离的 QQ OneBot v11 协议容器。部署管理员需在 Linux 宿主机预先拉取并固定镜像 `sha256` 摘要，平台不会在用户点击扫码时自动拉取未知远程镜像。

---

## 1. 拉取镜像并固定 Digest

1. 选择明确版本的官方或受信任镜像（如 `mlikiowa/napcat-docker` 的具体版本标签），手动拉取并查看 `RepoDigests`：

```bash
export NAPCAT_CANDIDATE="mlikiowa/napcat-docker:<替换为具体版本标签>"
docker pull "$NAPCAT_CANDIDATE"
docker image inspect "$NAPCAT_CANDIDATE" --format '{{.Id}} {{json .RepoDigests}}'
```

2. 复制输出中的完整 `仓库@sha256:...` 摘要，在仓库根目录执行预检脚本：

```bash
export CLOUD_NAPCAT_IMAGE="mlikiowa/napcat-docker@sha256:<完整64位摘要>"
node deploy/napcat/preflight.mjs
```

预检通过代表摘要格式合法、Docker 守护进程可达且本地镜像已就绪。

---

## 2. 环境变量说明

在启动 `cloud-manager` 的进程环境中配置以下参数（项目不自动加载 `.env`）：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `CLOUD_NAPCAT_IMAGE` | 空（必填） | 锁定的 `仓库@sha256:摘要`；为空时无法启动 NapCat 实例。 |
| `CLOUD_DEFAULT_QQ_DRIVER` | `napcat` | 新建实例的默认 QQ 驱动（已有配置的实例保留原驱动）。 |
| `CLOUD_DOCKER_PATH` | `docker` | Docker CLI 可执行文件路径。 |
| `CLOUD_DEPLOYMENT_ID` | `fish-cloud` | 容器与网络的资源归属标签前缀，同一宿主机多套环境需区分。 |
| `CLOUD_NAPCAT_MEMORY_MB` | `2048` | 单容器内存上限（`256 ~ 65536` MiB）。 |
| `CLOUD_NAPCAT_CPU_MILLIS` | `2000` | 单容器 CPU 上限（千分之一核，`2000` 即 2 核）。 |
| `CLOUD_NAPCAT_PIDS` | `512` | 单容器最大进程数（`64 ~ 8192`）。 |
| `CLOUD_NAPCAT_SHM_MB` | `512` | 单容器 `/dev/shm` 大小（`64 ~ 8192` MiB）。 |
| `CLOUD_NAPCAT_LOG_MB` / `CLOUD_NAPCAT_LOG_FILES` | `10` / `3` | Docker 单个日志文件大小上限（MiB）与轮转保留份数。 |

---

## 3. 容器网络与数据目录

- **账号数据隔离**：每个租户每个 QQ 号拥有独立挂载目录 `<CLOUD_DATA_DIR>/tenants/<tenant-id>/qq/napcat/accounts/<uin>/`，严禁将宿主机 `docker.sock` 挂载进容器。
- **回环端口映射**：容器内部 WebUI（`6099`）、OneBot WS（`3001`）、OneBot HTTP（`3000`）仅绑定到宿主机 `127.0.0.1` 的租约端口池（默认 `31000–39999`），由 `cloud-manager` 统一通过同源 API 代理二维码获取与刷新（`POST /api/tenants/:id/qq/qrcode/refresh`）。
- **媒体安全**：容器模式下图片与表情发送统一由核心转为受限 `inline-base64`（上限 5 MiB），不依赖宿主机与容器共享任意本地文件路径。
- **宿主机防火墙建议**：Docker 默认网桥未限制容器访问外网或宿主机其他内网服务，生产服务器建议结合防火墙规则仅放行容器所需的 DNS 与 QQ 公网连接，禁止容器访问宿主机管理端口与内网敏感地址。

---

## 4. 部署后快速核对

- [ ] `node deploy/napcat/preflight.mjs` 退出码为 `0`，管理后台“平台设置 → 驱动预检”显示 NapCat 就绪。
- [ ] 普通用户新建实例、输入测试 QQ 号并点击扫码可正常弹出二维码，未登录时点击“获取新二维码”可正常换码。
- [ ] 手机扫码登录后面板显示在线且 `canChat` 就绪，白名单群内 `@` 机器人收发文本与表情/图片正常。
- [ ] 停止实例后对应容器退出，不影响同机其他实例；升级或回滚镜像前先停止对应容器并做好 `CLOUD_DATA_DIR` 一致性备份。

更多整站验收项见 [Linux / VPS 部署与验收清单](../../docs/linux-vps-acceptance.md)。
