# NapCat 管理员 P0 / P1 操作与验收

本文面向负责 Linux 部署的管理员。当前代码已经过本地模拟测试，**尚未证明任何固定镜像与本项目兼容**，也没有完成目标 VPS 上的真实容器、扫码或消息验收。下述步骤是待执行的操作与验收要求，不是通过记录。

P0 的目标是选定并核实镜像、在隔离测试环境验证启动及登录接口；P1 的目标是一条测试实例完成真实扫码、模型调用和白名单群回复。测试需要受授权的 QQ、群和可用模型服务。不要将真实二维码、密码、Token、Cookie 或主密钥写入报告。

## 1. 环境与准备

1. 使用独立测试实例和数据目录，记录代码版本、Linux 架构、Node.js 24 版本、Docker 版本、磁盘和内存。确认不会覆盖现有服务。
2. 安装本项目依赖并运行 Cloud 测试；详见 [开发说明](../../DEVELOPMENT.md) 和 [Linux 验收方案](../../docs/linux-vps-acceptance.md)。
3. 确保运行 cloud-manager 的系统用户能访问指定 Docker daemon，且其对实例数据目录具有读写权限。Docker daemon 控制权限具有宿主机级风险，应只授予可信服务账号；不要将 Docker socket 挂入 NapCat 容器。
4. 准备管理员账号、实例 owner 或 operator、真实测试 QQ、允许互动的白名单群以及模型渠道和预算。viewer 可查看状态，不能启动或扫码。

## 2. 镜像选择与固定 digest

候选来源是官方项目的 `mlikiowa/napcat-docker`。管理员应先核实发行版、架构、上游许可、QQ / NapCat 版本和运行环境，再明确选择候选标签。下例中的尖括号是待填写的占位符，不是已经验证的版本或 digest。管理员自行执行拉取；用户扫码请求和预检脚本不会自动拉取镜像，也无需运行远程安装脚本。

```bash
# 管理员确认候选发行版后填写，例如仓库名加明确版本标签。
export NAPCAT_CANDIDATE='<管理员选定的仓库:版本标签>'
docker pull "$NAPCAT_CANDIDATE"
docker image inspect "$NAPCAT_CANDIDATE" --format '{{.Id}} {{json .RepoDigests}}'
```

从 `RepoDigests` 中人工选择与目标仓库对应的 `仓库@sha256:...`，记录完整值、镜像 ID、候选标签、平台架构和核实时间。如果没有可用的仓库 digest，先解决镜像来源与记录问题，不要将镜像 ID 冒充仓库 digest。随后将实际值安全地放入服务进程环境，检查其在本机可查询：

```bash
export CLOUD_NAPCAT_IMAGE='<实际仓库@sha256:完整摘要>'
docker image inspect "$CLOUD_NAPCAT_IMAGE" --format '{{.Id}} {{json .RepoDigests}}'
node deploy/napcat/preflight.mjs
```

以上命令须从仓库根目录执行，`node` 须为 Node 24。预检只检查 digest 格式、Docker 可达和本地镜像存在；成功不代表镜像兼容、容器可启动或 QQ 能登录。服务启动时还会检查镜像 ID 并记录实际容器身份。

实现参考的上游源码为 [Docker 入口](https://github.com/NapNeko/NapCat-Docker/blob/42e4f9e8373c739f4d2ee599980ab8f87cff39b6/entrypoint.sh) 和 [WebUI 登录接口](https://github.com/NapNeko/NapCatQQ/blob/ba0a53dd372dbc4c4bfc83cf7132997459605210/packages/napcat-webui-backend/src/api/QQLogin.ts)。这些源码修订不是镜像兼容证明；需按实际锁定版本核对配置、目录权限、WebUI API 和 OneBot 行为。

## 3. 服务配置

将配置放入 cloud-manager 实际启动环境；项目不会自动加载 `.env`。不要将密码或主密钥写入命令历史。配置名和默认值如下，资源限制必须是指定范围内的整数：

| 环境变量 | 默认值 | 用途 |
|---|---:|---|
| `CLOUD_NAPCAT_IMAGE` | 空 | 管理员验证并预装的 `仓库@sha256:摘要`；为空无法启动 NapCat。 |
| `CLOUD_DOCKER_PATH` | `docker` | Docker CLI 路径。 |
| `CLOUD_DEPLOYMENT_ID` | `fish-cloud` | 运行资源身份标签；每套部署使用稳定且唯一的值，运行中不要随意更改。 |
| `CLOUD_DEFAULT_QQ_DRIVER` | `napcat` | 无已有 QQ 配置时的默认 driver；已有实例保留保存的 driver。 |
| `CLOUD_NAPCAT_MEMORY_MB` | `2048` | 内存上限，256–65536 MiB。 |
| `CLOUD_NAPCAT_CPU_MILLIS` | `2000` | CPU 上限，以千分之一核计，100–64000。 |
| `CLOUD_NAPCAT_PIDS` | `512` | PID 上限，64–8192。 |
| `CLOUD_NAPCAT_SHM_MB` | `512` | 共享内存上限，64–8192 MiB。 |
| `CLOUD_NAPCAT_LOG_MB` | `10` | 单个 Docker 日志文件上限，1–1024 MiB。 |
| `CLOUD_NAPCAT_LOG_FILES` | `3` | Docker 日志文件数上限，1–20。 |
| `CLOUD_PROCESS_START_TIMEOUT_MS` | `20000` | 等待协议端就绪的时限，1000–120000 毫秒；不包含人工扫码等待。 |
| `CLOUD_PORT_RANGE_START` / `CLOUD_PORT_RANGE_END` | `31000` / `39999` | 平台端口池，确认未与其他服务冲突。 |
| `CLOUD_DATA_DIR` | 仓库下 `var/cloud` | 平台数据根目录，包含数据库、租户目录和默认主密钥文件。 |
| `CLOUD_MASTER_KEY` | 空 | 可选的 32 字节主密钥，使用 Base64 或 64 位十六进制；未设置时使用数据目录的 `master.key`。 |

默认资源值是初始配置，不是已测得的 QQ 实际需求。先在 P0 测量冷启动与空闲资源，并确认 Docker 日志驱动支持相应限制。资源规格随运行记录保存；改环境变量只影响新建容器。

管理入口相关配置包括 `CLOUD_HOST`、`CLOUD_PORT`、`CLOUD_BASE_DOMAIN`、`CLOUD_PUBLIC_SCHEME`、`CLOUD_COOKIE_DOMAIN`、`CLOUD_COOKIE_SECURE` 和 `CLOUD_TRUST_PROXY`。根据实际代理和证书配置，不要将内部协议端口当作公网入口。

## 4. 迁移、身份与网络

升级前停止目标 QQ，使用 SQLite 一致性备份或停机快照备份 `CLOUD_DATA_DIR` 中数据库及租户数据，并安全保存原主密钥。不能只复制运行中的 SQLite 主文件。数据库启动时执行增量迁移：版本 5 增加 QQ 运行记录，版本 6 增加镜像 ID 和容器规格。迁移失败时保留原数据并从一致快照恢复。

既有实例保留原 QQ driver 和 LLBot 配置；无 QQ 配置的实例才使用平台默认值。NapCat 数据按实例及 QQ 号分开保存，路径位于租户数据目录的 `qq/napcat/accounts/<QQ号>/`。切换账号前须确认旧容器已停止；不同内核不共享登录态。

容器和网络带部署、实例、driver、运行 ID、generation 标签，管理器还校验镜像 ID、挂载、网络、端口及资源规格。已有容器若缺少可信的镜像 ID 或规格记录，不能自动接管；管理员须核对资源归属并在确认后处理，不能按模糊名称批量删除。正常关闭管理器会尝试停止已记录容器并确认，失败要检查错误及真实资源，不能只看数据库状态。

每个容器使用独立 bridge；容器内部 WebUI、OneBot WS、OneBot HTTP 分别为 6099、3001、3000，宿主机映射绑定 `127.0.0.1` 的租约端口。浏览器通过 fish 同源 API 访问扫码功能，不直接暴露 NapCat WebUI、OneBot 或 Docker 端口。预检和容器正常运行不自动完成网络隔离：**当前没有实现跨实例、宿主机管理端口和私网服务的出口限制**。部署方须设计并验证针对 fish 网络的规则，保留必要 DNS 和 QQ 公网出口，避免影响其他业务网络。

租户 Bot 控制台使用 `<slug>.<CLOUD_BASE_DOMAIN>` 的 Host 路由；仅能访问管理端口不代表控制台可用。正式访问前配置 DNS、HTTPS、Cookie 和代理的 HTTP / WebSocket 转发，并验证实例权限；开发测试可使用受控本地转发。

## 5. P0 / P1 真实验收清单

每项记录代码版本、镜像仓库 digest 和 ID、执行时间、结果（通过 / 失败 / 阻塞 / 未执行）以及脱敏证据：

- [ ] Docker 和预检可用；实际容器使用锁定镜像 ID、预期标签和资源限制，挂载仅为当前账号所需目录，宿主机映射仅回环。
- [ ] 容器 WebUI 实际鉴权并就绪；确认二维码可取、状态字段与固定发行版契约一致。二维码刷新接口当前明确不支持，不应假称刷新成功。
- [ ] 测试用户从 fish 选择 NapCat、输入 QQ 并由本人扫码确认；实际 UIN 与预期一致。错号时确认 Agent 被阻断且容器已停止。
- [ ] 实际 QQ 登录、Agent QQ 通道连接和同一运行 generation 的账号身份均正确，状态显示可对话；仅容器运行或扫码成功不算通过。
- [ ] 配置真实模型及预算、将授权测试群加入白名单；在群内 @ 机器人，确认收到真实回复并有模型调用记录。未授权群不回复，自身消息不形成循环。
- [ ] 分别验证文本、@、引用、表情和图片；记录成功、失败和未测项目。NapCat 小图片使用受限 inline Base64，不能将容器本地路径当成宿主机路径。
- [ ] 正常停止并确认容器退出、网络清理及其他实例不受影响；重启后检查 session 恢复或明确要求重新扫码。仅在隔离测试实例上验证异常退出。
- [ ] 检查 owner / operator / viewer 及跨租户访问、租户控制台 HTTPS 和 DNS 路由；日志与报告不包含秘密或二维码。

当前阶段不提供 P2 的完整可恢复双内核切换事务，也不承诺 P3 的多实例账号占用、异常恢复和完整隔离。运行中的跨 driver 修改会被拒绝；停止后修改配置不等于已实现事务切换和回滚。真实多实例、故障恢复、网络隔离和商业使用许可须单独验收。

升级回滚前先确认并停止相关 fish 容器，保留与旧镜像版本相匹配的 profile、数据库一致快照和原主密钥；QQ profile 可能随版本变化，单独降级镜像不保证可恢复。更多测试范围见 [Linux 验收方案](../../docs/linux-vps-acceptance.md)。
