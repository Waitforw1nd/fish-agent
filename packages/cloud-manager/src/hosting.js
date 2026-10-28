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
    this.gateway.closeTenant(tenant.id);
    await this.agent.stop(tenant, { force: true });
    await this.qq.stop(tenant, { releasePorts: true });
    await this.bili.stop(tenant, { releasePorts: true });
    this.logger?.info?.('tenant stopped', { tenantId: tenant.id, reason });
    return this.status(tenant);
  }

  async restart(tenant) {
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

  reconcile() {
    const ts = Date.now();
    this.db.prepare(`
      UPDATE process_runs SET status = 'interrupted', stopped_at = ?
      WHERE status IN ('starting', 'running', 'restarting')
    `).run(ts);
    this.db.prepare(`
      UPDATE qq_accounts SET state = 'prepared'
      WHERE state IN ('online', 'awaiting_login', 'auth_required', 'starting')
    `).run();
    for (const row of this.db.prepare('SELECT id, agent_port FROM tenants').all()) {
      const lease = this.agent.allocator.find(row.id, 'agent.http');
      if (lease && Number(row.agent_port) !== lease.port) {
        this.db.prepare('UPDATE tenants SET agent_port = ?, updated_at = ? WHERE id = ?').run(lease.port, ts, row.id);
      }
    }
    this.logger?.info?.('startup reconcile complete');
  }

  logs(tenant, kind, limit = 100) {
    if (kind === 'qq') return this.qq.logs(tenant, limit);
    if (kind === 'bili') return this.bili.logs(tenant, limit);
    if (kind === 'agent') return this.agent.logs(tenant, limit);
    return [
      ...this.agent.logs(tenant, limit),
      ...this.qq.logs(tenant, limit),
      ...this.bili.logs(tenant, limit)
    ].slice(-limit);
  }

  async shutdown() {
    this.gateway?.closeAll();
    await this.supervisor.shutdown();
  }
}
