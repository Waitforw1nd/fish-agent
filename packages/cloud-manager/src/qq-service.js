import fs from 'node:fs';
import path from 'node:path';
import { randomToken, now, readJsonFile, id } from './util.js';
import { immediateTransaction } from './db.js';
import { llbotDriver } from './qq/llbot.js';
import { napcatDriver } from './qq/napcat.js';
import { snowlumaDriver } from './qq/snowluma.js';
import { DockerRuntime } from './qq/docker-runtime.js';
import { QQSwitchExecutor } from './qq/switch.js';

const DRIVERS = {
  llbot: llbotDriver,
  napcat: napcatDriver,
  snowluma: snowlumaDriver
};

function fail(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

export class QQService {
  constructor({ db, config, allocator, supervisor, secrets, settings, logger, audit }) {
    this.db = db;
    this.config = config;
    this.allocator = allocator;
    this.supervisor = supervisor;
    this.secrets = secrets;
    this.settings = settings;
    this.logger = logger;
    this.audit = audit;
    this.onLinksChanged = null;
    this.docker = new DockerRuntime({ db, config });
    this.locks = new Map();
    this.qrRequests = new Map();
    this.qrRefreshRequests = new Map();
    this.statusRequests = new Map();
    this.agentRuntime = null;
    this.switches = new QQSwitchExecutor(this);
  }

  async serial(tenantId, fn) {
    const prior = this.locks.get(tenantId) || Promise.resolve();
    const current = prior.catch(() => {}).then(fn);
    this.locks.set(tenantId, current);
    try { return await current; } finally { if (this.locks.get(tenantId) === current) this.locks.delete(tenantId); }
  }

  hasActiveSwitch(tenantId) {
    return Boolean(this.db.prepare("SELECT 1 FROM qq_operations WHERE tenant_id = ? AND status IN ('running', 'needs_attention')").get(tenantId));
  }

  assertNoSwitch(tenantId) {
    if (this.hasActiveSwitch(tenantId)) throw fail(409, 'QQ_SWITCH_ACTIVE', 'QQ 切换尚未完成');
  }

  publicOperation(row) {
    if (!row) throw fail(404, 'QQ_OPERATION_NOT_FOUND', '切换操作不存在');
    return {
      operationId: row.id, status: row.status, phase: row.phase,
      sourceDriver: row.source_driver, targetDriver: row.target_driver,
      expectedUin: row.expected_uin, expectedRevision: row.expected_revision,
      runtimeGeneration: row.runtime_generation, qrGeneration: row.qr_generation,
      canCancel: row.status === 'running' && ['preflight', 'snapshot_intent', 'snapshot_saved', 'quiesce_intent', 'quiesced', 'stop_source_intent', 'source_stopped', 'prepare_target', 'start_target_intent', 'waiting_qr'].includes(row.phase),
      error: row.error_json ? JSON.parse(row.error_json) : null,
      rollback: row.rollback_json ? JSON.parse(row.rollback_json) : null,
      agentWasRunning: Boolean(row.agent_was_running), createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  async getOperation(tenant, operationId) {
    return this.serial(tenant.id, async () => {
      const row = this.switches.row(tenant, operationId);
      await this.switches.tick(tenant, row);
      return this.publicOperation(row);
    });
  }

  async startSwitch(tenant, options = {}) {
    return this.serial(tenant.id, async () => {
      const pending = this.statusRequests.get(tenant.id);
      if (pending) await pending;
      return this.switches.start(tenant, options);
    });
  }

  async cancelSwitch(tenant, operationId, options = {}) {
    return this.serial(tenant.id, () => this.switches.cancel(tenant, operationId, options));
  }

  async recoverSwitches() { return this.switches.recover(); }

  driver(id) {
    return DRIVERS[id] || null;
  }

  capabilities(driverId = 'llbot') {
    return DRIVERS[driverId]?.capabilities || null;
  }

  async drivers() {
    return Promise.all(Object.values(DRIVERS).map(async (driver) => {
      const allowed = (this.config.qqDrivers || []).includes(driver.id);
      let installed = this.entryExists(driver.id), reasonCode = '', reason = '';
      if (driver.id === 'napcat') {
        try { await this.docker.preflight(); installed = true; }
        catch (error) { installed = false; reasonCode = error.code; reason = error.message; }
      } else if (!installed) { reasonCode = 'DRIVER_NOT_INSTALLED'; reason = '协议端尚未安装'; }
      if (driver.id === 'llbot' && installed && !this.platformAuthToken()) { reasonCode = 'AUTH_TOKEN_REQUIRED'; reason = '平台未配置 LLBot 登录授权'; }
      if (!allowed) { reasonCode = 'DRIVER_NOT_ALLOWED'; reason = '平台未允许此协议端'; }
      return { id: driver.id, label: driver.label, allowed, installed, available: allowed && installed && !reasonCode, reasonCode: reasonCode || null, reason: reason || null, capabilities: driver.capabilities };
    }));
  }

  account(tenantId) {
    return this.db.prepare('SELECT * FROM qq_accounts WHERE tenant_id = ?').get(tenantId) || null;
  }

  platformAuthToken() {
    const fromSettings = this.settings.get('platform.llbotAuthToken', '');
    return String(fromSettings || this.config.platformAuthToken || '').trim();
  }

  resolveAuthToken(tenant, account, provided) {
    if (provided !== undefined) {
      const value = String(provided ?? '').trim();
      if (value) {
        if (value.length < 8 || value.length > 4096 || /[\r\n]/.test(value)) {
          throw fail(400, 'INVALID_AUTH_TOKEN', 'Auth Token 格式不正确');
        }
        this.secrets.set(tenant.id, 'qq.llbot.auth_token', value);
        return { token: value, source: 'tenant' };
      }
      this.secrets.delete(tenant.id, 'qq.llbot.auth_token');
      this.secrets.delete(tenant.id, 'qq.auth_token');
    }
    const tenantToken = this.secrets.get(tenant.id, 'qq.llbot.auth_token', '') || this.secrets.get(tenant.id, 'qq.auth_token', '');
    if (tenantToken) return { token: tenantToken, source: 'tenant' };
    const platform = this.platformAuthToken();
    if (platform) return { token: platform, source: 'platform' };
    return { token: '', source: 'none' };
  }

  ensureBaseTokens(tenant) {
    let onebotToken = this.secrets.get(tenant.id, 'qq.onebot_token', '');
    if (!onebotToken) {
      onebotToken = randomToken(24);
      this.secrets.set(tenant.id, 'qq.onebot_token', onebotToken);
    }
    let webuiPassword = this.secrets.get(tenant.id, 'qq.webui_password', '');
    if (!webuiPassword) {
      webuiPassword = randomToken(18);
      this.secrets.set(tenant.id, 'qq.webui_password', webuiPassword);
    }
    return { onebotToken, webuiPassword };
  }

  tokens(tenant, account, authOverride = undefined) {
    const namespace = account?.runtime_secret_namespace;
    const get = (name, length) => {
      const key = `${namespace}.${name}`;
      let value = this.secrets.get(tenant.id, key, '');
      if (!value) { value = randomToken(length); this.secrets.set(tenant.id, key, value); }
      return value;
    };
    const base = namespace ? { onebotToken: get('onebot_token', 24), webuiPassword: get('webui_password', 18) } : this.ensureBaseTokens(tenant);
    const auth = account?.driver === 'napcat' ? { token: '', source: 'none' } : this.resolveAuthToken(tenant, account, authOverride);
    return { ...base, authToken: auth.token, authSource: auth.source };
  }

  paths(tenant, driverId, account = this.account(tenant.id)) {
    const profile = account?.driver === driverId && account.effective_profile_id
      ? this.db.prepare('SELECT * FROM qq_profiles WHERE id=? AND tenant_id=? AND driver=? AND expected_uin=?').get(account.effective_profile_id, tenant.id, driverId, account.expected_uin) : null;
    const dir = profile?.directory || (driverId === 'napcat' ? path.join(tenant.data_dir, 'qq', 'napcat', 'accounts', String(account?.expected_uin || '')) : path.join(tenant.data_dir, 'qq', driverId));
    return { dir, authTokenFile: path.join(dir, 'data', 'auth_token.txt') };
  }

  async ensurePorts(tenant, driverId, existing = null, { reset = false, excludePorts = [] } = {}) {
    if (reset) for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http', 'qq.pmhq']) this.allocator.release(tenant.id, purpose);
    const created = [];
    const allocate = async (purpose, preferredPort) => {
      const before = this.allocator.find(tenant.id, purpose);
      const lease = await this.allocator.allocate(tenant.id, purpose, { preferredPort, host: '127.0.0.1', excludePorts });
      if (!before) created.push(lease.id);
      return lease;
    };
    try {
      const webui = await allocate('qq.webui', existing?.webui_port);
      const ob11 = await allocate('qq.ob11', existing?.ob11_port);
      const http = driverId !== 'llbot' ? await allocate('qq.http', existing?.http_port) : null;
      return { webuiPort: webui.port, ob11Port: ob11.port, httpPort: http?.port ?? null };
    } catch (error) {
      for (const lease of created) this.allocator.releaseLease(lease);
      throw error;
    }
  }

  async prepare(tenant, options = {}) { return this.serial(tenant.id, () => { this.assertNoSwitch(tenant.id); return this.prepareUnlocked(tenant, options); }); }

  async prepareUnlocked(tenant, options = {}) {
    this.assertNoSwitch(tenant.id);
    const pending = this.statusRequests.get(tenant.id);
    if (pending) await pending;
    const current = this.account(tenant.id);
    const process = await this.runtimeStatus(tenant, current);
    if (['degraded', 'stop_unconfirmed'].includes(process.state)) throw fail(503, 'QQ_RUNTIME_UNCONFIRMED', '无法确认当前 QQ 运行状态');
    const oldRuntime = this.docker.row(tenant.id);
    if (current?.driver === 'napcat' && (oldRuntime?.container_id || oldRuntime?.network_id) && process.state === 'crashed') await this.docker.stop(tenant.id);
    const requested = String(options.driver || current?.driver || this.config.defaultQqDriver || 'napcat').toLowerCase();
    if (['running', 'starting', 'restarting'].includes(process.state)) {
      const requestedUin = String(options.uin || options.expectedUin || current?.expected_uin || '').trim();
      if (requested === current?.driver && requestedUin === current?.expected_uin && options.mode === undefined && options.pmhqPort === undefined && options.authToken === undefined) return this.status(tenant);
      throw fail(409, 'QQ_ALREADY_RUNNING', 'QQ 协议端正在运行，请先停止再修改配置');
    }
    const driverId = requested;
    const driver = this.driver(driverId);
    if (!driver || !(this.config.qqDrivers || []).includes(driverId)) throw fail(400, 'UNKNOWN_DRIVER', '未知或未允许的 QQ 协议端驱动');
    const expectedUin = String(options.uin || options.expectedUin || current?.expected_uin || '').trim();
    if (!/^\d{5,12}$/.test(expectedUin)) throw fail(400, 'INVALID_UIN', '请填写 5-12 位 QQ 号');

    const driverChanged = Boolean(current && current.driver !== driverId);
    const previous = readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {});
    const mode = driverId === 'llbot' ? String(options.mode ?? previous.mode ?? 'direct').toLowerCase() : 'direct';
    if (!['direct', 'desktop'].includes(mode)) throw fail(400, 'INVALID_LLBOT_MODE', 'LLBot 模式必须是 direct 或 desktop');
    const preparedOptions = { ...options };
    let newPmhqLeaseId = null;
    const existingLeases = new Set(['qq.webui', 'qq.ob11', 'qq.http'].map((purpose) => this.allocator.find(tenant.id, purpose)?.id).filter(Boolean));
    let prepared;
    try {
      if (mode === 'desktop') {
        const requested = options.pmhqPort == null || options.pmhqPort === '' ? null : Number(options.pmhqPort);
        if (requested !== null && (!Number.isInteger(requested) || requested < this.config.portRangeStart || requested > this.config.portRangeEnd)) throw fail(400, 'INVALID_PMHQ_PORT', 'PMHQ 端口必须在平台端口池内');
        const existingLease = this.allocator.find(tenant.id, 'qq.pmhq');
        if (existingLease && requested !== null && Number(existingLease.port) !== requested) throw fail(409, 'PMHQ_PORT_LOCKED', '已有 PMHQ 端口租约，切换 Direct 后可重新选择');
        const lease = await this.allocator.allocate(tenant.id, 'qq.pmhq', { preferredPort: requested, host: '127.0.0.1' });
        if (!existingLease) newPmhqLeaseId = lease.id;
        if (requested !== null && lease.port !== requested) throw fail(409, 'PMHQ_PORT_UNAVAILABLE', '指定 PMHQ 端口已占用或已分配');
        preparedOptions.mode = mode;
        preparedOptions.pmhqPort = lease.port;
      } else if (driverId === 'llbot') {
        preparedOptions.mode = 'direct';
      }
      const sameProfile = current?.driver === driverId && current?.expected_uin === expectedUin;
      if (current && !current.effective_profile_id) this.switches.profile(tenant, current, true);
      const ports = await this.ensurePorts(tenant, driverId, sameProfile ? current : null);
      const account = {
        ...(sameProfile ? current : {}),
        tenant_id: tenant.id,
        driver: driverId,
        expected_uin: expectedUin,
        uin: sameProfile ? current.uin : null,
        nickname: sameProfile ? current.nickname : null,
        state: 'prepared',
        webui_port: ports.webuiPort,
        ob11_port: ports.ob11Port,
        http_port: ports.httpPort,
        last_error: null
      };
      account.effective_profile_id = this.switches.profile(tenant, account, !current && driverId === 'llbot').id;
      const tokens = this.tokens(tenant, account, options.authToken);
      account.auth_source = tokens.authSource;
      prepared = await driver.prepare({ ...this.driverContext(tenant, account, driverId, tokens, driver), options: preparedOptions });
      immediateTransaction(this.db, () => {
        this.upsertAccount(account);
        this.db.prepare('UPDATE qq_accounts SET revision = revision + 1 WHERE tenant_id = ?').run(tenant.id);
      });
    } catch (error) {
      if (newPmhqLeaseId) this.allocator.releaseLease(newPmhqLeaseId);
      for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http']) {
        const lease = this.allocator.find(tenant.id, purpose);
        if (lease && !existingLeases.has(lease.id)) this.allocator.releaseLease(lease.id);
      }
      throw error;
    }
    if (mode !== 'desktop') this.allocator.release(tenant.id, 'qq.pmhq');
    if (driverId === 'llbot') this.allocator.release(tenant.id, 'qq.http');
    await this.onLinksChanged?.(tenant, { reason: 'qq.prepare' });
    return {
      ...(await this.status(tenant, { probe: false })),
      prepared,
      driverChanged
    };
  }

  driverContext(tenant, account, driverId, tokens, driver = null) {
    return {
      config: this.config,
      tenant,
      account,
      paths: this.paths(tenant, driverId, account),
      docker: driverId === 'napcat',
      generation: account.runtime_generation || this.docker.row(tenant.id)?.generation || 0,
      tokens,
      driver: driver || this.driver(driverId),
      logger: this.logger
    };
  }

  upsertAccount(account) {
    this.db.prepare(`
      INSERT INTO qq_accounts (tenant_id, driver, uin, expected_uin, nickname, state, webui_port, ob11_port,
        http_port, auth_source, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        driver = excluded.driver, uin = excluded.uin, expected_uin = excluded.expected_uin,
        nickname = excluded.nickname, state = excluded.state, webui_port = excluded.webui_port,
        ob11_port = excluded.ob11_port, http_port = excluded.http_port,
        auth_source = excluded.auth_source, last_error = excluded.last_error, updated_at = excluded.updated_at
    `).run(account.tenant_id, account.driver, account.uin || null, account.expected_uin || null,
      account.nickname || null, account.state, account.webui_port || null, account.ob11_port || null,
      account.http_port || null, account.auth_source || 'none', account.last_error || null, now());
    this.db.prepare(`UPDATE qq_accounts SET effective_profile_id=?,effective_runtime_id=?,runtime_generation=?,runtime_secret_namespace=? WHERE tenant_id=?`)
      .run(account.effective_profile_id || null, account.effective_runtime_id || null, account.runtime_generation || 0, account.runtime_secret_namespace || null, account.tenant_id);
  }

  updateAccount(tenantId, patch) {
    const current = this.account(tenantId);
    if (!current) return;
    this.upsertAccount({ ...current, ...patch, tenant_id: tenantId });
  }

  async start(tenant) { return this.serial(tenant.id, () => { this.assertNoSwitch(tenant.id); return this.startUnlocked(tenant); }); }

  async prepareAndStart(tenant, options = {}) {
    return this.serial(tenant.id, async () => {
      this.assertNoSwitch(tenant.id);
      const pending = this.statusRequests.get(tenant.id);
      if (pending) await pending;
      const account = this.account(tenant.id);
      const status = account ? await this.status(tenant, { probe: false }) : null;
      const driver = options.driver || account?.driver;
      const uin = options.uin || account?.expected_uin;
      const changed = !account || (driver && driver !== account.driver) || (uin && String(uin) !== account.expected_uin)
        || (options.mode !== undefined && options.mode !== status?.mode)
        || (options.pmhqPort !== undefined && Number(options.pmhqPort) !== status?.ports?.pmhq);
      if (changed) await this.prepareUnlocked(tenant, { ...options, driver, uin });
      else if (String(options.authToken || '').trim()) await this.setAuthToken(tenant, options.authToken);
      return this.startUnlocked(tenant);
    });
  }

  async startUnlocked(tenant) {
    this.assertNoSwitch(tenant.id);
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const state = await this.runtimeStatus(tenant, account);
    if (['degraded', 'stop_unconfirmed'].includes(state.state)) throw fail(503, 'QQ_RUNTIME_UNCONFIRMED', '无法确认当前 QQ 运行状态');
    immediateTransaction(this.db, () => this.switches.claim(tenant, account));
    try { return await this.startAccountUnlocked(tenant); }
    catch (error) {
      try {
        const actual = await this.runtimeStatus(tenant, account);
        if (['stopped', 'crashed', 'failed'].includes(actual.state)) {
          await this.switches.stopRuntime(tenant, account);
          this.switches.releaseClaim(tenant, account);
        }
      } catch { /* Keep the claim until exit is confirmed. */ }
      throw error;
    }
  }

  async startAccountUnlocked(tenant) {
    const pending = this.statusRequests.get(tenant.id);
    if (pending) await pending;
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const driver = this.driver(account.driver);
    if (!driver) throw fail(400, 'UNKNOWN_DRIVER', '未知 QQ 协议端驱动');
    const process = await this.runtimeStatus(tenant, account);
    if (['degraded', 'stop_unconfirmed'].includes(process.state)) throw fail(503, 'QQ_RUNTIME_UNCONFIRMED', '无法确认当前 QQ 运行状态');
    if (['running', 'starting', 'restarting'].includes(process.state)) {
      return this.status(tenant);
    }
    if (account.runtime_secret_namespace || account.runtime_generation > 0) {
      await this.switches.preflight(tenant, account);
      const generation = Math.max(account.runtime_generation || 0, this.docker.row(tenant.id)?.generation || 0) + 1;
      const updated = { ...account, effective_runtime_id: id('qqrun'), runtime_generation: generation, runtime_secret_namespace: `qq.${account.driver}.runtime.${generation}`, state: 'awaiting_login' };
      const leases = [];
      try {
        for (const [purpose, field] of [['webui', 'webui_port'], ['ob11', 'ob11_port'], ...(account.driver === 'napcat' ? [['http', 'http_port']] : [])]) {
          const lease = await this.allocator.allocate(tenant.id, `qq.g${generation}.${purpose}`, { host: '127.0.0.1' });
          leases.push(lease); updated[field] = lease.port;
        }
        await this.switches.stopRuntime(tenant, account);
        immediateTransaction(this.db, () => {
          this.switches.releaseClaim(tenant, account);
          this.switches.claim(tenant, updated);
        });
        await this.switches.launchRuntime(tenant, updated);
        this.upsertAccount(updated);
        this.db.prepare("UPDATE port_leases SET released_at=? WHERE tenant_id=? AND purpose LIKE 'qq.%' AND released_at IS NULL AND purpose NOT LIKE ?").run(now(), tenant.id, `qq.g${generation}.%`);
      } catch (error) {
        try { await this.switches.stopRuntime(tenant, updated); this.switches.releaseClaim(tenant, updated); for (const lease of leases) this.allocator.releaseLease(lease.id); } catch { /* Retain uncertain resources. */ }
        throw error;
      }
      await this.onLinksChanged?.(tenant, { reason: 'qq.start' });
      return this.status(tenant);
    }
    if (account.driver === 'napcat') await this.docker.preflight();
    const existingLeases = new Set(['qq.webui', 'qq.ob11', 'qq.http'].map((purpose) => this.allocator.find(tenant.id, purpose)?.id).filter(Boolean));
    const ports = await this.ensurePorts(tenant, account.driver, account);
    if (account.driver === 'llbot') {
      const runtime = readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {});
      if (runtime.mode === 'desktop') {
        const lease = this.allocator.find(tenant.id, 'qq.pmhq');
        if (!lease || Number(lease.port) !== Number(runtime.pmhqPort)) throw fail(409, 'PMHQ_LEASE_MISSING', 'PMHQ 端口租约丢失，请重新准备桌面模式');
      }
    }
    const tokens = this.tokens(tenant, account);
    const updated = {
      ...account,
      expected_uin: account.expected_uin,
      webui_port: ports.webuiPort,
      ob11_port: ports.ob11Port,
      http_port: ports.httpPort,
      auth_source: tokens.authSource,
      state: 'starting',
      last_error: null
    };
    try {
      await driver.prepare(this.driverContext(tenant, updated, account.driver, tokens, driver));
      this.upsertAccount(updated);
      if (account.driver === 'napcat') {
        const excludedPorts = [];
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.docker.start(tenant, updated, this.driverContext(tenant, updated, account.driver, tokens, driver).paths.dir);
            break;
          } catch (error) {
            if (error.code !== 'NAPCAT_PORT_CONFLICT' || attempt >= 2) throw error;
            const runtime = this.docker.row(tenant.id);
            if (runtime?.container_id || runtime?.network_id) throw fail(503, 'NAPCAT_CLEANUP_UNCONFIRMED', 'NapCat 清理未确认，禁止重试');
            for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http']) {
              const lease = this.allocator.find(tenant.id, purpose);
              if (lease) { excludedPorts.push(Number(lease.port)); this.allocator.releaseLease(lease.id); }
            }
            const replacement = await this.ensurePorts(tenant, account.driver, null, { excludePorts: excludedPorts });
            Object.assign(updated, { webui_port: replacement.webuiPort, ob11_port: replacement.ob11Port, http_port: replacement.httpPort });
            await driver.prepare(this.driverContext(tenant, updated, account.driver, tokens, driver));
            this.upsertAccount(updated);
          }
        }
        const deadline = Date.now() + this.config.processStartTimeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          try { await driver.qrcode(this.driverContext(tenant, updated, account.driver, tokens, driver)); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
        }
        if (!ready) { await this.docker.stop(tenant.id); throw fail(503, 'NAPCAT_READY_TIMEOUT', 'NapCat WebUI 未在时限内就绪'); }
        const runtime = this.docker.row(tenant.id);
        runtime.state = 'running'; runtime.updated_at = Date.now(); this.docker.save(runtime);
      } else {
        const launch = await driver.launch(this.driverContext(tenant, updated, account.driver, tokens, driver));
        await this.supervisor.start({
          tenantId: tenant.id,
          kind: 'qq',
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: launch.env || {},
          logFile: path.join(this.config.logDir, 'tenants', `${tenant.id}.qq.log`),
          ready: launch.readyOptional ? null : {
            host: launch.readyHost || '127.0.0.1',
            port: Number(launch.readyPort),
            timeoutMs: this.config.processStartTimeoutMs
          },
          restart: true
        });
      }
    } catch (error) {
      const runtime = this.docker.row(tenant.id);
      if (account.driver !== 'napcat' || !runtime || (runtime.state === 'stopped' && !runtime.container_id && !runtime.network_id)) {
        for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http']) {
          const lease = this.allocator.find(tenant.id, purpose);
          if (lease && !existingLeases.has(lease.id)) this.allocator.releaseLease(lease.id);
        }
      }
      this.updateAccount(tenant.id, { state: 'failed', last_error: String(error?.message || error) });
      throw error;
    }
    await this.onLinksChanged?.(tenant, { reason: 'qq.start' });
    const desktop = account.driver === 'llbot' && readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode === 'desktop';
    const needsToken = Boolean(driver.capabilities.authToken) && !desktop && !tokens.authToken;
    this.updateAccount(tenant.id, { state: needsToken ? 'auth_required' : 'awaiting_login', last_error: null });
    return this.status(tenant, { probe: true });
  }

  async stop(tenant, options = {}) { return this.serial(tenant.id, () => { this.assertNoSwitch(tenant.id); return this.stopUnlocked(tenant, options); }); }

  async stopUnlocked(tenant, { releasePorts = false } = {}) {
    this.assertNoSwitch(tenant.id);
    const pending = this.statusRequests.get(tenant.id);
    if (pending) await pending;
    const account = this.account(tenant.id);
    if (account?.driver === 'napcat' && this.agentRuntime) await this.agentRuntime.stop(tenant, { force: true });
    if (account) { await this.switches.stopRuntime(tenant, account); this.switches.releaseClaim(tenant, account); }
    if (releasePorts) this.db.prepare("UPDATE port_leases SET released_at=? WHERE tenant_id=? AND purpose LIKE 'qq.%' AND released_at IS NULL").run(now(), tenant.id);
    if (this.account(tenant.id)) this.updateAccount(tenant.id, { state: 'prepared' });
    await this.onLinksChanged?.(tenant, { reason: 'qq.stop' });
    return this.status(tenant, { probe: false });
  }

  async authStatus(tenant) {
    const account = this.account(tenant.id);
    if (!account) {
      return {
        driver: null,
        applicable: false,
        hasToken: false,
        validation: 'idle',
        message: '尚未配置 QQ 协议端',
        source: 'none'
      };
    }
    const driver = this.driver(account.driver);
    const tokens = this.tokens(tenant, account);
    try {
      const status = await driver.authStatus(this.driverContext(tenant, account, account.driver, tokens, driver));
      return { driver: account.driver, ...status, source: status.source || tokens.authSource };
    } catch (error) {
      return {
        driver: account.driver,
        applicable: Boolean(driver.capabilities.authToken),
        hasToken: Boolean(tokens.authToken),
        validation: 'error',
        message: String(error?.message || error),
        source: tokens.authSource
      };
    }
  }

  localAuthStatus(tenant, account = this.account(tenant.id), driver = null) {
    const driverImpl = driver || this.driver(account?.driver);
    const tokens = account ? this.tokens(tenant, account) : { authToken: '', authSource: 'none' };
    const desktop = account?.driver === 'llbot' && readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode === 'desktop';
    const applicable = Boolean(driverImpl?.capabilities?.authToken) && !desktop;
    return {
      applicable,
      hasToken: Boolean(tokens.authToken),
      validation: 'idle',
      message: tokens.authToken ? '' : (applicable ? '尚未配置 Auth Token' : '该协议端不使用 Auth Token'),
      loginError: '',
      online: false,
      source: tokens.authSource,
      authTokenPageUrl: ''
    };
  }

  async runtimeStatus(tenant, account = this.account(tenant.id)) {
    if (account?.driver !== 'napcat') return this.supervisor.status(tenant.id, 'qq');
    const row = this.docker.row(tenant.id);
    try { this.docker.assertResourceIdentity(row); }
    catch { return { state: 'degraded', pid: null }; }
    if (!row?.container_id) return { state: row?.network_id || row?.desired_state === 'running' ? 'degraded' : row?.state === 'failed' ? 'crashed' : 'stopped', pid: null };
    try {
      const actual = await this.docker.inspect(row);
      return { state: actual.State?.Running ? (row.desired_state === 'running' ? 'running' : 'degraded') : 'crashed', pid: null };
    } catch { return { state: 'degraded', pid: null }; }
  }

  async status(tenant, { probe = true } = {}) {
    if (!probe) return this.statusUnlocked(tenant, { probe });
    const existing = this.statusRequests.get(tenant.id);
    if (existing) return existing;
    const pending = this.statusUnlocked(tenant, { probe });
    this.statusRequests.set(tenant.id, pending);
    try { return await pending; } finally { if (this.statusRequests.get(tenant.id) === pending) this.statusRequests.delete(tenant.id); }
  }

  async statusUnlocked(tenant, { probe = true } = {}) {
    const account = this.account(tenant.id);
    const operation = this.db.prepare("SELECT * FROM qq_operations WHERE tenant_id=? AND status IN ('running','needs_attention')").get(tenant.id);
    if (operation) {
      const target = operation.target_json ? JSON.parse(operation.target_json).account : null;
      const selected = target || account;
      return { revision: Number(account?.revision || 0), activeOperationId: operation.id, latestOperationId: operation.id,
        driver: account?.driver, kernel: account?.driver, targetDriver: operation.target_driver, state: operation.status === 'needs_attention' ? 'failed' : 'switching', phase: operation.phase,
        runtimeState: operation.status === 'needs_attention' ? 'degraded' : target ? 'ready' : 'stopped', loginState: operation.phase === 'waiting_qr' ? 'waiting_qr' : 'offline',
        agentChannelState: 'paused', runtimeGeneration: operation.runtime_generation || 0, canChat: false, running: Boolean(target), online: false, loggedIn: false,
        expectedUin: selected?.expected_uin, uin: null, ports: { webui: selected?.webui_port, ob11: selected?.ob11_port, http: selected?.http_port },
        capabilities: this.capabilities(selected?.driver), qrAvailable: operation.status === 'running' && operation.phase === 'waiting_qr',
        onebotConnected: false, error: operation.error_json ? JSON.parse(operation.error_json).message : null };
    }
    const latestOperation = this.db.prepare('SELECT id, status FROM qq_operations WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(tenant.id);
    const operationFields = { revision: Number(account?.revision || 0), activeOperationId: this.hasActiveSwitch(tenant.id) ? this.db.prepare("SELECT id FROM qq_operations WHERE tenant_id = ? AND status IN ('running', 'needs_attention')").get(tenant.id).id : null, latestOperationId: latestOperation?.id || null };
    if (!account) {
      return {
        ...operationFields,
        runtimeState: 'stopped', loginState: 'offline', agentChannelState: 'disconnected', runtimeGeneration: 0, canChat: false,
        driver: null,
        kernel: 'unknown',
        driverLabel: null,
        state: 'unprepared',
        phase: 'stopped',
        running: false,
        loggedIn: false,
        online: false,
        capabilities: null,
        expectedUin: null,
        uin: null,
        nickname: null,
        process: { state: 'stopped', pid: null },
        ports: {},
        authToken: { applicable: false, hasToken: false, validation: 'idle', source: 'none', status: 'unknown' },
        authTokenStatus: 'unknown',
        authTokenMessage: '',
        qrAvailable: false,
        onebotConnected: false,
        error: null,
        message: '',
        lastError: null
      };
    }
    const driver = this.driver(account.driver);
    let process = await this.runtimeStatus(tenant, account);
    const observedGeneration = account.driver === 'napcat' ? this.docker.row(tenant.id)?.generation : null;
    let probeResult = null;
    if (probe && ['running', 'restarting'].includes(process.state)) {
      try {
        probeResult = await driver.status(this.driverContext(tenant, account, account.driver, this.tokens(tenant, account), driver));
      } catch (error) {
        probeResult = { error: String(error?.message || error), code: 'DRIVER_PROBE_FAILED' };
      }
    }
    const latest = this.account(tenant.id);
    const runtime = account.driver === 'napcat' ? this.docker.row(tenant.id) : null;
    if (latest?.driver !== account.driver || latest?.expected_uin !== account.expected_uin || (account.driver === 'napcat' && (runtime?.generation !== observedGeneration || (probeResult && runtime?.desired_state !== 'running')))) return this.statusUnlocked(tenant, { probe: false });
    let state = latest.state;
    let lastError = latest.last_error;
    let uin = latest.uin;
    let nickname = latest.nickname;
    if (probeResult?.uinMismatch) {
      lastError = `实际登录 QQ (${probeResult.uin}) 与配置 (${account.expected_uin}) 不一致，已停止协议端`;
      this.updateAccount(tenant.id, { state: 'uin_mismatch', last_error: lastError });
      try { if (this.agentRuntime) await this.agentRuntime.stop(tenant, { force: true }); }
      finally {
        if (account.driver === 'napcat') await this.docker.stop(tenant.id);
        else await this.supervisor.stop(tenant.id, 'qq', { force: true });
      }
      await this.onLinksChanged?.(tenant, { reason: 'qq.uin_mismatch' });
      process = await this.runtimeStatus(tenant, account);
      state = 'uin_mismatch';
      probeResult.online = false;
      this.logger?.warn?.('qq uin mismatch', { tenantId: tenant.id, expected: account.expected_uin, actual: probeResult.uin });
    } else if (probeResult?.online && probeResult?.uin === account.expected_uin) {
      state = 'online';
      uin = probeResult.uin || uin;
      nickname = probeResult.nickname || nickname;
      lastError = null;
    } else if (process.state === 'running' && probe) {
      const desktop = account.driver === 'llbot' && readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode === 'desktop';
      state = !desktop && account.auth_source === 'none' && driver?.capabilities.authToken ? 'auth_required' : 'awaiting_login';
      if (probeResult?.error) lastError = probeResult.error;
    } else if (process.state === 'crashed') {
      state = 'crashed';
    } else if (process.state === 'stopped') {
      state = account.state === 'online' || account.state === 'awaiting_login' ? 'prepared' : account.state;
    }
    if (probeResult?.error && process.state !== 'running') lastError = probeResult.error;
    const authToken = probe && process.state === 'running'
      ? await this.authStatus(tenant)
      : this.localAuthStatus(tenant, account, driver);
    if (authToken.applicable && !authToken.hasToken && process.state === 'running' && state !== 'uin_mismatch') {
      state = 'auth_required';
    }
    const phase = this.panelPhase(state, process.state);
    const authTokenStatus = this.panelAuthTokenStatus(authToken);
    authToken.status = authTokenStatus;
    this.updateAccount(tenant.id, { state, last_error: lastError || null, uin, nickname });
    if (account.driver === 'napcat' && state !== account.state && (state === 'online' || account.state === 'online')) await this.onLinksChanged?.(tenant, { reason: state === 'online' ? 'qq.identity_verified' : 'qq.disconnected' });
    const online = Boolean(probeResult?.online && probeResult?.uin && probeResult.uin === account.expected_uin);
    const runtimeGeneration = account.runtime_generation || (account.driver === 'napcat' ? this.docker.row(tenant.id)?.generation || 0 : 0);
    const health = probe && this.agentRuntime ? await this.agentRuntime.health(tenant) : null;
    const channel = health?.channels?.qq || (health?.onebot?.platform === 'qq' ? health.onebot : null);
    const onebotConnected = Boolean(health?.ok && channel?.connected === true && channel.generation != null && Number(channel.generation) === runtimeGeneration && String(channel.selfId || '') === String(account.expected_uin));
    return {
      ...operationFields,
      runtimeState: process.state === 'running' ? (account.driver === 'napcat' && this.docker.row(tenant.id)?.state === 'starting' ? 'starting' : 'ready') : process.state,
      loginState: online ? 'online' : state === 'uin_mismatch' ? 'login_failed' : process.state === 'running' ? probeResult?.loginState || 'waiting_qr' : 'offline',
      agentChannelState: onebotConnected ? 'connected' : 'disconnected',
      runtimeGeneration,
      canChat: online && onebotConnected,
      driver: account.driver,
      kernel: account.driver,
      driverLabel: driver?.label || account.driver,
      state,
      phase,
      running: ['running', 'starting', 'restarting'].includes(process.state),
      loggedIn: online,
      online,
      expectedUin: account.expected_uin,
      uin,
      nickname,
      capabilities: driver?.capabilities || null,
      mode: account.driver === 'llbot' ? readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode || 'direct' : null,
      process: {
        state: process.state,
        pid: process.pid,
        restarts: process.restarts || 0,
        startedAt: process.startedAt || null,
        readyAt: process.readyAt || null
      },
      ports: {
        webui: account.webui_port,
        ob11: account.ob11_port,
        http: account.http_port,
        pmhq: this.allocator.find(tenant.id, 'qq.pmhq')?.port ?? null
      },
      webui: { host: '127.0.0.1', port: account.webui_port },
      authToken,
      authTokenStatus,
      authTokenMessage: authToken.message || authToken.loginError || '',
      qrAvailable: Boolean(driver?.capabilities?.qrcode) && process.state === 'running' && !online,
      onebotConnected,
      onebotPort: account.ob11_port ?? null,
      onebotTokenConfigured: true,
      error: lastError || null,
      message: lastError || '',
      lastError: lastError || null,
      entryExists: driver ? this.entryExists(account.driver) : false
    };
  }

  panelPhase(state, processState) {
    if (state === 'online') return 'online';
    if (['uin_mismatch', 'crashed', 'failed'].includes(state)) return 'error';
    if (['starting', 'restarting'].includes(processState) || state === 'starting') return 'starting';
    if (processState === 'running' || ['awaiting_login', 'auth_required'].includes(state)) return 'waiting_login';
    return 'stopped';
  }

  panelAuthTokenStatus(authToken) {
    if (!authToken || authToken.applicable === false) return 'ok';
    if (!authToken.hasToken) return 'missing';
    if (['invalid', 'error'].includes(authToken.validation)) return 'invalid';
    if (/quota|limit|配额|限流/i.test(`${authToken.message || ''} ${authToken.loginError || ''}`)) return 'quota';
    if (authToken.validation === 'valid') return 'ok';
    return 'unknown';
  }

  entryExists(driverId) {
    const map = {
      llbot: this.config.llbotEntry,
      napcat: this.config.napcatEntry,
      snowluma: this.config.snowlumaEntry
    };
    return Boolean(map[driverId] && fs.existsSync(map[driverId]));
  }

  async refreshQrcode(tenant, { runtimeGeneration } = {}) {
    this.assertNoSwitch(tenant.id);
    if (runtimeGeneration != null && (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 0)) {
      throw fail(400, 'INVALID_RUNTIME_GENERATION', '运行代次无效');
    }
    const generation = () => this.account(tenant.id)?.runtime_generation || this.docker.row(tenant.id)?.generation || 0;
    const expectedGeneration = runtimeGeneration ?? generation();
    const existing = this.qrRefreshRequests.get(tenant.id);
    if (existing) {
      if (existing.generation !== expectedGeneration) throw fail(409, 'QRCODE_STALE', '登录状态已变化，请重新打开二维码');
      return existing.promise;
    }
    const promise = this.serial(tenant.id, async () => {
      this.assertNoSwitch(tenant.id);
      const pendingStatus = this.statusRequests.get(tenant.id);
      if (pendingStatus) await pendingStatus;
      const account = this.account(tenant.id);
      if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
      if (account.driver !== 'napcat') throw fail(501, 'QRCODE_REFRESH_UNSUPPORTED', '当前内核暂不支持获取新二维码');
      if (generation() !== expectedGeneration) throw fail(409, 'QRCODE_STALE', '登录状态已变化，请重新打开二维码');
      const currentTenant = () => {
        const current = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenant.id);
        if (!current || current.status !== 'active' || Number(current.expires_at) <= now()) throw fail(409, 'TENANT_INACTIVE', '实例不可用');
        return current;
      };
      currentTenant();
      const runtime = await this.runtimeStatus(tenant, account);
      if (runtime.state !== 'running') throw fail(409, 'QQ_NOT_RUNNING', '请先启动 QQ 登录服务');
      const driver = this.driver(account.driver);
      const ctx = this.driverContext(tenant, account, account.driver, this.tokens(tenant, account), driver);
      const status = await driver.status(ctx);
      if (status.error || status.uinMismatch) throw fail(409, 'QQ_LOGIN_UNCONFIRMED', '无法确认 QQ 登录状态，请稍后重试');
      if (['waiting_confirm', 'initializing'].includes(status.loginState)) throw fail(409, 'QQ_LOGIN_IN_PROGRESS', '已扫码，请先在手机完成确认');
      const qr = await driver.qrcode(ctx);
      if (status.online || qr.state === 'success') return this.qrcodeUnlocked(tenant);
      if (qr.state === 'scanned') throw fail(409, 'QQ_LOGIN_IN_PROGRESS', '已扫码，请先在手机完成确认');
      const resumeAgent = this.supervisor.status(tenant.id, 'agent').state === 'running';
      await this.stopUnlocked(currentTenant());
      await this.startUnlocked(currentTenant());
      const deadline = Date.now() + Math.min(this.config.processStartTimeoutMs, 15_000);
      do {
        const renewed = await this.qrcodeUnlocked(tenant);
        if (renewed.state === 'success' || (renewed.qrcodeUrl && renewed.qrcodeUrl !== qr.qrcodeUrl)) {
          const fresh = currentTenant();
          if (resumeAgent && !['running', 'starting', 'restarting'].includes(this.supervisor.status(tenant.id, 'agent').state)) {
            this.agentRuntime.assertNoUnconfirmedAgent?.(fresh);
            await this.agentRuntime.start(fresh);
          }
          return renewed;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      throw fail(504, 'QRCODE_GENERATION_TIMEOUT', '新二维码仍在生成，请稍后重新打开查看');
    });
    this.qrRefreshRequests.set(tenant.id, { generation: expectedGeneration, promise });
    try { return await promise; } finally {
      if (this.qrRefreshRequests.get(tenant.id)?.promise === promise) this.qrRefreshRequests.delete(tenant.id);
    }
  }

  async qrcode(tenant) {
    const existing = this.qrRequests.get(tenant.id);
    if (existing) return existing;
    const pending = this.serial(tenant.id, () => {
      const operation = this.db.prepare("SELECT * FROM qq_operations WHERE tenant_id=? AND status IN ('running','needs_attention')").get(tenant.id);
      return operation ? this.switches.qrcode(tenant, operation) : this.qrcodeUnlocked(tenant);
    });
    this.qrRequests.set(tenant.id, pending);
    try { return await pending; } finally { if (this.qrRequests.get(tenant.id) === pending) this.qrRequests.delete(tenant.id); }
  }

  async qrcodeUnlocked(tenant) {
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const process = await this.runtimeStatus(tenant, account);
    if (!['running', 'restarting'].includes(process.state)) {
      throw fail(409, 'QQ_NOT_RUNNING', 'QQ 协议端未运行，请先启动');
    }
    const driver = this.driver(account.driver);
    const tokens = this.tokens(tenant, account);
    const runtimeGeneration = account.runtime_generation || (account.driver === 'napcat' ? this.docker.row(tenant.id)?.generation || 0 : 0);
    const qr = await driver.qrcode(this.driverContext(tenant, account, account.driver, tokens, driver));
    const latest = this.account(tenant.id);
    if (latest?.driver !== account.driver || latest?.expected_uin !== account.expected_uin || (account.driver === 'napcat' && (this.docker.row(tenant.id)?.generation !== runtimeGeneration || this.docker.row(tenant.id)?.desired_state !== 'running'))) throw fail(409, 'QRCODE_STALE', 'QQ 运行状态已改变，请重新获取二维码');
    return {
      ...qr,
      runtimeGeneration,
      qrGeneration: qr.qrGeneration || 0,
      driver: account.driver,
      expectedUin: account.expected_uin,
      pollTimeInterval: qr.pollTimeInterval || 3
    };
  }

  async setAuthToken(tenant, token) {
    this.assertNoSwitch(tenant.id);
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const driver = this.driver(account.driver);
    if (!driver.capabilities.authToken) throw fail(400, 'AUTH_TOKEN_UNSUPPORTED', `${driver.label} 不使用 Auth Token`);
    const value = String(token ?? '').trim();
    this.resolveAuthToken(tenant, account, value);
    const tokens = this.tokens(tenant, account);
    const result = await driver.setAuthToken(this.driverContext(tenant, account, account.driver, tokens, driver), value);
    this.updateAccount(tenant.id, {
      auth_source: tokens.authSource,
      state: result.restartRequired && !value ? 'auth_required' : account.state,
      last_error: null
    });
    return {
      saved: true,
      source: tokens.authSource,
      restartRequired: Boolean(result.restartRequired),
      warning: result.warning || null,
      authToken: await this.authStatus(tenant)
    };
  }

  async describeChannels(tenant) {
    const operation = this.db.prepare("SELECT phase FROM qq_operations WHERE tenant_id=? AND status IN ('running','needs_attention')").get(tenant.id);
    if (operation && !['committed', 'resume_intent', 'verify_agent', 'rollback_saved', 'rollback_resume_intent'].includes(operation.phase)) return null;
    const account = this.account(tenant.id);
    if (!account || ['unprepared', 'uin_mismatch'].includes(account.state) || (account.driver === 'napcat' && (account.state !== 'online' || account.uin !== account.expected_uin || this.docker.row(tenant.id)?.desired_state !== 'running'))) return null;
    const tokens = this.tokens(tenant, account);
    return {
      enabled: true,
      generation: account.runtime_generation || (account.driver === 'napcat' ? this.docker.row(tenant.id)?.generation || 0 : 0),
      ...(account.driver === 'napcat' ? { media: { mode: 'inline-base64', maxImageBytes: 5242880, incomingLocalPaths: 'deny' } } : {}),
      driver: account.driver,
      apiTransport: account.driver === 'llbot' ? 'ws' : 'http',
      uin: account.uin || account.expected_uin,
      wsUrl: `ws://127.0.0.1:${account.ob11_port}`,
      httpUrl: account.http_port ? `http://127.0.0.1:${account.http_port}` : '',
      accessToken: tokens.onebotToken,
      httpAccessToken: tokens.onebotToken
    };
  }

  async logs(tenant, limit = 100) {
    const account = this.account(tenant.id);
    if (account?.driver !== 'napcat') return this.supervisor.logs(tenant.id, 'qq', limit);
    const row = this.docker.row(tenant.id);
    if (!row?.container_id) return [];
    await this.docker.inspect(row);
    const text = await this.docker.command(['logs', '--tail', String(Math.max(1, Math.min(500, Number(limit) || 100))), row.container_id]);
    const tokens = this.tokens(tenant, account);
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      let safe = line.replace(/https?:\/\/\S+/g, '[url]');
      for (const secret of [tokens.webuiPassword, tokens.onebotToken]) if (secret) safe = safe.split(secret).join('[redacted]');
      return safe;
    });
  }

  async remove(tenant) {
    await this.stop(tenant, { releasePorts: true });
    this.secrets.delete(tenant.id, 'qq.onebot_token');
    this.secrets.delete(tenant.id, 'qq.webui_password');
    this.secrets.delete(tenant.id, 'qq.auth_token');
    this.db.prepare('DELETE FROM qq_accounts WHERE tenant_id = ?').run(tenant.id);
  }
}
