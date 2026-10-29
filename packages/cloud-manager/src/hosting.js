import fs from 'node:fs';
import { readJsonFile } from './util.js';

export class HostingService {
  constructor({ config, tenants, agent, qq, bili, gateway, supervisor, logger, db }) {
    this.config = config;
    this.tenants = tenants;
    this.agent = agent;
    this.qq = qq;
    this.bili = bili;
    this.gateway = gateway;
    this.supervisor = supervisor;
    this.logger = logger;
    this.db = db;
    this.starting = new Set();
  }

  async describeChannels(tenant) {
    return {
      qq: await this.qq.describeChannels(tenant),
      bili: await this.bili.describeChannels(tenant)
    };
  }

  async handleLinksChanged(tenant, { reason } = {}) {
    if (this.qq.hasActiveSwitch?.(tenant.id)) return;
    const cfgPath = this.agent.configPath(tenant);
    const before = readJsonFile(cfgPath, {});
    await this.agent.writeConfig(tenant);
    const after = readJsonFile(cfgPath, {});
    const channelsChanged = JSON.stringify(before.channels || {}) !== JSON.stringify(after.channels || {})
      || JSON.stringify(before.snowluma || {}) !== JSON.stringify(after.snowluma || {});
    const process = this.supervisor.status(tenant.id, 'agent');
    if (channelsChanged && process.state === 'running' && !this.starting.has(tenant.id)) {
      this.logger?.info?.('restarting agent for channel change', { tenantId: tenant.id, reason });
      try {
        await this.agent.restart(tenant);
      } catch (error) {
        this.logger?.error?.('agent restart after channel change failed', error);
      }
    }
  }

  async start(tenant) {
    this.tenants.assertActive(tenant);
    this.assertNoSwitch(tenant);
    if (this.starting.has(tenant.id)) {
      throw Object.assign(new Error('租户正在启动中'), { status: 409, code: 'TENANT_STARTING' });
    }
    this.starting.add(tenant.id);
    const warnings = [];
    try {
      const account = this.qq.account(tenant.id);
      if (account) {
        try {
          await this.qq.start(tenant);
        } catch (error) {
          throw Object.assign(new Error(`QQ 协议端启动失败: ${error.message}`), {
            status: error.status || 502,
            code: error.code || 'QQ_START_FAILED'
          });
        }
      }
      let biliRow = null;
      try { biliRow = this.bili.row(tenant.id); } catch { /* ignore */ }
      if (biliRow && this.bili.getConfig(tenant).enabled) {
        try {
          await this.bili.start(tenant);
        } catch (error) {
          warnings.push(`B站桥接启动失败: ${error.message}`);
          this.logger?.warn?.('bili start failed during tenant start', { tenantId: tenant.id, error: error.message });
        }
      }
      await this.agent.start(tenant);
      return { ...(await this.status(tenant)), warnings };
    } finally {
      this.starting.delete(tenant.id);
    }
  }

  async stop(tenant, { reason = 'user' } = {}) {
    if (this.qq.hasActiveSwitch?.(tenant.id)) {
      const operation = this.db.prepare("SELECT id FROM qq_operations WHERE tenant_id = ? AND status IN ('running', 'needs_attention') ORDER BY created_at DESC LIMIT 1").get(tenant.id);
      if (!operation) throw Object.assign(new Error('无法确认正在进行的 QQ 切换'), { code: 'QQ_SWITCH_UNCONFIRMED' });
      this.gateway.closeTenant(tenant.id);
      try { await this.qq.cancelSwitch(tenant, operation.id, { restore: false }); }
      catch (error) {
        try { await this.agent.stop(tenant, { force: true }); }
        catch (stopError) { throw new AggregateError([error, stopError], 'QQ 切换取消与 Agent 停止均失败'); }
        throw error;
      }
      if (this.qq.hasActiveSwitch(tenant.id)) {
        await this.agent.stop(tenant, { force: true });
        throw Object.assign(new Error('QQ 切换资源尚未安全停止'), { code: 'QQ_SWITCH_UNCONFIRMED' });
      }
    }
    this.gateway.closeTenant(tenant.id);
    await this.agent.stop(tenant, { force: true });
    await this.qq.stop(tenant, { releasePorts: true });
    await this.bili.stop(tenant, { releasePorts: true });
    this.logger?.info?.('tenant stopped', { tenantId: tenant.id, reason });
    return this.status(tenant);
  }

  assertNoSwitch(tenant) {
    if (this.qq.hasActiveSwitch?.(tenant.id)) throw Object.assign(new Error('QQ 内核切换进行中'), { status: 409, code: 'QQ_SWITCH_ACTIVE' });
  }

  async restart(tenant) {
    this.assertNoSwitch(tenant);
    await this.stop(tenant, { reason: 'restart' });
    return this.start(tenant);
  }

  async status(tenant, { probe = true } = {}) {
    const [agent, qq, bili] = await Promise.all([
      this.agent.status(tenant, { probe }),
      this.qq.status(tenant, { probe }),
      this.bili.status(tenant)
    ]);
    return {
      tenantId: tenant.id,
      running: agent.state === 'running',
      agent,
      qq,
      bili,
      gateway: {
        publicUrl: this.tenants.publicUrl(tenant)
      }
    };
  }

  async onExpired(tenantId) {
    const tenant = this.tenants.row(tenantId);
    if (!tenant) return;
    try {
      await this.stop(tenant, { reason: 'expired' });
    } catch (error) {
      this.logger?.error?.('failed to stop expired tenant', { tenantId, error: error.message });
    }
  }

  async reconcile() {
    await this.qq.recoverSwitches?.();
    const ts = Date.now();
    for (const runtime of this.db.prepare("SELECT * FROM qq_runtimes WHERE driver = 'napcat' AND (container_id IS NOT NULL OR network_id IS NOT NULL)").all()) {
      if (this.qq.hasActiveSwitch?.(runtime.tenant_id)) continue;
      const tenant = this.tenants.row(runtime.tenant_id);
      try {
        if (!tenant || tenant.status !== 'active' || tenant.expires_at <= ts || runtime.desired_state !== 'running') await this.qq.docker.stop(runtime.tenant_id);
        else if (runtime.container_id) await this.qq.docker.inspect(runtime);
        else await this.qq.docker.stop(runtime.tenant_id);
      } catch (error) { this.logger?.error?.('NapCat reconcile failed', { tenantId: runtime.tenant_id, error: error.message }); }
    }
    this.db.prepare(`
      UPDATE qq_accounts SET state = 'prepared'
      WHERE state IN ('online', 'awaiting_login', 'auth_required', 'starting')
        AND tenant_id NOT IN (SELECT tenant_id FROM qq_operations WHERE status IN ('running', 'needs_attention'))
    `).run();
    for (const row of this.db.prepare('SELECT id, agent_port FROM tenants').all()) {
      const lease = this.agent.allocator.find(row.id, 'agent.http');
      if (lease && Number(row.agent_port) !== lease.port) {
        this.db.prepare('UPDATE tenants SET agent_port = ?, updated_at = ? WHERE id = ?').run(lease.port, ts, row.id);
      }
    }
    this.logger?.info?.('startup reconcile complete');
  }

  async logs(tenant, kind, limit = 100) {
    if (kind === 'qq') return this.qq.logs(tenant, limit);
    if (kind === 'bili') return this.bili.logs(tenant, limit);
    if (kind === 'agent') return this.agent.logs(tenant, limit);
    return [
      ...this.agent.logs(tenant, limit),
      ...await this.qq.logs(tenant, limit),
      ...this.bili.logs(tenant, limit)
    ].slice(-limit);
  }

  async shutdown() {
    this.gateway?.closeAll();
    const failures = [];
    const operations = this.db.prepare("SELECT id, tenant_id FROM qq_operations WHERE status IN ('running', 'needs_attention')").all();
    for (const operation of operations) {
      const tenant = this.tenants.row(operation.tenant_id);
      try {
        if (!tenant) throw new Error('切换租户不存在');
        await this.qq.cancelSwitch(tenant, operation.id, { restore: false });
        if (this.qq.hasActiveSwitch(tenant.id)) throw new Error('切换资源停止状态未确认');
      } catch (error) { failures.push(error); }
    }
    try { await this.supervisor.shutdown(); } catch (error) { failures.push(error); }
    const rows = this.db.prepare("SELECT tenant_id FROM qq_runtimes WHERE driver = 'napcat' AND (container_id IS NOT NULL OR network_id IS NOT NULL)").all();
    for (const row of rows) {
      if (this.qq.hasActiveSwitch?.(row.tenant_id)) continue;
      try { await this.qq.serial(row.tenant_id, () => this.qq.docker.stop(row.tenant_id)); }
      catch (error) { failures.push(error); this.logger?.error?.('NapCat shutdown failed', { tenantId: row.tenant_id, error: error.message }); }
    }
    if (failures.length) throw new AggregateError(failures, '部分运行资源停止失败');
  }
}
