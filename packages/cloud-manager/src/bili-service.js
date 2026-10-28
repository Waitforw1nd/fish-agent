import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { randomToken, deepMerge, readJsonFile, writeJsonPrivate, ensureDir } from './util.js';
import { requestJson } from './qq/common.js';

const DEFAULT_CONFIG = {
  enabled: true,
  subscriptions: {
    mentions: true,
    upVideos: true,
    privateMessages: true,
    liveRoom: false
  },
  upMids: [],
  videos: [],
  liveRoomIds: [],
  liveRoomId: null,
  pollIntervalMs: 30_000,
  commentIntervalMs: 15_000,
  mentionKeywords: [],
  replyKeywords: []
};

const SECRET_KEY_RE = /(cookie|token|password|secret|sessdata|bili_jct|auth)/i;

function fail(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function sanitizeConfig(input, depth = 0) {
  if (depth > 3) throw fail(400, 'BILI_CONFIG_TOO_DEEP', 'B站配置层级过深');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_BILI_CONFIG', 'B站配置必须是对象');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail(400, 'INVALID_BILI_CONFIG', '配置包含非法键');
    if (SECRET_KEY_RE.test(key)) throw fail(400, 'BILI_SECRET_REJECTED', 'B站 Cookie/Token 只能由桥接服务管理，不能通过配置接口写入');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    } else if (Array.isArray(value)) {
      if (value.length > 100) throw fail(400, 'BILI_CONFIG_TOO_LARGE', '配置数组过长');
      out[key] = value.slice(0, 100).map((entry) => {
        if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) return entry;
        if (typeof entry === 'object') return sanitizeConfig(entry, depth + 1);
        throw fail(400, 'INVALID_BILI_CONFIG', '配置包含不支持的值');
      });
    } else if (typeof value === 'object') {
      out[key] = sanitizeConfig(value, depth + 1);
    }
  }
  return out;
}

function normalizeConfig(config) {
  const merged = deepMerge(DEFAULT_CONFIG, config || {});
  merged.enabled = merged.enabled !== false;
  const sub = merged.subscriptions || {};
  merged.subscriptions = {
    mentions: sub.mentions !== false,
    upVideos: sub.upVideos !== false,
    privateMessages: sub.privateMessages !== false,
    liveRoom: sub.liveRoom === true || sub.liveRooms === true || sub.live === true
  };
  merged.upMids = [...new Set((Array.isArray(merged.upMids) ? merged.upMids : [])
    .map((value) => String(value).trim()).filter((value) => /^\d{1,20}$/.test(value)))].slice(0, 50);
  merged.videos = [...new Set((Array.isArray(merged.videos) ? merged.videos : []).map((value) => String(value).trim()).filter((value) => /^(?:BV[0-9A-Za-z]{10}|av\d+|\d+)$/.test(value)))].slice(0, 50);
  merged.liveRoomIds = [...new Set((Array.isArray(merged.liveRoomIds) ? merged.liveRoomIds : [])
    .map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, 20);
  merged.liveRoomId = Number.isSafeInteger(Number(merged.liveRoomId)) && Number(merged.liveRoomId) > 0
    ? Number(merged.liveRoomId) : null;
  merged.pollIntervalMs = Math.min(600_000, Math.max(10_000, Number(merged.pollIntervalMs) || 30_000));
  merged.commentIntervalMs = Math.max(15_000, Number(merged.commentIntervalMs) || 15_000);
  merged.mentionKeywords = (Array.isArray(merged.mentionKeywords) ? merged.mentionKeywords : [])
    .map((value) => String(value).slice(0, 100)).slice(0, 50);
  merged.replyKeywords = (Array.isArray(merged.replyKeywords) ? merged.replyKeywords : [])
    .map((value) => String(value).slice(0, 100)).slice(0, 50);
  return merged;
}

function bridgeSubscriptions(config) {
  if (config.enabled === false) return { at: false, up: false, dm: false, live: false };
  return {
    at: config.subscriptions.mentions,
    up: config.subscriptions.upVideos,
    dm: config.subscriptions.privateMessages,
    live: config.subscriptions.liveRoom
  };
}

function bridgeWatches(config) {
  const liveRooms = [...new Set([
    ...config.liveRoomIds.map(String),
    ...(config.liveRoomId ? [String(config.liveRoomId)] : [])
  ])];
  return { videos: config.videos, ups: config.upMids.map(String), liveRooms };
}

function panelSubscriptions(bridge = {}) {
  return {
    mentions: bridge.at !== false,
    upVideos: bridge.up !== false,
    privateMessages: bridge.dm !== false,
    liveRoom: bridge.live === true
  };
}

function qrPhase(state) {
  const text = String(state || '').toLowerCase();
  if (text === 'pending' || text === 'waiting') return 'waiting';
  if (text === 'scanned') return 'scanned';
  if (text === 'success' || text === 'confirmed') return 'confirmed';
  if (text === 'expired') return 'expired';
  return 'unknown';
}

async function renderQrDataUrl(url) {
  if (!url) return '';
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  } catch {
    return '';
  }
}

export class BiliService {
  constructor({ db, config, allocator, supervisor, secrets, logger }) {
    this.db = db;
    this.config = config;
    this.allocator = allocator;
    this.supervisor = supervisor;
    this.secrets = secrets;
    this.logger = logger;
    this.onLinksChanged = null;
  }

  row(tenantId) {
    return this.db.prepare('SELECT * FROM bili_config WHERE tenant_id = ?').get(tenantId) || null;
  }

  getConfig(tenant) {
    const row = this.row(tenant.id);
    return normalizeConfig(row ? JSON.parse(row.config_json) : DEFAULT_CONFIG);
  }

  adminToken(tenant) {
    let token = this.secrets.get(tenant.id, 'bili.control_token', '');
    if (!token) {
      token = randomToken(24);
      this.secrets.set(tenant.id, 'bili.control_token', token);
    }
    return token;
  }

  onebotToken(tenant) {
    let token = this.secrets.get(tenant.id, 'bili.onebot_token', '');
    if (!token) {
      token = randomToken(24);
      this.secrets.set(tenant.id, 'bili.onebot_token', token);
    }
    return token;
  }

  localConfigPath(tenant) { return path.join(tenant.data_dir, 'bili', 'config.json'); }

  ob11Port(tenant) {
    return this.allocator.find(tenant.id, 'bili.ob11')?.port || null;
  }

  baseUrl(tenant) {
    const port = this.ob11Port(tenant);
    return port ? `http://127.0.0.1:${port}` : null;
  }

  async ensurePrepared(tenant) {
    this.allocator.release(tenant.id, 'bili.control');
    let row = this.row(tenant.id);
    if (!row) {
      const ob11 = await this.allocator.allocate(tenant.id, 'bili.ob11', { host: '127.0.0.1' });
      const config = normalizeConfig(DEFAULT_CONFIG);
      this.db.prepare(`
        INSERT INTO bili_config (tenant_id, config_json, control_port, updated_at) VALUES (?, ?, ?, ?)
      `).run(tenant.id, JSON.stringify(config), ob11.port, Date.now());
      row = this.row(tenant.id);
    }
    const ob11 = this.allocator.find(tenant.id, 'bili.ob11')
      || await this.allocator.allocate(tenant.id, 'bili.ob11', { preferredPort: row.control_port, host: '127.0.0.1' });
    if (Number(row.control_port) !== ob11.port) {
      this.db.prepare('UPDATE bili_config SET control_port = ?, updated_at = ? WHERE tenant_id = ?')
        .run(ob11.port, Date.now(), tenant.id);
      row = this.row(tenant.id);
    }
    ensureDir(path.join(tenant.data_dir, 'bili'), 0o700);
    return { row, ob11Port: ob11.port };
  }

  async writeBridgeConfig(tenant, prepared = null) {
    const current = prepared || await this.ensurePrepared(tenant);
    const payload = {
      config: this.getConfig(tenant),
      onebot: {
        host: '127.0.0.1',
        port: current.ob11Port
      },
      admin: {
        host: '127.0.0.1',
        port: current.ob11Port
      }
    };
    writeJsonPrivate(this.localConfigPath(tenant), payload, 0o600);
    return payload;
  }

  controlUrl(tenant, pathname) {
    const base = this.baseUrl(tenant);
    if (!base) throw fail(409, 'BILI_NOT_PREPARED', 'B站桥接尚未配置');
    return `${base}${pathname}`;
  }

  async control(tenant, pathname, { method = 'GET', body = null, timeoutMs = 10_000 } = {}) {
    if (!this.row(tenant.id)) throw fail(409, 'BILI_NOT_PREPARED', 'B站桥接尚未配置');
    try {
      const response = await requestJson(this.controlUrl(tenant, pathname), {
        method,
        headers: { 'x-admin-token': this.adminToken(tenant) },
        body,
        timeoutMs
      });
      if (response.status === 401 || response.status === 403) {
        throw fail(502, 'BILI_ADMIN_AUTH_FAILED', 'B站桥接管理令牌校验失败');
      }
      const payload = response.body?.data ?? response.body;
      if (response.status >= 400 || response.body?.ok === false) {
        const message = response.body?.error?.wording
          || response.body?.error?.message
          || response.body?.message
          || `B站桥接返回 HTTP ${response.status}`;
        throw fail(response.status === 404 ? 404 : 502, 'BILI_BRIDGE_ERROR', message);
      }
      return payload;
    } catch (error) {
      if (error.status) throw error;
      throw fail(502, 'BILI_BRIDGE_UNREACHABLE', `无法连接 B站桥接: ${error?.message || error}`);
    }
  }

  bridgeEnv(tenant, prepared) {
    const config = this.getConfig(tenant);
    const subs = bridgeSubscriptions(config);
    const watches = bridgeWatches(config);
    const env = {
      BILI_BRIDGE_DATA_DIR: path.join(tenant.data_dir, 'bili', 'data'),
      BILI_CLOUD_CONFIG_FILE: this.localConfigPath(tenant),
      BILI_WATCH_LIFECYCLE_FILE: path.join(tenant.data_dir, 'data', 'bili-watch', 'lifecycle.json'),
      BILI_BRIDGE_TENANT: tenant.id,
      BILI_BRIDGE_LOG_LEVEL: 'info',
      BILI_HTTP_TIMEOUT_MS: '8000',
      BILI_ONEBOT_HOST: '127.0.0.1',
      BILI_ONEBOT_PORT: String(prepared.ob11Port),
      BILI_ONEBOT_TOKEN: this.onebotToken(tenant),
      BILI_ADMIN_TOKEN: this.adminToken(tenant),
      BILI_SUBSCRIBE_AT: String(subs.at),
      BILI_SUBSCRIBE_UP: String(subs.up),
      BILI_SUBSCRIBE_DM: String(subs.dm),
      BILI_SUBSCRIBE_LIVE: String(subs.live),
      BILI_WATCH_VIDEOS: watches.videos.join(','),
      BILI_WATCH_UPS: watches.ups.join(','),
      BILI_WATCH_LIVE_ROOMS: watches.liveRooms.join(','),
      BILI_LIVE_KEYWORDS: config.mentionKeywords.join(',')
    };
    return env;
  }

  async pushConfig(tenant) {
    const config = this.getConfig(tenant);
    await this.control(tenant, '/admin/subscriptions', { method: 'PUT', body: bridgeSubscriptions(config) });
    await this.control(tenant, '/admin/watches', { method: 'PUT', body: bridgeWatches(config) });
    return config;
  }

  async start(tenant) {
    const prepared = await this.ensurePrepared(tenant);
    const process = this.supervisor.status(tenant.id, 'bili');
    if (['running', 'starting', 'restarting'].includes(process.state)) return this.status(tenant);
    if (!fs.existsSync(this.config.biliEntry)) {
      throw fail(503, 'BILI_BRIDGE_MISSING', 'B站桥接入口不存在，请先构建 protocol-bili-bridge 或配置 CLOUD_BILI_BRIDGE_ENTRY');
    }
    await this.writeBridgeConfig(tenant, prepared);
    await this.supervisor.start({
      tenantId: tenant.id,
      kind: 'bili',
      command: this.config.nodePath,
      args: [this.config.biliEntry],
      cwd: path.join(tenant.data_dir, 'bili', 'data'),
      env: this.bridgeEnv(tenant, prepared),
      logFile: path.join(this.config.logDir, 'tenants', `${tenant.id}.bili.log`),
      ready: { host: '127.0.0.1', port: prepared.ob11Port, timeoutMs: this.config.processStartTimeoutMs },
      restart: true
    });
    try {
      await this.pushConfig(tenant);
    } catch (error) {
      this.logger?.warn?.('bili config push failed', { tenantId: tenant.id, error: error.message });
    }
    await this.onLinksChanged?.(tenant, { reason: 'bili.start' });
    return this.status(tenant);
  }

  async stop(tenant, { releasePorts = false } = {}) {
    await this.supervisor.stop(tenant.id, 'bili', { force: true });
    if (releasePorts) {
      this.allocator.release(tenant.id, 'bili.ob11');
      this.allocator.release(tenant.id, 'bili.control');
    }
    return this.status(tenant);
  }

  async ensureStarted(tenant) {
    const process = this.supervisor.status(tenant.id, 'bili');
    if (!['running', 'starting', 'restarting'].includes(process.state)) await this.start(tenant);
  }

  mapPollers(admin) {
    const pollers = admin?.pollers || {};
    const watchers = admin?.watchers || {};
    const subs = admin?.subscriptions || {};
    const map = (subKey, names) => {
      const entries = names.map((name) => pollers[name]).filter(Boolean);
      return {
        enabled: subs[subKey] !== false,
        lastPollAt: entries.map((entry) => entry.lastRunAt).filter(Boolean).sort().pop() || null,
        lastError: entries.map((entry) => entry.lastError).filter(Boolean).pop() || null
      };
    };
    return {
      mentions: map('at', ['msgfeed', 'comment']),
      upVideos: map('up', ['up']),
      privateMessages: map('dm', ['dm']),
      liveRoom: {
        enabled: subs.live === true,
        lastPollAt: admin?.live?.lastConnectAt || null,
        lastError: admin?.liveSyncError || watchers.live?.lastError || null
      }
    };
  }

  async status(tenant) {
    const row = this.row(tenant.id);
    const process = this.supervisor.status(tenant.id, 'bili');
    const config = row ? this.getConfig(tenant) : null;
    const result = {
      prepared: Boolean(row),
      enabled: config ? config.enabled : false,
      state: row ? (process.state === 'stopped' ? 'stopped' : process.state) : 'unprepared',
      phase: 'offline',
      online: false,
      mid: null,
      nickname: null,
      avatar: null,
      cookieHealthy: false,
      cookieStatus: 'missing',
      cookieKeepalive: null,
      login: { state: 'unknown' },
      subscriptions: config?.subscriptions || null,
      pollers: null,
      lastPollAt: null,
      rateLimited: false,
      liveConnected: false,
      lastError: process.lastError || null,
      error: process.lastError || null,
      message: '',
      process: {
        state: process.state,
        pid: process.pid,
        restarts: process.restarts || 0,
        startedAt: process.startedAt || null
      },
      ports: {
        control: row?.control_port ?? null,
        ob11: this.ob11Port(tenant)
      },
      config
    };
    if (row && ['running', 'restarting'].includes(process.state)) {
      try {
        const admin = await this.control(tenant, '/admin/status', { timeoutMs: 4000 });
        const bili = admin?.bili || {};
        const account = bili.account || admin?.self || {};
        const subs = panelSubscriptions(admin?.subscriptions || bridgeSubscriptions(config));
        result.watcherActive = admin?.watcherActive !== false;
        result.online = Boolean(bili.loggedIn);
        result.mid = account.mid || admin?.self?.mid || null;
        result.nickname = account.name || admin?.self?.name || null;
        result.avatar = account.avatar || null;
        result.cookieKeepalive = admin?.cookies || null;
        result.cookieHealthy = Boolean(bili.loggedIn);
        result.cookieStatus = bili.loggedIn ? 'healthy' : 'missing';
        result.login = {
          state: bili.qr?.state || (bili.loggedIn ? 'success' : 'unknown'),
          message: bili.qr?.message || ''
        };
        result.subscriptions = subs;
        result.pollers = this.mapPollers(admin);
        result.rateLimited = Boolean(admin?.queues?.comment?.lastError || admin?.risk?.limited);
        result.liveConnected = Object.keys(admin?.liveStatus || {}).length > 0;
        result.lastError = bili.lastError || admin?.liveSyncError || null;
        result.error = result.lastError;
        result.watcherReason = admin?.watcher?.reason || null;
        result.message = result.watcherActive ? (bili.qr?.message || '') : 'B站 watcher 已停用，订阅轮询已暂停；请在扩展设置中启用 bili-watcher。';
        if (!result.watcherActive && !result.error) result.error = result.message;
        result.api = admin?.api || null;
        const times = Object.values(result.pollers || {}).map((entry) => Number(entry.lastPollAt)).filter(Number.isFinite);
        if (times.length) result.lastPollAt = Math.max(...times);
        if (result.online) result.phase = 'online';
        else if (qrPhase(bili.qr?.state) === 'scanned') result.phase = 'scanned';
        else if (qrPhase(bili.qr?.state) === 'waiting') result.phase = 'waiting';
        else if (['crashed', 'failed'].includes(process.state) || bili.lastError) result.phase = 'error';
        else result.phase = 'offline';
      } catch (error) {
        result.lastError = error.message;
        result.error = error.message;
      }
    }
    return result;
  }

  async loginQr(tenant) {
    await this.ensureStarted(tenant);
    const payload = await this.control(tenant, '/admin/login/qr', { method: 'POST', timeoutMs: 20_000 });
    const state = payload?.state || 'pending';
    const expiresAt = Number(payload?.expiresAt) || Date.now() + 180_000;
    const qrcodeUrl = payload?.url || '';
    const pngBase64 = await renderQrDataUrl(qrcodeUrl);
    const phase = qrPhase(state);
    return {
      state: phase === 'waiting' ? 'waiting' : state,
      status: phase,
      qrcodeUrl,
      content: qrcodeUrl,
      pngBase64,
      imageDataUrl: pngBase64,
      imageUrl: pngBase64,
      url: qrcodeUrl,
      expireAt: expiresAt,
      expiresAt,
      expireTime: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
      message: payload?.message || ''
    };
  }

  async loginStatus(tenant) {
    const process = this.supervisor.status(tenant.id, 'bili');
    if (!['running', 'restarting'].includes(process.state)) {
      return { state: 'stopped', status: 'unknown', online: false, message: 'B站桥接未运行' };
    }
    let payload = null;
    try {
      payload = await this.control(tenant, '/admin/login/qr', { timeoutMs: 5000 });
    } catch (error) {
      if (error.status === 404) {
        const admin = await this.control(tenant, '/admin/status', { timeoutMs: 5000 }).catch(() => null);
        const account = admin?.bili?.account || admin?.self || {};
        if (admin?.bili?.loggedIn) {
          return { state: 'success', status: 'confirmed', online: true, mid: account.mid || null, nickname: account.name || null, message: '' };
        }
      }
      return { state: 'unknown', status: 'unknown', online: false, message: error.message };
    }
    const phase = qrPhase(payload?.state);
    const account = payload?.account || payload?.bili?.account || {};
    const stateLabel = phase === 'waiting' ? 'waiting'
      : phase === 'scanned' ? 'scanned'
        : phase === 'confirmed' ? 'success'
          : phase === 'expired' ? 'expired' : 'unknown';
    return {
      state: stateLabel,
      status: phase,
      online: phase === 'confirmed' || Boolean(account.mid),
      mid: account.mid || account.user_id || null,
      nickname: account.name || account.uname || account.nickname || null,
      message: payload?.message || '',
      expireAt: payload?.expiresAt || null,
      expiresAt: payload?.expiresAt || null,
      lastError: payload?.lastError || null
    };
  }

  async updateConfig(tenant, patch) {
    const sanitized = sanitizeConfig(patch);
    const prepared = await this.ensurePrepared(tenant);
    const next = normalizeConfig(deepMerge(this.getConfig(tenant), sanitized));
    this.db.prepare('UPDATE bili_config SET config_json = ?, updated_at = ? WHERE tenant_id = ?')
      .run(JSON.stringify(next), Date.now(), tenant.id);
    await this.writeBridgeConfig(tenant, prepared);
    const process = this.supervisor.status(tenant.id, 'bili');
    let appliedLive = false;
    let warning = null;
    if (['running', 'restarting'].includes(process.state)) {
      try {
        await this.pushConfig(tenant);
        appliedLive = true;
      } catch (error) {
        warning = error.message;
        this.logger?.warn?.('bili config live apply failed', { tenantId: tenant.id, error: error.message });
      }
    }
    await this.onLinksChanged?.(tenant, { reason: 'bili.config' });
    return { config: next, appliedLive, warning };
  }

  async logout(tenant) {
    const process = this.supervisor.status(tenant.id, 'bili');
    if (['running', 'restarting'].includes(process.state)) {
      await this.control(tenant, '/admin/logout', { method: 'POST', timeoutMs: 8000 });
    }
    return this.status(tenant);
  }

  async describeChannels(tenant) {
    const row = this.row(tenant.id);
    if (!row) return null;
    const config = this.getConfig(tenant);
    const port = this.ob11Port(tenant);
    if (!port) return { enabled: false };
    return {
      enabled: Boolean(config.enabled),
      wsUrl: `ws://127.0.0.1:${port}`,
      httpUrl: `http://127.0.0.1:${port}`,
      accessToken: this.onebotToken(tenant),
      httpAccessToken: this.onebotToken(tenant)
    };
  }

  logs(tenant, limit = 100) {
    return this.supervisor.logs(tenant.id, 'bili', limit);
  }

  async remove(tenant) {
    await this.stop(tenant, { releasePorts: true });
    this.db.prepare('DELETE FROM bili_config WHERE tenant_id = ?').run(tenant.id);
    this.secrets.delete(tenant.id, 'bili.control_token');
    this.secrets.delete(tenant.id, 'bili.onebot_token');
  }
}
