import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openDatabase } from './db.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { KeyVault, TenantSecrets } from './crypto.js';
import { SettingsStore } from './settings.js';
import { AuditLog } from './audit.js';
import { AuthService } from './auth.js';
import { UsersService } from './users.js';
import { PortAllocator } from './ports.js';
import { Supervisor } from './supervisor.js';
import { BillingService } from './billing.js';
import { RelayKeyService } from './relay-keys.js';
import { TenantService } from './tenants.js';
import { AgentRuntime } from './agent-runtime.js';
import { AgentSettingsService } from './agent-settings.js';
import { ExtensionService } from './extension-service.js';
import { QQService } from './qq-service.js';
import { BiliService } from './bili-service.js';
import { Gateway, classifyHost } from './gateway.js';
import { HostingService } from './hosting.js';
import { RelayService } from './relay/server.js';
import { CustomUpstreamService } from './relay/custom-upstreams.js';
import { BackupService } from './backup.js';
import { createApiRouter } from './api.js';
import {
  applySecurityHeaders, createRouter, errorPayload, parseUrl, readJson, requestIp, sendHtml, sendJson, sendText
} from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

export class CloudManager {
  constructor(options = {}) {
    this.config = options.config || loadConfig(options.env || process.env, options.overrides || {});
    this.logger = createLogger({
      level: this.config.logLevel,
      file: path.join(this.config.logDir, 'cloud-manager.log'),
      maxBytes: this.config.logMaxBytes
    }).child('manager');
    this.db = openDatabase(this.config.dbPath);
    this.vault = new KeyVault(this.db, this.config.masterKey);
    this.secrets = new TenantSecrets(this.db, this.vault);
    this.settings = new SettingsStore(this.db, this.config.masterKey);
    this.audit = new AuditLog(this.db);
    this.auth = new AuthService({ db: this.db, config: this.config, logger: this.logger });
    this.users = new UsersService(this.db);
    this.allocator = new PortAllocator({ db: this.db, config: this.config, logger: this.logger });
    this.supervisor = new Supervisor({ db: this.db, config: this.config, logger: this.logger });
    this.billing = new BillingService({ db: this.db, logger: this.logger });
    this.relayKeys = new RelayKeyService({ db: this.db, secrets: this.secrets, config: this.config, logger: this.logger });
    this.tenants = new TenantService({
      db: this.db, config: this.config, billing: this.billing,
      relayKeys: this.relayKeys, audit: this.audit, logger: this.logger
    });
    this.customUpstreams = new CustomUpstreamService({ db: this.db, secrets: this.secrets, config: this.config });
    this.agent = new AgentRuntime({
      config: this.config, allocator: this.allocator, supervisor: this.supervisor, db: this.db,
      secrets: this.secrets, relayKeys: this.relayKeys, customUpstreams: this.customUpstreams, logger: this.logger
    });
    this.agent.onAgentPort = (tenantId, port) => this.tenants.setAgentPort(tenantId, port);
    this.qq = new QQService({
      db: this.db, config: this.config, allocator: this.allocator, supervisor: this.supervisor,
      secrets: this.secrets, settings: this.settings, logger: this.logger, audit: this.audit
    });
    this.qq.agentRuntime = this.agent;
    this.bili = new BiliService({
      db: this.db, config: this.config, allocator: this.allocator, supervisor: this.supervisor,
      secrets: this.secrets, logger: this.logger
    });
    this.gateway = new Gateway({
      config: this.config, tenants: this.tenants, auth: this.auth,
      agentRuntime: this.agent, logger: this.logger
    });
    this.hosting = new HostingService({
      config: this.config, tenants: this.tenants, agent: this.agent, qq: this.qq, bili: this.bili,
      gateway: this.gateway, supervisor: this.supervisor, logger: this.logger, db: this.db
    });
    this.qq.switchLifecycle = {
      snapshot: (tenant) => this.agent.switchSnapshot(tenant),
      quiesce: (tenant, operation) => this.agent.switchQuiesce(tenant, operation),
      resume: (tenant, operation, options) => this.agent.switchResume(this.tenants.row(tenant.id), operation, options)
    };
    this.agent.setLinksResolver((tenant) => this.hosting.describeChannels(tenant));
    this.qq.onLinksChanged = (tenant, info) => this.hosting.handleLinksChanged(tenant, info);
    this.bili.onLinksChanged = (tenant, info) => this.hosting.handleLinksChanged(tenant, info);
    this.tenants.onExpired = (tenantId) => this.hosting.onExpired(tenantId);
    this.relay = new RelayService({
      config: this.config, db: this.db, billing: this.billing, relayKeys: this.relayKeys,
      tenants: this.tenants, settings: this.settings, customUpstreams: this.customUpstreams, logger: this.logger
    });
    this.backup = new BackupService({
      config: this.config, db: this.db, tenants: this.tenants, hosting: this.hosting,
      secrets: this.secrets, vault: this.vault, qq: this.qq, bili: this.bili, agent: this.agent, logger: this.logger
    });
    const extensionDeps = {
      config: this.config, agent: this.agent, agentRuntime: this.agent, supervisor: this.supervisor,
      tenants: this.tenants, db: this.db, secrets: this.secrets, audit: this.audit, logger: this.logger
    };
    this.extensionService = new ExtensionService(extensionDeps);
    this.agentSettings = new AgentSettingsService({ ...extensionDeps, extensionService: this.extensionService });
    this.extensionService.agentSettings = this.agentSettings;
    this.backup.extensionService = this.extensionService;
    this.gateway.agentSettings = this.agentSettings;
    this.router = createApiRouter({
      config: this.config, auth: this.auth, tenants: this.tenants, hosting: this.hosting,
      qq: this.qq, bili: this.bili, relay: this.relay, relayKeys: this.relayKeys,
      billing: this.billing, backup: this.backup, settings: this.settings, audit: this.audit,
      users: this.users, agent: this.agent, customUpstreams: this.customUpstreams,
      logger: this.logger, db: this.db, supervisor: this.supervisor,
      agentSettings: this.agentSettings, extensionService: this.extensionService
    });
    this.server = null;
    this.relayServer = null;
    this.timers = [];
    this.bootstrap = null;
  }

  async start() {
    this.bootstrap = this.auth.bootstrap();
    this.relayServer = this.relay.createServer();
    await new Promise((resolve, reject) => {
      this.relayServer.once('error', reject);
      this.relayServer.listen(this.config.relayPort, this.config.relayHost, () => {
        this.relayServer.off('error', reject);
        this.config.relayPort = this.relayServer.address().port;
        resolve();
      });
    });
    await this.hosting.reconcile();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      try {
        const info = classifyHost(req.headers.host, this.config.baseDomain);
        if (info.type === 'tenant') this.gateway.upgrade(req, socket, head);
        else {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
        }
      } catch {
        try { socket.destroy(); } catch { /* ignore */ }
      }
    });
    this.server.timeout = 0;
    this.server.headersTimeout = 60_000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.panelPort, this.config.panelHost, () => {
        this.server.off('error', reject);
        this.config.panelPort = this.server.address().port;
        resolve();
      });
    });
    this.startTimers();
    this.logger.info(`cloud manager listening on ${this.config.panelHost}:${this.config.panelPort}; relay on ${this.config.relayHost}:${this.config.relayPort}`);
    return {
      port: this.config.panelPort,
      relayPort: this.config.relayPort,
      bootstrap: this.bootstrap
    };
  }

  startTimers() {
    const expiry = setInterval(() => {
      try { this.tenants.sweepExpired(); } catch (error) { this.logger.error('expiry sweep failed', error); }
      try { this.billing.expireHolds(); } catch (error) { this.logger.error('hold expiry failed', error); }
    }, this.config.expirySweepMs);
    expiry.unref?.();
    const sessions = setInterval(() => {
      try { this.auth.sweepSessions(); } catch (error) { this.logger.error('session sweep failed', error); }
    }, this.config.sessionSweepMs);
    sessions.unref?.();
    this.timers.push(expiry, sessions);
  }

  async handleRequest(req, res) {
    try {
      applySecurityHeaders(res);
      const hostInfo = classifyHost(req.headers.host, this.config.baseDomain);
      if (hostInfo.type === 'tenant') {
        const handled = await this.gateway.handle(req, res);
        if (!handled) sendJson(res, 404, { ok: false, error: 'Not found', code: 'NOT_FOUND' });
        return;
      }
      if (hostInfo.type === 'invalid') {
        sendJson(res, 404, { ok: false, error: 'Invalid host', code: 'INVALID_HOST' });
        return;
      }
      const url = parseUrl(req);
      if (url.pathname === '/healthz' || url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'fish-cloud-manager',
          time: Date.now(),
          tenants: Number(this.db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n),
          relay: { port: this.config.relayPort, upstreamConfigured: this.relay.upstreamPublic().configured }
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, url);
        return;
      }
      this.servePanel(req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        const { status, payload } = errorPayload(error);
        sendJson(res, status, payload);
      } else {
        try { res.destroy(); } catch { /* ignore */ }
      }
    }
  }

  async handleApi(req, res, url) {
    if (!this.auth.isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '请求来源不被信任', code: 'ORIGIN_REJECTED' });
      return;
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝', code: 'ORIGIN_REJECTED' });
      return;
    }
    const match = this.router.match(req.method, url.pathname);
    if (!match) { sendJson(res, 404, { ok: false, error: 'Not found', code: 'NOT_FOUND' }); return; }
    const authed = this.auth.resolve(req);
    const isLogin = url.pathname === '/api/auth/login';
    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase());
    if (!isLogin && !authed) {
      sendJson(res, 401, { ok: false, error: '请先登录', code: 'UNAUTHENTICATED' });
      return;
    }
    if (!isLogin && authed && !safeMethod) {
      const strictCsrf = /^\/api\/tenants\/[^/]+\/(?:agent|extensions)(?:\/|$)/.test(url.pathname)
        || /^\/api\/tenants\/[^/]+\/relay\/custom\/test$/.test(url.pathname)
        || /^\/api\/admin\/extensions(?:\/|$)/.test(url.pathname)
        || /^\/api\/admin\/recharges\/[^/]+\/reject$/.test(url.pathname)
        || /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)
        || url.pathname === '/api/auth/password';
      try { this.auth.verifyCsrf(req, authed, { strict: strictCsrf }); } catch (error) {
        const { status, payload } = errorPayload(error);
        sendJson(res, status, payload);
        return;
      }
    }
    const ctx = {
      req, res, url,
      params: match.params,
      auth: authed,
      ip: requestIp(req, this.config.trustProxy)
    };
    try {
      await match.route.handler(ctx);
    } catch (error) {
      const { status, payload } = errorPayload(error);
      if (status === 500) this.logger.error(`api ${req.method} ${url.pathname} failed`, error);
      else if (status >= 500) this.logger.warn(`api ${req.method} ${url.pathname}: ${payload.code}`);
      if (!res.headersSent) sendJson(res, status, payload);
      else { try { res.destroy(); } catch { /* ignore */ } }
    }
  }

  servePanel(req, res, url) {
    const panelDir = this.config.panelDir;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { pathname = '/index.html'; }
    if (pathname.startsWith('/test/') || pathname === '/package.json' || pathname === '/package-lock.json') {
      sendText(res, 404, 'Not found');
      return;
    }
    const safePath = path.resolve(panelDir, `.${pathname}`);
    const root = path.resolve(panelDir) + path.sep;
    if (!safePath.startsWith(root) && safePath !== path.resolve(panelDir, 'index.html')) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    let file = safePath;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(panelDir, 'index.html');
    }
    if (!fs.existsSync(file)) {
      sendText(res, 404, 'Panel has not been installed yet. Build packages/cloud-manager/panel first.');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  }

  async stop() {
    if (this.stopped) return;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.gateway.closeAll();
    let shutdownError;
    try { await this.hosting.shutdown(); } catch (error) { shutdownError = error; this.logger.error('shutdown failed', error); }
    await Promise.all([
      closeServer(this.server),
      closeServer(this.relayServer)
    ]);
    if (shutdownError) throw shutdownError;
    this.db.close();
    this.stopped = true;
  }
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    setTimeout(() => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      resolve();
    }, 2000).unref?.();
  });
}

export async function createCloudManager(options = {}) {
  const manager = new CloudManager(options);
  await manager.start();
  return manager;
}
