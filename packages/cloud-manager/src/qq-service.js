import fs from 'node:fs';
import path from 'node:path';
import { randomToken, now, readJsonFile } from './util.js';
import { llbotDriver } from './qq/llbot.js';
import { napcatDriver } from './qq/napcat.js';
import { snowlumaDriver } from './qq/snowluma.js';

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
  }

  driver(id) {
    return DRIVERS[id] || null;
  }

  capabilities(driverId = 'llbot') {
    return DRIVERS[driverId]?.capabilities || null;
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
        this.secrets.set(tenant.id, 'qq.auth_token', value);
        return { token: value, source: 'tenant' };
      }
      this.secrets.delete(tenant.id, 'qq.auth_token');
    }
    const tenantToken = this.secrets.get(tenant.id, 'qq.auth_token', '');
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
    const base = this.ensureBaseTokens(tenant);
    const auth = this.resolveAuthToken(tenant, account, authOverride);
    return {
      onebotToken: base.onebotToken,
      webuiPassword: base.webuiPassword,
      authToken: auth.token,
      authSource: auth.source
    };
  }

  paths(tenant, driverId) {
    return {
      dir: path.join(tenant.data_dir, 'qq', driverId),
      authTokenFile: path.join(tenant.data_dir, 'qq', driverId, 'data', 'auth_token.txt')
    };
  }

  async ensurePorts(tenant, driverId, existing = null, { reset = false } = {}) {
    if (reset) for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http', 'qq.pmhq']) this.allocator.release(tenant.id, purpose);
    const webui = await this.allocator.allocate(tenant.id, 'qq.webui', {
      preferredPort: existing?.webui_port, host: '127.0.0.1'
    });
    const ob11 = await this.allocator.allocate(tenant.id, 'qq.ob11', {
      preferredPort: existing?.ob11_port, host: '127.0.0.1'
    });
    let http = null;
    if (driverId !== 'llbot') {
      http = await this.allocator.allocate(tenant.id, 'qq.http', {
        preferredPort: existing?.http_port, host: '127.0.0.1'
      });
    }
    return { webuiPort: webui.port, ob11Port: ob11.port, httpPort: http?.port ?? null };
  }

  async prepare(tenant, options = {}) {
    const current = this.account(tenant.id);
    const process = this.supervisor.status(tenant.id, 'qq');
    if (['running', 'starting', 'restarting'].includes(process.state)) {
      throw fail(409, 'QQ_ALREADY_RUNNING', 'QQ 协议端正在运行，请先停止再修改配置');
    }
    const driverId = String(options.driver || current?.driver || 'llbot').toLowerCase();
    const driver = this.driver(driverId);
    if (!driver) throw fail(400, 'UNKNOWN_DRIVER', '未知 QQ 协议端驱动');
    const expectedUin = String(options.uin || options.expectedUin || current?.expected_uin || '').trim();
    if (!/^\d{5,12}$/.test(expectedUin)) throw fail(400, 'INVALID_UIN', '请填写 5-12 位 QQ 号');

    const driverChanged = Boolean(current && current.driver !== driverId);
    const previous = readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {});
    const mode = driverId === 'llbot' ? String(options.mode ?? previous.mode ?? 'direct').toLowerCase() : 'direct';
    if (!['direct', 'desktop'].includes(mode)) throw fail(400, 'INVALID_LLBOT_MODE', 'LLBot 模式必须是 direct 或 desktop');
    const preparedOptions = { ...options };
    let newPmhqLeaseId = null;
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
      const ports = await this.ensurePorts(tenant, driverId, current);
      const tokens = this.tokens(tenant, current, options.authToken);
      const account = {
        tenant_id: tenant.id,
        driver: driverId,
        expected_uin: expectedUin,
        uin: driverChanged ? null : current?.uin || null,
        nickname: driverChanged ? null : current?.nickname || null,
        state: 'prepared',
        webui_port: ports.webuiPort,
        ob11_port: ports.ob11Port,
        http_port: ports.httpPort,
        auth_source: tokens.authSource,
        last_error: null
      };
      prepared = await driver.prepare({ ...this.driverContext(tenant, account, driverId, tokens, driver), options: preparedOptions });
      this.upsertAccount(account);
    } catch (error) {
      if (newPmhqLeaseId) this.allocator.releaseLease(newPmhqLeaseId);
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
      paths: this.paths(tenant, driverId),
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
  }

  updateAccount(tenantId, patch) {
    const current = this.account(tenantId);
    if (!current) return;
    this.upsertAccount({ ...current, ...patch, tenant_id: tenantId });
  }

  async start(tenant) {
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const driver = this.driver(account.driver);
    if (!driver) throw fail(400, 'UNKNOWN_DRIVER', '未知 QQ 协议端驱动');
    const process = this.supervisor.status(tenant.id, 'qq');
    if (['running', 'starting', 'restarting'].includes(process.state)) {
      return this.status(tenant);
    }
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
    await driver.prepare(this.driverContext(tenant, updated, account.driver, tokens, driver));
    this.upsertAccount(updated);
    try {
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
    } catch (error) {
      this.updateAccount(tenant.id, { state: 'failed', last_error: String(error?.message || error) });
      throw error;
    }
    await this.onLinksChanged?.(tenant, { reason: 'qq.start' });
    const desktop = account.driver === 'llbot' && readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode === 'desktop';
    const needsToken = Boolean(driver.capabilities.authToken) && !desktop && !tokens.authToken;
    this.updateAccount(tenant.id, { state: needsToken ? 'auth_required' : 'awaiting_login', last_error: null });
    return this.status(tenant, { probe: true });
  }

  async stop(tenant, { releasePorts = false } = {}) {
    await this.supervisor.stop(tenant.id, 'qq', { force: true });
    if (releasePorts) for (const purpose of ['qq.webui', 'qq.ob11', 'qq.http', 'qq.pmhq']) this.allocator.release(tenant.id, purpose);
    if (this.account(tenant.id)) this.updateAccount(tenant.id, { state: 'prepared' });
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

  async status(tenant, { probe = true } = {}) {
    const account = this.account(tenant.id);
    if (!account) {
      return {
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
    let process = this.supervisor.status(tenant.id, 'qq');
    let probeResult = null;
    if (probe && ['running', 'restarting'].includes(process.state)) {
      try {
        probeResult = await driver.status(this.driverContext(tenant, account, account.driver, this.tokens(tenant, account), driver));
      } catch (error) {
        probeResult = { error: String(error?.message || error), code: 'DRIVER_PROBE_FAILED' };
      }
    }
    let state = account.state;
    let lastError = account.last_error;
    let uin = account.uin;
    let nickname = account.nickname;
    if (probeResult?.uinMismatch) {
      lastError = `实际登录 QQ (${probeResult.uin}) 与配置 (${account.expected_uin}) 不一致，已停止协议端`;
      await this.supervisor.stop(tenant.id, 'qq', { force: true });
      process = this.supervisor.status(tenant.id, 'qq');
      state = 'uin_mismatch';
      probeResult.online = false;
      this.logger?.warn?.('qq uin mismatch', { tenantId: tenant.id, expected: account.expected_uin, actual: probeResult.uin });
    } else if (probeResult?.online) {
      state = 'online';
      uin = probeResult.uin || uin;
      nickname = probeResult.nickname || nickname;
      lastError = null;
    } else if (process.state === 'running') {
      const desktop = account.driver === 'llbot' && readJsonFile(path.join(this.paths(tenant, 'llbot').dir, 'runtime.json'), {}).mode === 'desktop';
      state = !desktop && account.auth_source === 'none' && driver?.capabilities.authToken ? 'auth_required' : 'awaiting_login';
      if (probeResult?.error) lastError = probeResult.error;
    } else if (process.state === 'crashed') {
      state = 'crashed';
    } else if (process.state === 'stopped') {
      state = account.state === 'online' || account.state === 'awaiting_login' ? 'prepared' : account.state;
    }
    if (probeResult?.error && process.state !== 'running') lastError = probeResult.error;
    const authToken = process.state === 'running'
      ? await this.authStatus(tenant)
      : this.localAuthStatus(tenant, account, driver);
    if (authToken.applicable && !authToken.hasToken && process.state === 'running' && state !== 'uin_mismatch') {
      state = 'auth_required';
    }
    const phase = this.panelPhase(state, process.state);
    const authTokenStatus = this.panelAuthTokenStatus(authToken);
    authToken.status = authTokenStatus;
    this.updateAccount(tenant.id, { state, last_error: lastError || null, uin, nickname });
    const online = Boolean(probeResult?.online);
    return {
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
      onebotConnected: online,
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

  async qrcode(tenant) {
    const account = this.account(tenant.id);
    if (!account) throw fail(409, 'QQ_NOT_PREPARED', '请先准备 QQ 协议端配置');
    const process = this.supervisor.status(tenant.id, 'qq');
    if (!['running', 'restarting'].includes(process.state)) {
      throw fail(409, 'QQ_NOT_RUNNING', 'QQ 协议端未运行，请先启动');
    }
    const driver = this.driver(account.driver);
    const tokens = this.tokens(tenant, account);
    const qr = await driver.qrcode(this.driverContext(tenant, account, account.driver, tokens, driver));
    return {
      ...qr,
      driver: account.driver,
      expectedUin: account.expected_uin,
      pollTimeInterval: qr.pollTimeInterval || 3
    };
  }

  async setAuthToken(tenant, token) {
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
    const account = this.account(tenant.id);
    if (!account || account.state === 'unprepared') return null;
    const tokens = this.tokens(tenant, account);
    return {
      enabled: true,
      driver: account.driver,
      apiTransport: account.driver === 'llbot' ? 'ws' : 'http',
      uin: account.uin || account.expected_uin,
      wsUrl: `ws://127.0.0.1:${account.ob11_port}`,
      httpUrl: account.http_port ? `http://127.0.0.1:${account.http_port}` : '',
      accessToken: tokens.onebotToken,
      httpAccessToken: tokens.onebotToken
    };
  }

  logs(tenant, limit = 100) {
    return this.supervisor.logs(tenant.id, 'qq', limit);
  }

  async remove(tenant) {
    await this.stop(tenant, { releasePorts: true });
    this.secrets.delete(tenant.id, 'qq.onebot_token');
    this.secrets.delete(tenant.id, 'qq.webui_password');
    this.secrets.delete(tenant.id, 'qq.auth_token');
    this.db.prepare('DELETE FROM qq_accounts WHERE tenant_id = ?').run(tenant.id);
  }
}
