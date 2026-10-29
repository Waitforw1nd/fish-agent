import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ensureDir } from '../util.js';
import path from 'node:path';

const execute = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { status: 503, code });

export class DockerRuntime {
  constructor({ db, config }) { this.db = db; this.config = config; }
  row(tenantId) { return this.db.prepare('SELECT * FROM qq_runtimes WHERE tenant_id = ?').get(tenantId) || null; }
  async command(args, timeout = 15000) {
    try {
      const result = await execute(this.config.dockerPath, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true });
      return (args[0] === 'logs' ? `${result.stdout}${result.stderr}` : result.stdout).trim();
    }
    catch (error) {
      if (args[0] === 'start' && /port is already allocated|address already in use|bind.*failed/i.test(String(error.stderr || ''))) throw fail('NAPCAT_PORT_CONFLICT', 'NapCat 端口绑定冲突');
      if (args[0] === 'network' && args[1] === 'inspect' && /no such network/i.test(String(error.stderr || ''))) throw fail('DOCKER_NETWORK_NOT_FOUND', 'Docker 网络不存在');
      throw fail('DOCKER_COMMAND_FAILED', `Docker 操作失败: ${error.code || 'error'}`);
    }
  }
  async preflight() {
    const image = this.config.napcatImage;
    if (!/^[-\w./:]+@sha256:[a-f0-9]{64}$/.test(image || '')) throw fail('NAPCAT_IMAGE_NOT_CONFIGURED', '管理员须配置固定 digest 的 NapCat 镜像');
    await this.command(['info', '--format', '{{.ID}}']);
    let imageId;
    try { imageId = await this.command(['image', 'inspect', image, '--format', '{{.Id}}']); }
    catch { throw fail('NAPCAT_IMAGE_NOT_INSTALLED', 'NapCat 镜像未预先安装'); }
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw fail('NAPCAT_IMAGE_INVALID', 'NapCat 镜像身份无效');
    return { image, imageId };
  }
  labels(row) {
    return { 'fish.deployment': this.config.deploymentId, 'fish.tenant': row.tenant_id, 'fish.driver': 'napcat', 'fish.runtime': row.runtime_id, 'fish.generation': String(row.generation) };
  }
  async inspect(row) {
    if (!row?.container_id) return null;
    let data;
    try { data = JSON.parse(await this.command(['inspect', row.container_id])); }
    catch (error) { throw fail('NAPCAT_INSPECT_FAILED', '无法确认 NapCat 容器状态'); }
    const container = data[0];
    let spec;
    try { spec = JSON.parse(row.spec_json); } catch { throw fail('NAPCAT_IDENTITY_MISMATCH', '缺少受信任的容器规格'); }
    const mounts = container?.Mounts || [];
    const mountsMatch = mounts.length === 2 && [['qq', '/app/.config/QQ'], ['config', '/app/napcat/config']].every(([local, target]) => mounts.some((mount) => mount.Type === 'bind' && mount.RW === true && mount.Destination === target && path.resolve(mount.Source) === path.resolve(spec.dir, local)));
    const host = container?.HostConfig || {};
    const networks = Object.entries(container?.NetworkSettings?.Networks || {});
    let networkMatch = networks.length === 1 && networks[0][1]?.NetworkID === row.network_id && host.NetworkMode === row.network_id;
    if (!networkMatch && networks.length === 1 && networks[0][1]?.NetworkID === ''
      && container?.State?.Running === false && ['created', 'exited', 'dead'].includes(container.State.Status)
      && host.NetworkMode === row.network_id) {
      const [network] = JSON.parse(await this.command(['network', 'inspect', row.network_id]));
      networkMatch = network?.Id === row.network_id && network.Name === networks[0][0] && network.Driver === 'bridge'
        && Object.entries(this.labels(row)).every(([key, value]) => network.Labels?.[key] === value);
    }
    const ports = host.PortBindings || {};
    const portMatch = Object.keys(ports).length === 3 && Object.entries(spec.ports).every(([internal, external]) => ports[`${internal}/tcp`]?.length === 1 && ports[`${internal}/tcp`][0].HostIp === '127.0.0.1' && Number(ports[`${internal}/tcp`][0].HostPort) === external);
    const limits = host.Memory === spec.memoryMb * 1048576 && host.NanoCpus === spec.cpuMillis * 1000000 && host.PidsLimit === spec.pids && host.ShmSize === spec.shmMb * 1048576 && host.LogConfig?.Config?.['max-size'] === `${spec.logMb}m` && host.LogConfig?.Config?.['max-file'] === String(spec.logFiles);
    const isolation = host.Privileged === false && !['host', 'container'].some(mode => String(host.PidMode || '').startsWith(mode)) && !['host', 'container', 'none'].some(mode => String(host.NetworkMode || '').startsWith(mode)) && !host.PublishAllPorts && !host.Binds?.length && !host.Devices?.length && !host.CapAdd?.length && !host.VolumesFrom?.length && host.RestartPolicy?.Name === 'no';
    if (!container || !Object.entries(this.labels(row)).every(([key, value]) => container.Config?.Labels?.[key] === value) || container.Config?.Image !== row.image || !row.image_id || container.Image !== row.image_id || !mountsMatch || !networkMatch || !portMatch || !limits || !isolation) {
      throw fail('NAPCAT_IDENTITY_MISMATCH', 'NapCat 容器身份不匹配，已阻止操作');
    }
    return container;
  }
  save(row) {
    this.db.prepare(`INSERT INTO qq_runtimes (tenant_id,runtime_id,driver,generation,container_id,network_id,image,desired_state,state,updated_at,image_id,spec_json)
      VALUES (@tenant_id,@runtime_id,@driver,@generation,@container_id,@network_id,@image,@desired_state,@state,@updated_at,@image_id,@spec_json)
      ON CONFLICT(tenant_id) DO UPDATE SET runtime_id=excluded.runtime_id,driver=excluded.driver,generation=excluded.generation,container_id=excluded.container_id,network_id=excluded.network_id,image=excluded.image,desired_state=excluded.desired_state,state=excluded.state,updated_at=excluded.updated_at,image_id=excluded.image_id,spec_json=excluded.spec_json`).run({ image_id: null, spec_json: null, ...row });
  }
  assertResourceIdentity(row) {
    if (!row || row.driver !== 'napcat') return;
    if ((row.state === 'stopped' && row.desired_state !== 'stopped' && !row.container_id) ||
        (!row.container_id && !['allocated', 'network_ready', 'container_removed', 'stopped'].includes(row.state)) ||
        (!row.network_id && !['allocated', 'stopped'].includes(row.state))) {
      throw fail('NAPCAT_RESOURCE_UNCONFIRMED', 'Docker 创建意图缺少资源身份，需人工核对后恢复');
    }
  }
  async start(tenant, account, dir, { runtimeId = null, generation = null } = {}) {
    const old = this.row(tenant.id);
    this.assertResourceIdentity(old);
    const { image, imageId } = await this.preflight();
    if (old?.container_id) {
      const existing = await this.inspect(old);
      if (existing.State?.Running && old.desired_state === 'running') {
        if (runtimeId && runtimeId !== old.runtime_id) throw fail('QQ_RUNTIME_UNCONFIRMED', '旧 QQ 容器仍在运行');
        return old;
      }
    }
    if (old?.container_id || old?.network_id) await this.stop(tenant.id);
    const spec = { dir, ports: { 6099: account.webui_port, 3001: account.ob11_port, 3000: account.http_port }, memoryMb: this.config.napcatMemoryMb, cpuMillis: this.config.napcatCpuMillis, pids: this.config.napcatPids, shmMb: this.config.napcatShmMb, logMb: this.config.napcatLogMb, logFiles: this.config.napcatLogFiles };
    const row = { tenant_id: tenant.id, runtime_id: runtimeId || randomUUID(), driver: 'napcat', generation: generation ?? (old?.generation || 0) + 1, container_id: null, network_id: null, image, image_id: imageId, spec_json: JSON.stringify(spec), desired_state: 'running', state: 'allocated', updated_at: Date.now() };
    this.save(row);
    const labels = Object.entries(this.labels(row)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const network = `fish-${row.runtime_id}`;
    try {
      row.state = 'network_create_intent'; this.save(row);
      row.network_id = await this.command(['network', 'create', '--driver', 'bridge', ...labels, network]);
      row.state = 'network_ready'; this.save(row);
      for (const sub of ['qq', 'config']) ensureDir(path.join(dir, sub), 0o700);
      row.state = 'container_create_intent'; this.save(row);
      row.container_id = await this.command(['create', '--pull=never', '--restart=no', ...labels, '--network', row.network_id,
        '--memory', `${spec.memoryMb}m`, '--cpus', String(spec.cpuMillis / 1000), '--pids-limit', String(spec.pids), '--shm-size', `${spec.shmMb}m`, '--log-opt', `max-size=${spec.logMb}m`, '--log-opt', `max-file=${spec.logFiles}`,
        '-p', `127.0.0.1:${account.webui_port}:6099`, '-p', `127.0.0.1:${account.ob11_port}:3001`, '-p', `127.0.0.1:${account.http_port}:3000`,
        '--mount', `type=bind,src=${path.join(dir, 'qq')},dst=/app/.config/QQ`, '--mount', `type=bind,src=${path.join(dir, 'config')},dst=/app/napcat/config`,
        '-e', `ACCOUNT=${account.expected_uin}`, image]);
      this.save(row);
      await this.inspect(row);
      await this.command(['start', row.container_id]);
      return row;
    } catch (error) {
      row.desired_state = 'stopped'; row.updated_at = Date.now(); this.save(row);
      try { await this.stop(tenant.id); }
      catch { throw fail('NAPCAT_CLEANUP_UNCONFIRMED', 'NapCat 清理未确认，禁止重试'); }
      throw error;
    }
  }
  async stop(tenantId) {
    const row = this.row(tenantId);
    if (!row) return;
    this.assertResourceIdentity(row);
    row.desired_state = 'stopped'; row.updated_at = Date.now(); this.save(row);
    if (row.container_id) {
      let container = await this.inspect(row);
      if (container.State?.Running) {
        try { await this.command(['stop', '-t', '6', row.container_id], 12000); }
        catch { await this.command(['kill', row.container_id], 10000); }
        container = await this.inspect(row);
        if (container.State?.Running) throw fail('NAPCAT_STOP_UNCONFIRMED', '无法确认 NapCat 已停止');
      }
      await this.command(['rm', row.container_id]);
      row.container_id = null; row.state = 'container_removed'; this.save(row);
    }
    if (row.network_id) {
      let networks;
      try { networks = JSON.parse(await this.command(['network', 'inspect', row.network_id])); }
      catch (error) { if (error.code !== 'DOCKER_NETWORK_NOT_FOUND') throw error; }
      if (networks) {
        if (!Object.entries(this.labels(row)).every(([key, value]) => networks[0]?.Labels?.[key] === value)) throw fail('NAPCAT_IDENTITY_MISMATCH', 'NapCat 网络身份不匹配');
        await this.command(['network', 'rm', row.network_id]);
      }
      row.network_id = null;
    }
    row.state = 'stopped'; row.updated_at = Date.now(); this.save(row);
  }
}
