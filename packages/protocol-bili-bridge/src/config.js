import path from 'node:path';
import { ConfigError } from './errors.js';
import { DEFAULT_ENDPOINTS, DEFAULT_USER_AGENT } from './bili/api.js';
import { clampInt, deepMerge, isPlainObject, parseQuery } from './util.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on|y)$/i.test(String(value).trim());
}

function intValue(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  return clampInt(value, min, max, fallback);
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function envOr(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

export function defaultConfig() {
  return {
    dataDir: path.resolve(process.cwd(), 'var', 'bili-bridge'),
    tenantId: 'default',
    logLevel: 'info',
    endpoints: { ...DEFAULT_ENDPOINTS },
    onebot: {
      host: '127.0.0.1',
      port: 36501,
      path: '/',
      token: '',
      adminToken: '',
      heartbeatIntervalMs: 30_000
    },
    bili: {
      timeoutMs: 15_000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxCoverBytes: 5 * 1024 * 1024,
      forceHttps: true,
      userAgent: DEFAULT_USER_AGENT
    },
    poll: {
      msgfeedIntervalMs: 15_000,
      msgfeedJitterMs: 2_500,
      commentIntervalMs: 15_000,
      commentJitterMs: 3_000,
      dmIntervalMs: 15_000,
      dmJitterMs: 3_000,
      upIntervalMs: 120_000,
      upJitterMs: 15_000,
      cookieCheckIntervalMs: 6 * 60 * 60 * 1000,
      cookieCheckJitterMs: 5 * 60 * 1000,
      liveStatusIntervalMs: 60_000
    },
    watch: {
      videos: [],
      ups: [],
      liveRooms: []
    },
    subscriptions: {
      at: true,
      up: true,
      dm: true,
      live: true
    },
    comment: {
      maxChars: 1000,
      outboundMinIntervalMs: 15_000,
      outboundJitterMs: 3_000
    },
    dm: {
      maxBytes: 2000,
      outboundMinIntervalMs: 5_000,
      outboundJitterMs: 1_000
    },
    live: {
      heartbeatIntervalMs: 30_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 30_000,
      authTimeoutMs: 15_000,
      hostFailover: true,
      wsProtocol: 'wss',
      outboundMinIntervalMs: 3_000,
      outboundJitterMs: 1_000,
      filter: {
        danmaku: 'mentions',
        keywords: [],
        gifts: true,
        superChat: true,
        guard: true
      }
    },
    store: {
      messageCapacity: 500,
      dedupeCapacity: 5000
    },
    security: {
      allowRemoteWithoutToken: false,
      secretPassphrase: '',
      secretKey: ''
    }
  };
}

function fromEnv(env) {
  if (!env || typeof env !== 'object') return {};
  return {
    dataDir: envOr(env.BILI_BRIDGE_DATA_DIR, undefined),
    tenantId: envOr(env.BILI_BRIDGE_TENANT, undefined),
    logLevel: envOr(env.BILI_BRIDGE_LOG_LEVEL, undefined),
    endpoints: {
      passport: envOr(env.BILI_ENDPOINT_PASSPORT, undefined),
      api: envOr(env.BILI_ENDPOINT_API, undefined),
      web: envOr(env.BILI_ENDPOINT_WEB, undefined),
      live: envOr(env.BILI_ENDPOINT_LIVE, undefined),
      vc: envOr(env.BILI_ENDPOINT_VC, undefined),
      subtitle: envOr(env.BILI_ENDPOINT_SUBTITLE, undefined)
    },
    onebot: {
      host: envOr(env.BILI_ONEBOT_HOST, undefined),
      port: envOr(env.BILI_ONEBOT_PORT, undefined),
      path: envOr(env.BILI_ONEBOT_WS_PATH, undefined),
      token: envOr(env.BILI_ONEBOT_TOKEN, undefined),
      adminToken: envOr(env.BILI_ADMIN_TOKEN, undefined),
      heartbeatIntervalMs: envOr(env.BILI_ONEBOT_HEARTBEAT_MS, undefined)
    },
    bili: {
      timeoutMs: envOr(env.BILI_HTTP_TIMEOUT_MS, undefined),
      maxResponseBytes: envOr(env.BILI_MAX_RESPONSE_BYTES, undefined),
      maxCoverBytes: envOr(env.BILI_MAX_COVER_BYTES, undefined),
      forceHttps: envOr(env.BILI_FORCE_HTTPS, undefined)
    },
    watch: {
      videos: envOr(env.BILI_WATCH_VIDEOS, undefined),
      ups: envOr(env.BILI_WATCH_UPS, undefined),
      liveRooms: envOr(env.BILI_WATCH_LIVE_ROOMS, undefined)
    },
    subscriptions: {
      at: envOr(env.BILI_SUBSCRIBE_AT, undefined),
      up: envOr(env.BILI_SUBSCRIBE_UP, undefined),
      dm: envOr(env.BILI_SUBSCRIBE_DM, undefined),
      live: envOr(env.BILI_SUBSCRIBE_LIVE, undefined)
    },
    live: {
      filter: {
        keywords: envOr(env.BILI_LIVE_KEYWORDS, undefined)
      }
    },
    security: {
      allowRemoteWithoutToken: envOr(env.BILI_ALLOW_REMOTE_WITHOUT_TOKEN, undefined),
      secretPassphrase: envOr(env.BILI_SECRET_PASSPHRASE, undefined),
      secretKey: envOr(env.BILI_SECRET_KEY, undefined)
    }
  };
}

function cleanObject(value) {
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = cleanObject(item);
  }
  return out;
}

function validateEndpoint(name, value) {
  const url = String(value || '');
  if (!/^https?:\/\/[^\s]+$/i.test(url) || url.includes('@')) {
    throw new ConfigError(`B 站接口基址 ${name} 无效: ${url}`, { details: { endpoint: name } });
  }
  return url.replace(/\/+$/, '');
}

export function loadConfig({ env = process.env, overrides = {} } = {}) {
  const merged = deepMerge(defaultConfig(), cleanObject(fromEnv(env)));
  const config = deepMerge(merged, cleanObject(overrides));

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(config.tenantId))) {
    throw new ConfigError('tenantId 只能包含字母、数字、下划线和连字符，最长 64');
  }
  config.dataDir = path.resolve(String(config.dataDir));
  config.onebot.port = intValue(config.onebot.port, 36501, 0, 65535);
  config.onebot.host = String(config.onebot.host || '127.0.0.1');
  config.onebot.path = String(config.onebot.path || '/');
  if (!config.onebot.path.startsWith('/')) config.onebot.path = `/${config.onebot.path}`;
  config.onebot.token = String(config.onebot.token || '');
  config.onebot.adminToken = String(config.onebot.adminToken || '');
  config.onebot.heartbeatIntervalMs = intValue(config.onebot.heartbeatIntervalMs, 30_000, 1_000, 10 * 60_000);

  for (const service of Object.keys(DEFAULT_ENDPOINTS)) {
    config.endpoints[service] = validateEndpoint(service, config.endpoints[service]);
  }

  config.bili.timeoutMs = intValue(config.bili.timeoutMs, 15_000, 500, 120_000);
  config.bili.maxResponseBytes = intValue(config.bili.maxResponseBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
  config.bili.maxCoverBytes = intValue(config.bili.maxCoverBytes, 5 * 1024 * 1024, 1024, 32 * 1024 * 1024);
  config.bili.forceHttps = boolValue(config.bili.forceHttps, true);

  config.watch.videos = [...new Set(listValue(config.watch.videos))];
  config.watch.ups = [...new Set(listValue(config.watch.ups).map((mid) => String(mid)))];
  config.watch.liveRooms = [...new Set(listValue(config.watch.liveRooms).map((room) => String(room)))];
  for (const [key, fallback] of Object.entries({ at: true, up: true, dm: true, live: true })) {
    config.subscriptions[key] = boolValue(config.subscriptions[key], fallback);
  }

  config.poll.commentIntervalMs = intValue(config.poll.commentIntervalMs, 15_000, 50, 24 * 60 * 60 * 1000);
  config.poll.commentJitterMs = intValue(config.poll.commentJitterMs, 3_000, 0, 60_000);
  config.poll.msgfeedIntervalMs = intValue(config.poll.msgfeedIntervalMs, 15_000, 50, 24 * 60 * 60 * 1000);
  config.poll.msgfeedJitterMs = intValue(config.poll.msgfeedJitterMs, 2_500, 0, 60_000);
  config.poll.dmIntervalMs = intValue(config.poll.dmIntervalMs, 15_000, 50, 24 * 60 * 60 * 1000);
  config.poll.dmJitterMs = intValue(config.poll.dmJitterMs, 3_000, 0, 60_000);
  config.poll.upIntervalMs = intValue(config.poll.upIntervalMs, 120_000, 1000, 24 * 60 * 60 * 1000);
  config.poll.upJitterMs = intValue(config.poll.upJitterMs, 15_000, 0, 5 * 60_000);
  config.poll.cookieCheckIntervalMs = intValue(config.poll.cookieCheckIntervalMs, 6 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000);
  config.poll.cookieCheckJitterMs = intValue(config.poll.cookieCheckJitterMs, 5 * 60 * 1000, 0, 60 * 60 * 1000);
  config.poll.liveStatusIntervalMs = intValue(config.poll.liveStatusIntervalMs, 60_000, 5_000, 24 * 60 * 60 * 1000);

  config.comment.maxChars = intValue(config.comment.maxChars, 1000, 20, 2000);
  config.comment.outboundMinIntervalMs = intValue(config.comment.outboundMinIntervalMs, 15_000, 100, 60 * 60 * 1000);
  config.comment.outboundJitterMs = intValue(config.comment.outboundJitterMs, 3_000, 0, 60_000);
  config.dm.maxBytes = intValue(config.dm.maxBytes, 2000, 100, 10_000);
  config.dm.outboundMinIntervalMs = intValue(config.dm.outboundMinIntervalMs, 5_000, 100, 60 * 60 * 1000);
  config.dm.outboundJitterMs = intValue(config.dm.outboundJitterMs, 1_000, 0, 60_000);
  config.live.heartbeatIntervalMs = intValue(config.live.heartbeatIntervalMs, 30_000, 1_000, 5 * 60_000);
  config.live.reconnectMinMs = intValue(config.live.reconnectMinMs, 1_000, 100, 60_000);
  config.live.reconnectMaxMs = intValue(config.live.reconnectMaxMs, 30_000, 1_000, 10 * 60_000);
  config.live.authTimeoutMs = intValue(config.live.authTimeoutMs, 15_000, 1_000, 60_000);
  config.live.wsProtocol = config.live.wsProtocol === 'ws' ? 'ws' : 'wss';
  config.live.outboundMinIntervalMs = intValue(config.live.outboundMinIntervalMs, 3_000, 100, 60 * 60 * 1000);
  config.live.outboundJitterMs = intValue(config.live.outboundJitterMs, 1_000, 0, 60_000);
  config.live.filter.keywords = listValue(config.live.filter.keywords);
  config.live.filter.danmaku = ['all', 'mentions', 'off'].includes(String(config.live.filter.danmaku))
    ? String(config.live.filter.danmaku)
    : 'mentions';

  config.store.messageCapacity = intValue(config.store.messageCapacity, 500, 10, 10_000);
  config.store.dedupeCapacity = intValue(config.store.dedupeCapacity, 5000, 100, 200_000);

  const remote = !LOOPBACK_HOSTS.has(config.onebot.host);
  if (remote && !config.onebot.token && !config.security.allowRemoteWithoutToken) {
    throw new ConfigError('OneBot 绑定到非回环地址时必须配置 BILI_ONEBOT_TOKEN');
  }
  if (remote && !config.onebot.adminToken) {
    throw new ConfigError('OneBot 绑定到非回环地址时必须配置 BILI_ADMIN_TOKEN');
  }
  if (config.onebot.adminToken && config.onebot.adminToken.length < 12) {
    throw new ConfigError('BILI_ADMIN_TOKEN 至少 12 个字符');
  }
  if (config.onebot.token && config.onebot.adminToken && config.onebot.token === config.onebot.adminToken) {
    throw new ConfigError('BILI_ONEBOT_TOKEN 与 BILI_ADMIN_TOKEN 必须不同');
  }
  if (config.onebot.token && config.onebot.token.length < 8) {
    throw new ConfigError('BILI_ONEBOT_TOKEN 至少 8 个字符');
  }
  return config;
}

export function parseCommaList(value) {
  return listValue(value);
}

export function subscriptionFlagsFromQuery(url) {
  const query = parseQuery(url);
  const out = {};
  for (const key of ['at', 'up', 'dm', 'live']) {
    if (query[key] !== undefined) out[key] = boolValue(query[key], false);
  }
  return out;
}
