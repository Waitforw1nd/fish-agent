import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { deepMerge, ensureDir, randomToken, readJsonFile, writeJsonPrivate } from './util.js';
import { isolateQqSwitchTasks } from '../../qq-agent-core/src/qq-switch-isolation.js';

export class AgentRuntime {
  constructor({ config, allocator, supervisor, secrets, relayKeys, customUpstreams, logger, db }) {
    this.db = db || supervisor?.db;
    this.config = config;
    this.allocator = allocator;
    this.supervisor = supervisor;
    this.secrets = secrets;
    this.relayKeys = relayKeys;
    this.customUpstreams = customUpstreams;
    this.logger = logger;
    this.linksResolver = null;
    this.healthCache = new Map();
    this.healthEpoch = new Map();
  }

  setLinksResolver(fn) { this.linksResolver = fn; }

  dataDir(tenant) { return path.join(tenant.data_dir, 'data'); }

  configPath(tenant) { return path.join(this.dataDir(tenant), 'config.json'); }

  async ensure(tenant) {
    this.relayKeys.active(tenant.id) || this.relayKeys.issue(tenant.id);
    let relayKey = this.relayKeys.plaintext(tenant.id);
    if (!relayKey) {
      this.relayKeys.issue(tenant.id);
      relayKey = this.relayKeys.plaintext(tenant.id);
    }
    let consoleToken = this.secrets.get(tenant.id, 'agent.console_token', null);
    if (!consoleToken) {
      consoleToken = randomToken(32);
      this.secrets.set(tenant.id, 'agent.console_token', consoleToken);
    }
    let lease = this.allocator.find(tenant.id, 'agent.http');
    if (!lease) {
      lease = await this.allocator.allocate(tenant.id, 'agent.http', { host: '127.0.0.1' });
      this.dbUpdateAgentPort(tenant.id, lease.port);
    } else if (Number(tenant.agent_port) !== lease.port) {
      this.dbUpdateAgentPort(tenant.id, lease.port);
    }
    const config = await this.writeConfig(tenant, { port: lease.port, consoleToken, relayKey });
    return { port: lease.port, consoleToken, relayKey, config };
  }

  dbUpdateAgentPort(tenantId, port) {
    // The caller owns the database handle in the app wiring; AgentRuntime gets a
    // setter callback to avoid threading the whole service graph here.
    this.onAgentPort?.(tenantId, port);
  }

  async writeConfig(tenant, { port, consoleToken, relayKey } = {}) {
    const ensured = port && consoleToken && relayKey ? { port, consoleToken, relayKey } : await this.ensureValues(tenant);
    const existing = readJsonFile(this.configPath(tenant), {});
    const links = this.linksResolver ? await this.linksResolver(tenant) : { qq: null, bili: null };
    const relayBaseUrl = `http://127.0.0.1:${this.config.relayPort}/v1`;
    const custom = this.customUpstreams?.get(tenant.id);
    const base = {
      ...existing,
      api: {
        ...(existing.api || {}),
        baseUrl: relayBaseUrl,
        apiKey: ensured.relayKey,
        model: custom?.configured ? custom.model : (tenant.default_model || existing.api?.model || this.config.defaultModel)
      },
      server: { ...(existing.server || {}), port: ensured.port, token: ensured.consoleToken },
      allow: existing.allow || { groups: [], private: [] },
      allowAllWhenEmpty: false,
      tools: { ...(existing.tools || {}), crossChatSend: false },
      connection: {
        ...(existing.connection || {}),
        enabled: Boolean(links.qq?.enabled),
        type: 'onebot',
        onebot: {
          ...(existing.connection?.onebot || {}),
          mode: 'forward',
          apiTransport: links.qq?.apiTransport || 'http',
          wsUrl: links.qq?.wsUrl || 'ws://127.0.0.1:3001',
          httpUrl: links.qq?.httpUrl || 'http://127.0.0.1:3000',
          accessToken: links.qq?.accessToken || '',
          httpAccessToken: links.qq?.httpAccessToken || links.qq?.accessToken || '',
          selfUserId: links.qq?.uin ? String(links.qq.uin) : ''
        }
      },
      channels: {
        ...(existing.channels || {}),
        qq: links.qq ? {
          ...(existing.channels?.qq || {}),
          enabled: Boolean(links.qq.enabled),
          apiTransport: links.qq.apiTransport || 'http',
          wsUrl: links.qq.wsUrl || '',
          httpUrl: links.qq.httpUrl || '',
          accessToken: links.qq.accessToken || '',
          httpAccessToken: links.qq.httpAccessToken || links.qq.accessToken || '',
          driver: links.qq.driver || '',
          generation: links.qq.generation ?? null,
          media: links.qq.media || null,
          selfUserId: links.qq.uin ? String(links.qq.uin) : ''
        } : { ...(existing.channels?.qq || {}), enabled: false },
        bili: links.bili ? {
          ...(existing.channels?.bili || {}),
          enabled: Boolean(links.bili.enabled),
          wsUrl: links.bili.wsUrl || '',
          httpUrl: links.bili.httpUrl || '',
          accessToken: links.bili.accessToken || '',
          httpAccessToken: links.bili.httpAccessToken || links.bili.accessToken || ''
        } : { ...(existing.channels?.bili || {}), enabled: false }
      }
    };
    // Legacy channel config kept in sync until qq-agent-core's channel router fully owns it.
    base.snowluma = {
      ...(existing.snowluma || {}),
      autoLaunch: false,
      wsUrl: links.qq?.wsUrl || '',
      httpUrl: links.qq?.httpUrl || '',
      accessToken: links.qq?.accessToken || '',
      httpAccessToken: links.qq?.httpAccessToken || links.qq?.accessToken || ''
    };
    ensureDir(this.dataDir(tenant), 0o700);
    writeJsonPrivate(this.configPath(tenant), base, 0o600);
    if (JSON.stringify(existing.channels) !== JSON.stringify(base.channels)) {
      this.healthCache.delete(tenant.id);
      this.healthEpoch.set(tenant.id, (this.healthEpoch.get(tenant.id) || 0) + 1);
    }
    return base;
  }

  async ensureValues(tenant) {
    this.relayKeys.active(tenant.id) || this.relayKeys.issue(tenant.id);
    let relayKey = this.relayKeys.plaintext(tenant.id);
    if (!relayKey) {
      this.relayKeys.issue(tenant.id);
      relayKey = this.relayKeys.plaintext(tenant.id);
    }
    let consoleToken = this.secrets.get(tenant.id, 'agent.console_token', null);
    if (!consoleToken) {
      consoleToken = randomToken(32);
      this.secrets.set(tenant.id, 'agent.console_token', consoleToken);
    }
    let lease = this.allocator.find(tenant.id, 'agent.http');
    if (!lease) lease = await this.allocator.allocate(tenant.id, 'agent.http', { host: '127.0.0.1' });
    return { port: lease.port, consoleToken, relayKey };
  }

  async start(tenant) {
    if (!fs.existsSync(this.config.agentEntry)) {
      throw Object.assign(new Error('QQ agent 入口不存在，请先安装依赖并确认 CLOUD_AGENT_ENTRY'), { status: 503, code: 'AGENT_ENTRY_MISSING' });
    }
    const { port, consoleToken } = await this.ensure(tenant);
    const dataDir = this.dataDir(tenant);
    const pluginsDir = path.join(tenant.data_dir, 'extensions', 'plugins');
    const skillsDir = path.join(tenant.data_dir, 'extensions', 'skills');
    for (const dir of [dataDir, pluginsDir, skillsDir]) ensureDir(dir, 0o700);
    const status = await this.supervisor.start({
      tenantId: tenant.id,
      kind: 'agent',
      command: this.config.nodePath,
      args: [this.config.agentEntry],
      cwd: tenant.data_dir,
      env: {
        QQ_AGENT_DATA_DIR: dataDir,
        QQ_AGENT_HOST: '127.0.0.1',
        QQ_AGENT_PORT: String(port),
        QQ_AGENT_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        QQ_AGENT_TOKEN: consoleToken,
        QQ_AGENT_CLOUD: '1',
        QQ_AGENT_PLUGINS_DIR: pluginsDir,
        QQ_AGENT_SKILLS_DIR: skillsDir,
        QQ_AGENT_TELEMETRY: '0',
        QQ_AGENT_COMMUNITY: '0'
      },
      logFile: path.join(this.config.logDir, 'tenants', `${tenant.id}.agent.log`),
      ready: { host: '127.0.0.1', port, timeoutMs: this.config.processStartTimeoutMs },
      restart: true
    });
    return { ...status, port };
  }

  async stop(tenant, { force = false } = {}) {
    await this.supervisor.stop(tenant.id, 'agent', { force });
    this.assertNoUnconfirmedAgent(tenant);
    this.allocator.release(tenant.id, 'agent.http');
  }

  assertNoUnconfirmedAgent(tenant) {
    const row = this.db.prepare(`SELECT id FROM process_runs WHERE tenant_id = ? AND kind = 'agent'
      AND (status NOT IN ('stopped', 'exited', 'failed', 'crashed') OR stopped_at IS NULL) LIMIT 1`).get(tenant.id);
    if (row || ['stop_unconfirmed', 'stopping'].includes(this.supervisor.status(tenant.id, 'agent').state)) {
      throw Object.assign(new Error('旧 Agent 进程停止状态未确认'), { status: 409, code: 'PROCESS_STOP_UNCONFIRMED' });
    }
  }

  switchSnapshot(tenant) {
    const running = ['running', 'starting', 'restarting'].includes(this.supervisor.status(tenant.id, 'agent').state);
    if (!running) this.assertNoUnconfirmedAgent(tenant);
    return { agentWasRunning: running };
  }

  async switchQuiesce(tenant, operation) {
    const stoppedAt = Number(operation.createdAt || operation.created_at || Date.now());
    await this.supervisor.stop(tenant.id, 'agent');
    this.assertNoUnconfirmedAgent(tenant);
    this.allocator.release(tenant.id, 'agent.http');
    isolateQqSwitchTasks(this.dataDir(tenant), { operationId: operation.id || operation.operationId, stoppedAt });
  }

  async switchResume(tenant, operation, { restore = true } = {}) {
    if (!restore) return;
    if (!tenant || tenant.status !== 'active' || Number(tenant.expires_at) <= Date.now()) return;
    if (!operation.agentWasRunning) {
      this.assertNoUnconfirmedAgent(tenant);
      return;
    }
    this.switchResumes ||= new Map();
    if (this.switchResumes.has(tenant.id)) return this.switchResumes.get(tenant.id);
    if (['running', 'starting', 'restarting'].includes(this.supervisor.status(tenant.id, 'agent').state)) return;
    this.assertNoUnconfirmedAgent(tenant);
    const resume = Promise.resolve().then(() => this.start(tenant));
    this.switchResumes.set(tenant.id, resume);
    try { await resume; }
    finally { this.switchResumes.delete(tenant.id); }
  }

  port(tenant) {
    const lease = this.allocator.find(tenant.id, 'agent.http');
    return lease?.port || null;
  }

  async status(tenant, { probe = true } = {}) {
    const process = this.supervisor.status(tenant.id, 'agent');
    const lease = this.allocator.find(tenant.id, 'agent.http');
    const result = {
      state: process.state,
      pid: process.pid,
      port: lease?.port || null,
      startedAt: process.startedAt || null,
      readyAt: process.readyAt || null,
      restarts: process.restarts || 0,
      lastError: process.lastError || null,
      consoleTokenConfigured: this.secrets.has(tenant.id, 'agent.console_token'),
      health: null
    };
    if (probe && process.state === 'running' && lease) {
      result.health = await this.health(tenant, lease.port);
      if (!result.health.ok && process.lastError === null) result.lastError = result.health.error || null;
    }
    return result;
  }

  async health(tenant, port = null) {
    const actualPort = Number(port || this.port(tenant) || 0);
    if (!actualPort) return { ok: false, error: 'agent port not allocated' };
    const cached = this.healthCache.get(tenant.id);
    if (cached && Date.now() - cached.at < 3000) return cached.value;
    const token = this.secrets.get(tenant.id, 'agent.console_token', '');
    const epoch = this.healthEpoch.get(tenant.id) || 0;
    const value = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: actualPort,
        path: '/api/status',
        method: 'GET',
        headers: { host: `127.0.0.1:${actualPort}`, 'x-console-token': token },
        timeout: 2500
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* ignore */ }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            onebot: parsed?.onebot || null,
            channels: parsed?.onebot?.channels || null,
            error: res.statusCode >= 200 && res.statusCode < 300 ? null : `HTTP ${res.statusCode}`
          });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (error) => resolve({ ok: false, error: String(error?.message || error) }));
      req.end();
    });
    if ((this.healthEpoch.get(tenant.id) || 0) !== epoch) return { ok: false, error: 'agent configuration changed during health check' };
    this.healthCache.set(tenant.id, { at: Date.now(), value });
    return value;
  }

  consoleHeaders(tenant) {
    const token = this.secrets.get(tenant.id, 'agent.console_token', '');
    return { 'x-console-token': token };
  }

  logs(tenant, limit = 100) {
    return this.supervisor.logs(tenant.id, 'agent', limit);
  }

  async restart(tenant) {
    await this.stop(tenant);
    return this.start(tenant);
  }
}
