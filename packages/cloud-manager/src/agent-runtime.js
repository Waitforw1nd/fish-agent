import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { deepMerge, ensureDir, randomToken, readJsonFile, writeJsonPrivate } from './util.js';

export class AgentRuntime {
  constructor({ config, allocator, supervisor, secrets, relayKeys, logger }) {
    this.config = config;
    this.allocator = allocator;
    this.supervisor = supervisor;
    this.secrets = secrets;
    this.relayKeys = relayKeys;
    this.logger = logger;
    this.linksResolver = null;
    this.healthCache = new Map();
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
    const base = {
      ...existing,
      api: {
        ...(existing.api || {}),
        baseUrl: relayBaseUrl,
        apiKey: ensured.relayKey,
        model: tenant.default_model || existing.api?.model || this.config.defaultModel
      },
      server: { ...(existing.server || {}), port: ensured.port, token: ensured.consoleToken },
      allow: existing.allow || { groups: [], private: [] },
      allowAllWhenEmpty: false,
      tools: { ...(existing.tools || {}), crossChatSend: false },
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
          ...(links.qq.uin ? { selfUserId: String(links.qq.uin) } : {})
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
    this.allocator.release(tenant.id, 'agent.http');
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
            error: res.statusCode >= 200 && res.statusCode < 300 ? null : `HTTP ${res.statusCode}`
          });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (error) => resolve({ ok: false, error: String(error?.message || error) }));
      req.end();
    });
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
