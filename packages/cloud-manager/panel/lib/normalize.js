// 后端响应归一化层：容忍直接对象、{ok,data}、{tenant}、{qq}/{bili}/{relay} 等常见包装。
// 只挑选明确字段输出，绝不把服务端原始秘密对象透传给视图。

import { expiryInfo, maskSecret, parseDate, safeImageSrc } from './format.js';

export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getPath(source, path) {
  if (!source || !path) return undefined;
  let cursor = source;
  for (const key of String(path).split('.')) {
    if (!isObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

export function first(source, keys, fallback = undefined) {
  if (!isObject(source)) return fallback;
  for (const key of keys) {
    const value = key.includes('.') ? getPath(source, key) : source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value.replace(/,/g, ''));
    return Number.isFinite(num) ? num : fallback;
  }
  return fallback;
}

export function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled', 'active', 'running', 'online', 'ok', 'healthy'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', 'disabled', 'inactive', 'stopped', 'offline', 'error'].includes(text)) return false;
  }
  return fallback;
}

export function toObject(value) {
  return isObject(value) ? value : {};
}

function unwrapKey(source, key) {
  if (!isObject(source)) return source;
  const nested = source[key];
  return isObject(nested) ? nested : source;
}

export function normalizeMe(payload) {
  const root = toObject(payload);
  const user = toObject(root.user || root.me || root.account || root);
  const roles = asArray(user.roles).map((item) => asString(item)).filter(Boolean);
  return {
    id: asString(user.id ?? user.userId ?? user.uid),
    username: asString(user.username ?? user.name ?? user.login ?? user.email, '未知用户'),
    displayName: asString(user.displayName ?? user.nickname ?? user.name ?? user.username, ''),
    role: asString(user.role ?? (roles[0] || ''), 'user'),
    roles,
    permissions: asArray(user.permissions).map((item) => asString(item)).filter(Boolean)
  };
}

const TENANT_STATUS_LABELS = {
  running: '运行中',
  stopped: '已停止',
  starting: '启动中',
  stopping: '停止中',
  provisioning: '部署中',
  expired: '已到期',
  error: '异常',
  unknown: '未知'
};

const TENANT_STATUS_TONES = {
  running: 'ok',
  stopped: 'neutral',
  starting: 'info',
  stopping: 'info',
  provisioning: 'info',
  expired: 'danger',
  error: 'danger',
  unknown: 'neutral'
};

export function normalizeTenantStatus(raw, { running, expired } = {}) {
  if (expired) return 'expired';
  const text = asString(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['running', 'active', 'online', 'started', 'healthy', '运行中', '在线'].includes(text)) return 'running';
  if (['starting', 'booting', 'launching', '启动中', '部署中'].includes(text)) return 'starting';
  if (['stopping', '停止中'].includes(text)) return 'stopping';
  if (['provisioning', 'pending', 'creating', '部署中'].includes(text)) return 'provisioning';
  if (['expired', 'suspended', '已到期', '过期'].includes(text)) return 'expired';
  if (['error', 'failed', 'crashed', '异常', '失败'].includes(text)) return 'error';
  if (['stopped', 'inactive', 'offline', 'idle', '未启动', '已停止'].includes(text)) return 'stopped';
  if (typeof running === 'boolean') return running ? 'running' : 'stopped';
  return text ? 'unknown' : 'unknown';
}

export function normalizeTenant(value, { now = Date.now() } = {}) {
  const root = toObject(value);
  const tenantSource = toObject(root.tenant || root);
  const expiresRaw = first(tenantSource, [
    'expiresAt', 'expireAt', 'expires', 'expiredAt', 'validUntil', 'subscriptionExpiresAt', 'planExpiresAt'
  ]);
  const expiry = expiryInfo(expiresRaw, now);
  const runningRaw = first(tenantSource, ['running', 'active', 'isRunning', 'processRunning']);
  const statusRaw = first(tenantSource, ['status', 'state', 'phase', 'lifecycle']);
  const status = normalizeTenantStatus(statusRaw, {
    running: runningRaw === undefined ? undefined : asBool(runningRaw),
    expired: expiry.state === 'expired'
  });
  const planSource = tenantSource.plan ?? tenantSource.package ?? tenantSource.planName;
  const plan = isObject(planSource)
    ? {
        id: asString(planSource.id ?? planSource.code),
        name: asString(planSource.name ?? planSource.title ?? planSource.label, '自定义套餐')
      }
    : { id: '', name: asString(planSource, '默认套餐') };
  const qq = normalizeQQStatus(tenantSource.qq ?? tenantSource.qqStatus ?? tenantSource.hosting?.qq ?? tenantSource.services?.qq);
  const bili = normalizeBiliStatus(tenantSource.bili ?? tenantSource.bilibili ?? tenantSource.hosting?.bili ?? tenantSource.services?.bili);
  const relaySource = tenantSource.relay ?? tenantSource.relayStatus ?? tenantSource.hosting?.relay;
  const relay = relaySource === undefined ? null : normalizeRelayOverview(relaySource);

  return {
    id: asString(tenantSource.id ?? tenantSource.tenantId ?? tenantSource._id),
    name: asString(tenantSource.name ?? tenantSource.displayName ?? tenantSource.title, '未命名租户'),
    slug: asString(tenantSource.slug ?? tenantSource.subdomain ?? tenantSource.host),
    status,
    statusLabel: TENANT_STATUS_LABELS[status] || '未知',
    statusTone: TENANT_STATUS_TONES[status] || 'neutral',
    statusRaw: asString(statusRaw),
    running: status === 'running' || status === 'starting' || status === 'stopping' || runningRaw === true,
    plan,
    expiresAt: expiresRaw ?? null,
    expiry,
    createdAt: first(tenantSource, ['createdAt', 'created', 'created_at']) ?? null,
    updatedAt: first(tenantSource, ['updatedAt', 'updated_at']) ?? null,
    consoleUrl: asString(first(tenantSource, ['consoleUrl', 'consoleURL', 'botUrl', 'url'], '')),
    qq,
    bili,
    relay,
    ownerUserId: asString(tenantSource.ownerUserId ?? tenantSource.owner_user_id ?? ''),
    owner: asString(tenantSource.owner ?? tenantSource.ownerName ?? ''),
    notes: asString(tenantSource.notes ?? '')
  };
}

export function normalizeTenantList(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (isObject(payload)) {
    const candidates = [
      payload.tenants,
      payload.items,
      payload.list,
      payload.data,
      getPath(payload, 'data.tenants'),
      getPath(payload, 'data.items')
    ];
    list = candidates.find((item) => Array.isArray(item)) || [];
  }
  return asArray(list).map((item) => normalizeTenant(item)).filter((tenant) => tenant.id);
}

const QQ_PHASE_LABELS = {
  unknown: '未知',
  stopped: '已停止',
  preparing: '准备中',
  starting: '启动中',
  waiting_login: '等待扫码',
  waiting_confirm: '已扫码待确认',
  online: '在线',
  error: '异常',
  expired: '二维码已过期'
};

const QQ_KERNEL_LABELS = {
  llbot: 'LLBot',
  napcat: 'NapCat',
  snowluma: 'SnowLuma',
  unknown: '未识别'
};

export function normalizeKernel(raw) {
  const text = asString(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!text) return 'unknown';
  if (text.includes('llbot') || text.includes('llonebot')) return 'llbot';
  if (text.includes('napcat')) return 'napcat';
  if (text.includes('snowluma')) return 'snowluma';
  return 'unknown';
}

export function normalizeQQPhase(raw, { running, loggedIn, expired } = {}) {
  if (expired) return 'expired';
  const text = asString(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) {
    if (loggedIn) return 'online';
    if (running) return 'starting';
    return 'stopped';
  }
  if (/waiting_confirm|scanned|已扫码|待确认/.test(text)) return 'waiting_confirm';
  if (/waiting_login|waiting_qr|qrcode|qr_code|扫码|待扫码|等待扫码/.test(text)) return 'waiting_login';
  if (/online|logged_in|loggedin|在线/.test(text)) return 'online';
  if (/^running$|运转|运行/.test(text)) return loggedIn ? 'online' : 'waiting_login';
  if (/prepar|download|安装中|准备中/.test(text)) return 'preparing';
  if (/start|launch|booting|启动中/.test(text)) return 'starting';
  if (/expire|过期/.test(text)) return 'expired';
  if (/error|fail|crash|异常|失败/.test(text)) return 'error';
  if (/stop|offline|idle|未启动|已停止|停止/.test(text)) return 'stopped';
  if (loggedIn) return 'online';
  if (running) return 'starting';
  return 'unknown';
}

export function normalizeTokenStatus(raw) {
  if (isObject(raw)) {
    const status = asString(first(raw, ['status', 'state', 'code'], 'missing')).toLowerCase();
    return {
      status: normalizeAuthTokenStatus(status),
      message: asString(first(raw, ['message', 'detail', 'reason'], ''))
    };
  }
  return { status: normalizeAuthTokenStatus(raw), message: '' };
}

function normalizeAuthTokenStatus(raw) {
  const text = asString(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return 'unknown';
  if (/missing|none|absent|未配置|缺失/.test(text)) return 'missing';
  if (/invalid|expired|bad|无效|过期/.test(text)) return 'invalid';
  if (/quota|limit|rate|配额|限流/.test(text)) return 'quota';
  if (/ok|valid|active|ready|有效/.test(text)) return 'ok';
  return 'unknown';
}

export function normalizeQQDrivers(value) {
  const source = toObject(value);
  return {
    defaultDriver: asString(source.defaultDriver),
    drivers: asArray(source.drivers).filter((item) => isObject(item) && item.allowed === true && asString(item.id)).map((item) => ({
      id: asString(item.id), label: asString(item.label, asString(item.id)),
      allowed: true, installed: item.installed === true, available: item.available === true,
      reasonCode: asString(item.reasonCode), reason: asString(item.reason),
      capabilities: toObject(item.capabilities)
    }))
  };
}

export function normalizeQQStatus(value) {
  if (value === undefined || value === null) {
    return {
      available: false,
      kernel: 'unknown',
      kernelLabel: QQ_KERNEL_LABELS.unknown,
      phase: 'unknown',
      phaseLabel: QQ_PHASE_LABELS.unknown,
      tone: 'neutral',
      running: false,
      loggedIn: false,
      qrAvailable: false,
      error: ''
    };
  }
  let source = toObject(value);
  if (isObject(source.qq)) source = source.qq;
  const loginInfo = toObject(source.loginInfo || source.account || source.self);
  const onebot = toObject(source.onebot || source.ob11);
  const versionInfo = toObject(source.version || source.versions);

  const runtimeRaw = first(source, ['running', 'processRunning', 'agentRunning', 'alive']);
  const loggedInRaw = first(source, ['loggedIn', 'login', 'authorized', 'isLoggedIn']);
  const uin = asString(first(source, ['uin', 'selfId', 'self_id', 'qq', 'accountId']) || loginInfo.uin || loginInfo.selfId);
  const nickname = asString(first(source, ['nickname', 'name', 'displayName']) || loginInfo.nickname || loginInfo.name);
  const phaseRaw = first(source, ['phase', 'state', 'stage', 'loginStatus', 'login_state', 'status']);
  const expired = source.qrExpired === true || /expire|过期/i.test(asString(source.qrStatus));
  const runtimeState = asString(source.runtimeState, 'unknown');
  const loginState = asString(source.loginState, 'unknown');
  const agentChannelState = asString(source.agentChannelState, 'unknown');
  const loggedIn = loginState === 'online' || (loginState === 'unknown' && asBool(loggedInRaw));
  const preliminary = normalizeQQPhase(loginState !== 'unknown' ? loginState : phaseRaw, { running: false, loggedIn, expired });
  const running = ['starting', 'ready', 'degraded'].includes(runtimeState) || asBool(runtimeRaw,
    ['online', 'preparing', 'starting', 'waiting_login', 'waiting_confirm'].includes(preliminary));
  const phase = phaseRaw || loginState !== 'unknown' || loggedIn || running
    ? normalizeQQPhase(loginState !== 'unknown' ? loginState : phaseRaw, { running, loggedIn, expired }) : 'unknown';
  const expectedUin = asString(first(source, ['expectedUin', 'expected_uin']));
  const canChat = source.canChat === true && loginState === 'online' && agentChannelState === 'connected' && Boolean(uin && expectedUin && uin === expectedUin);
  const tone = phase === 'online' ? 'ok'
    : phase === 'error' || phase === 'expired' ? 'danger'
      : phase === 'waiting_login' || phase === 'waiting_confirm' ? 'warn'
        : phase === 'preparing' || phase === 'starting' ? 'info'
          : 'neutral';

  const tokenInfo = normalizeTokenStatus(
    source.authTokenStatus ?? source.tokenStatus ?? source.auth_token_status ?? source.authToken ?? source.token
  );
  const errorSource = source.error ?? source.lastError ?? source.failure;
  const error = isObject(errorSource)
    ? asString(first(errorSource, ['message', 'detail', 'reason'], ''))
    : asString(errorSource);
  const versionRaw = first(source, ['qqVersion', 'clientVersion', 'version']);
  const version = typeof versionRaw === 'string' || typeof versionRaw === 'number'
    ? String(versionRaw)
    : asString(versionInfo.qq ?? versionInfo.client ?? versionInfo.version ?? '');

  return {
    available: true,
    kernel: asString(first(source, ['kernel', 'driver', 'protocol', 'adapter', 'type']), 'unknown').toLowerCase(),
    kernelLabel: QQ_KERNEL_LABELS[normalizeKernel(first(source, ['kernel', 'driver', 'protocol', 'adapter', 'type']))] || '未识别',
    runtimeState, loginState, agentChannelState, canChat,
    runtimeGeneration: source.runtimeGeneration ?? null,
    phase,
    phaseLabel: QQ_PHASE_LABELS[phase] || '未知',
    tone,
    running,
    loggedIn,
    uin,
    expectedUin: asString(first(source, ['expectedUin', 'expected_uin'])),
    mode: asString(source.mode || 'direct'),
    pmhqPort: asNumber(source.ports?.pmhq),
    nickname,
    onebotConnected: asBool(first(source, ['onebotConnected', 'ob11Connected']) ?? onebot.connected ?? onebot.online),
    onebotPort: asNumber(first(source, ['onebotPort', 'ob11Port', 'port']) ?? onebot.port),
    onebotTokenConfigured: Boolean(first(source, ['onebotTokenConfigured', 'tokenConfigured']) ?? onebot.tokenConfigured),
    version,
    versionAligned: (first(source, ['versionAligned', 'qqVersionAligned', 'versionOk']) ?? versionInfo.aligned) == null
      ? null : asBool(first(source, ['versionAligned', 'qqVersionAligned', 'versionOk']) ?? versionInfo.aligned),
    authTokenStatus: tokenInfo.status,
    authTokenMessage: tokenInfo.message,
    qrAvailable: asBool(first(source, ['qrAvailable', 'qrcodeAvailable', 'canLogin', 'waitingForQr']), phase === 'waiting_login'),
    qrStatus: asString(source.qrStatus),
    error,
    message: asString(first(source, ['message', 'detail', 'reason'], '')),
    updatedAt: first(source, ['updatedAt', 'updated_at', 'checkedAt']) ?? null
  };
}

export function normalizeQr(value, { now = Date.now() } = {}) {
  let source = value;
  let nestedImage = '';
  if (isObject(source)) {
    const envelope = source;
    const nested = envelope.qrcode ?? envelope.qrCode ?? envelope.qr ?? envelope.loginQr;
    if (typeof nested === 'string') {
      nestedImage = nested;
      source = envelope;
    } else if (isObject(nested)) {
      source = { ...envelope, ...nested };
    }
  }
  let rawImage = nestedImage;
  let content = '';
  let statusRaw = '';
  let expiresRaw = null;
  let message = '';
  if (typeof source === 'string') {
    rawImage = source;
  } else if (isObject(source)) {
    const imageCandidate = first(source, ['imageDataUrl', 'imageUrl', 'dataUrl', 'image', 'base64', 'png', 'qrcode', 'qrCode', 'qr', 'url']);
    if (!rawImage) {
      if (typeof imageCandidate === 'string') rawImage = imageCandidate;
      else if (isObject(imageCandidate)) {
        rawImage = asString(first(imageCandidate, ['imageDataUrl', 'imageUrl', 'dataUrl', 'image', 'base64', 'qrcode', 'url'], ''));
      }
    }
    content = asString(first(source, ['content', 'text', 'loginUrl', 'qrContent', 'redirectUrl'], ''));
    statusRaw = asString(first(source, ['status', 'state', 'phase', 'loginStatus'], ''));
    expiresRaw = first(source, ['expiresAt', 'expireAt', 'expireTime', 'expires'])
      ?? (asNumber(first(source, ['expiresIn', 'ttl'])) !== null
        ? now + asNumber(first(source, ['expiresIn', 'ttl'])) * 1000
        : null);
    message = asString(first(source, ['message', 'detail', 'reason'], ''));
  }
  const origin = typeof location !== 'undefined' ? location.origin : undefined;
  const imageSrc = safeImageSrc(rawImage, { origin });
  const status = normalizeQrPhase(statusRaw, { hasImage: Boolean(imageSrc) });
  const expireDate = parseDate(expiresRaw);
  const expired = status === 'expired' || (expireDate !== null && expireDate.getTime() <= now);
  const finalStatus = expired ? 'expired' : status;
  return {
    available: Boolean(imageSrc || content || statusRaw),
    runtimeGeneration: isObject(source) ? source.runtimeGeneration ?? null : null,
    qrGeneration: isObject(source) ? source.qrGeneration ?? source.generation ?? null : null,
    imageSrc,
    content,
    status: finalStatus,
    statusLabel: QR_STATUS_LABELS[finalStatus] || '等待扫码',
    tone: finalStatus === 'confirmed' ? 'ok'
      : finalStatus === 'expired' || finalStatus === 'error' ? 'danger'
        : finalStatus === 'scanned' ? 'info' : 'warn',
    expiresAt: expireDate ? expireDate.toISOString() : null,
    expired,
    message
  };
}

const QR_STATUS_LABELS = {
  waiting: '等待扫码',
  scanned: '已扫码，请在手机上确认',
  confirmed: '已确认',
  expired: '二维码已过期',
  error: '获取二维码失败',
  unknown: '等待扫码'
};

export function normalizeQrPhase(raw, { hasImage } = {}) {
  const text = asString(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return hasImage ? 'waiting' : 'unknown';
  if (/confirm|success|done|已确认|成功/.test(text)) return 'confirmed';
  if (/scan|scanned|已扫/.test(text)) return 'scanned';
  if (/expire|timeout|过期|超时/.test(text)) return 'expired';
  if (/error|fail|invalid|失败|错误/.test(text)) return 'error';
  if (/wait|pending|qrcode|qr|show|ok|等待|待扫/.test(text)) return 'waiting';
  return hasImage ? 'waiting' : 'unknown';
}

const SUBSCRIPTION_ALIASES = {
  mentions: ['mentions', 'mentionReply', 'replyMentions', 'replyMention', 'atReply', 'replyAt', 'atMe', '被@回复', '被at回复'],
  upVideos: ['upVideos', 'newVideos', 'upNewVideo', 'upVideo', 'videoUpdates', 'videoUpdate', 'upPosts', 'up_posts', 'newVideo'],
  privateMessages: ['privateMessages', 'privateMessage', 'directMessages', 'directMessage', 'dm', 'messages', 'privateMsg'],
  liveRooms: ['liveRooms', 'liveRoom', 'live', 'liveDanmaku', 'liveEvents', 'liveEvent', 'livestream', '直播']
};

function readSubscription(container, key) {
  if (!isObject(container)) return undefined;
  for (const alias of SUBSCRIPTION_ALIASES[key]) {
    if (container[alias] !== undefined && container[alias] !== null) return asBool(container[alias]);
  }
  return undefined;
}

export function normalizeSubscriptions(value) {
  const root = toObject(value);
  const hasInput = isObject(value) && Object.keys(root).length > 0;
  const containers = hasInput ? [
    root.subscriptions,
    root.subs,
    root.features,
    root.config?.subscriptions,
    root.config,
    root
  ].filter(isObject) : [];
  const result = { mentions: false, upVideos: false, privateMessages: false, liveRooms: false };
  const known = { mentions: false, upVideos: false, privateMessages: false, liveRooms: false };
  for (const key of Object.keys(result)) {
    for (const container of containers) {
      const found = readSubscription(container, key);
      if (found !== undefined) {
        result[key] = found;
        known[key] = true;
        break;
      }
    }
  }
  return {
    subscriptions: result,
    known,
    available: containers.length > 0,
    complete: Object.values(known).every(Boolean)
  };
}

export function normalizeBiliConfig(payload) {
  let source = toObject(payload);
  if (isObject(source.config)) source = source.config;
  if (isObject(source.bili)) source = source.bili;
  if (isObject(source.config) && !source.subscriptions && !source.subs) source = source.config;
  const sub = normalizeSubscriptions(source);
  return {
    subscriptions: sub.subscriptions,
    known: sub.known,
    available: sub.available,
    complete: sub.complete
  };
}

export function buildBiliConfigPayload(subscriptions) {
  const source = toObject(subscriptions);
  return {
    subscriptions: {
      mentions: Boolean(source.mentions),
      upVideos: Boolean(source.upVideos),
      privateMessages: Boolean(source.privateMessages),
      liveRoom: Boolean(source.liveRooms ?? source.liveRoom)
    }
  };
}

const BILI_PHASE_LABELS = {
  unknown: '未知',
  offline: '未绑定',
  waiting: '等待扫码',
  scanned: '已扫码',
  online: '已连接',
  error: '异常',
  expired: '已过期'
};

export function normalizeBiliStatus(value) {
  if (value === undefined || value === null) {
    return {
      available: false,
      phase: 'unknown',
      phaseLabel: '未知',
      tone: 'neutral',
      loggedIn: false,
      subscriptions: normalizeSubscriptions(null).subscriptions,
      subscriptionsKnown: normalizeSubscriptions(null).known,
      cookieHealthy: false,
      error: ''
    };
  }
  let source = toObject(value);
  if (isObject(source.bili)) source = source.bili;
  const user = toObject(source.user || source.account || source.profile);
  const cookie = toObject(source.cookie || source.cookies || source.session);
  const mid = asString(first(source, ['mid', 'uid', 'dedeUserId', 'userId']) || user.mid || user.uid);
  const loggedInRaw = first(source, ['loggedIn', 'login', 'authorized', 'isLoggedIn', 'bound']);
  const loggedIn = asBool(loggedInRaw, Boolean(mid));
  const phaseRaw = first(source, ['phase', 'state', 'status', 'connection', 'loginStatus']);
  const phase = normalizeBiliPhase(phaseRaw, { loggedIn, error: Boolean(source.error || source.lastError) });
  const cookieHealthyRaw = first(source, ['cookieHealthy', 'sessionHealthy', 'authHealthy']);
  const cookieHealthy = asBool(cookieHealthyRaw ?? cookie.healthy ?? cookie.status, loggedIn);
  const cookieStatus = asString(first(source, ['cookieStatus', 'sessionStatus']) ?? cookie.status, '');
  const subscriptions = normalizeSubscriptions(source);
  const errorSource = source.error ?? source.lastError ?? source.failure;
  const error = isObject(errorSource)
    ? asString(first(errorSource, ['message', 'detail', 'reason'], ''))
    : asString(errorSource);
  return {
    available: true,
    phase,
    phaseLabel: BILI_PHASE_LABELS[phase] || '未知',
    tone: phase === 'online' ? (cookieHealthy ? 'ok' : 'warn')
      : phase === 'error' || phase === 'expired' ? 'danger'
        : phase === 'waiting' || phase === 'scanned' ? 'warn' : 'neutral',
    loggedIn,
    mid,
    nickname: asString(first(source, ['nickname', 'name', 'uname', 'userName']) || user.nickname || user.name),
    cookieHealthy,
    cookieStatus,
    cookieExpiresAt: first(source, ['cookieExpiresAt', 'sessionExpiresAt', 'expiresAt']) ?? null,
    subscriptions: subscriptions.subscriptions,
    subscriptionsKnown: subscriptions.known,
    subscriptionsComplete: subscriptions.complete,
    lastPollAt: first(source, ['lastPollAt', 'lastPoll', 'checkedAt', 'lastCheckAt']) ?? null,
    rateLimited: asBool(first(source, ['rateLimited', 'rateLimitActive', 'limited'])),
    rateLimitUntil: first(source, ['rateLimitUntil', 'limitedUntil']) ?? null,
    liveConnected: asBool(first(source, ['liveConnected', 'danmakuConnected'])),
    error,
    message: asString(first(source, ['message', 'detail', 'reason'], '')),
    updatedAt: first(source, ['updatedAt', 'updated_at']) ?? null
  };
}

function normalizeBiliPhase(raw, { loggedIn, error } = {}) {
  const text = asString(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) {
    if (error) return 'error';
    return loggedIn ? 'online' : 'offline';
  }
  if (/online|logged_in|loggedin|connected|active|已连接|在线/.test(text)) return 'online';
  if (/waiting|pending|qrcode|qr|等待|待扫/.test(text)) return 'waiting';
  if (/scan|scanned|已扫/.test(text)) return 'scanned';
  if (/expire|过期/.test(text)) return 'expired';
  if (/error|fail|invalid|异常|失败/.test(text)) return 'error';
  if (/offline|unbound|stopped|未绑定|离线/.test(text)) return 'offline';
  return loggedIn ? 'online' : 'offline';
}

export function normalizeBiliLogin(payload, { now = Date.now() } = {}) {
  let source = toObject(payload);
  if (isObject(source.login)) source = source.login;
  const statusRaw = first(source, ['status', 'phase', 'loginStatus', 'result']);
  const stateRaw = first(source, ['state']);
  const loggedInRaw = first(source, ['loggedIn', 'login', 'authorized', 'success', 'bound', 'online']);
  const user = toObject(source.user || source.account);
  const mid = asString(first(source, ['mid', 'uid', 'dedeUserId']) || user.mid || user.uid);
  const nickname = asString(first(source, ['nickname', 'name', 'uname']) || user.nickname || user.name);
  const hasUser = Boolean(mid || nickname);
  let status = normalizeQrPhase(statusRaw ?? stateRaw, { hasImage: false });
  const stateText = asString(stateRaw).toLowerCase();
  const statusText = asString(statusRaw).toLowerCase();
  if (status === 'unknown' && (stateText === 'stopped' || /not running|未运行|未启动/.test(asString(source.message)))) status = 'error';
  if (status === 'unknown' && hasUser) status = 'confirmed';
  if (asBool(loggedInRaw) && status !== 'expired' && status !== 'error') status = 'confirmed';
  if (status === 'waiting' && /success|confirmed|ok/i.test(statusText)) status = 'confirmed';
  const tone = status === 'confirmed' ? 'ok'
    : status === 'expired' || status === 'error' ? 'danger'
      : status === 'scanned' ? 'info' : 'warn';
  const labels = {
    waiting: '等待扫码',
    scanned: '已扫码，请在手机确认',
    confirmed: '绑定成功',
    expired: '二维码已过期',
    error: '登录失败',
    unknown: '等待扫码'
  };
  const expiresRaw = first(source, ['expiresAt', 'expireAt', 'expireTime'])
    ?? (asNumber(first(source, ['expiresIn', 'ttl'])) !== null ? now + asNumber(first(source, ['expiresIn', 'ttl'])) * 1000 : null);
  return {
    status,
    statusLabel: labels[status] || '等待扫码',
    tone,
    loggedIn: status === 'confirmed',
    mid,
    nickname,
    message: asString(first(source, ['message', 'detail', 'reason', 'error'], '')),
    expiresAt: parseDate(expiresRaw) ? parseDate(expiresRaw).toISOString() : null
  };
}

function normalizeAmountMicros(source, prefix = '') {
  const explicit = first(source, [
    `${prefix}Micros`, `${prefix}_micros`, `${prefix}AmountMicros`, `${prefix}_amount_micros`
  ]);
  if (explicit !== undefined && explicit !== null && explicit !== '') return Math.round(asNumber(explicit, 0));
  const decimal = first(source, [prefix, `${prefix}Amount`, `${prefix}_amount`, `${prefix}Cost`, `${prefix}_cost`]);
  if (decimal !== undefined && decimal !== null && decimal !== '') {
    return Math.round(asNumber(decimal, 0) * 1_000_000);
  }
  return null;
}

export function normalizeTotals(value) {
  const source = toObject(value);
  const requests = asNumber(first(source, ['requests', 'requestCount', 'calls', 'count']), 0);
  const promptTokens = asNumber(first(source, ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens', 'input']), 0);
  const completionTokens = asNumber(first(source, ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens', 'output']), 0);
  const cachedTokens = asNumber(first(source, ['cachedTokens', 'cached_tokens', 'cacheReadTokens', 'cache_read_tokens', 'cacheTokens', 'cache_tokens']), 0);
  const visionTokens = asNumber(first(source, ['visionTokens', 'vision_tokens', 'imageTokens', 'image_tokens']), 0);
  const explicitTotal = first(source, ['totalTokens', 'total_tokens', 'tokens']);
  const totalTokens = explicitTotal !== undefined && explicitTotal !== null
    ? asNumber(explicitTotal, 0)
    : promptTokens + completionTokens + visionTokens;
  const currency = asString(first(source, ['currency', 'currencyCode'], 'CNY')).toUpperCase();
  const costMicros = normalizeAmountMicros(source, 'cost') ?? normalizeAmountMicros(source, 'amount') ?? 0;
  const fields = ['requests', 'promptTokens', 'completionTokens', 'cachedTokens', 'visionTokens', 'totalTokens', 'costMicros'];
  const available = fields.some((field) => source[field] !== undefined || source[field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] !== undefined)
    || Boolean(first(source, ['cost', 'amount', 'total_tokens', 'tokens']));
  return {
    requests: Math.max(0, Math.round(requests)),
    promptTokens: Math.max(0, Math.round(promptTokens)),
    completionTokens: Math.max(0, Math.round(completionTokens)),
    cachedTokens: Math.max(0, Math.round(cachedTokens)),
    visionTokens: Math.max(0, Math.round(visionTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    costMicros,
    currency,
    available
  };
}

function emptyTotals(currency = 'CNY') {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    visionTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    currency,
    available: false
  };
}

function addTotals(target, source) {
  target.requests += source.requests || 0;
  target.promptTokens += source.promptTokens || 0;
  target.completionTokens += source.completionTokens || 0;
  target.cachedTokens += source.cachedTokens || 0;
  target.visionTokens += source.visionTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.costMicros += source.costMicros || 0;
  if (source.available) target.available = true;
  return target;
}

function toDayKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const date = parseDate(value);
  if (!date) return asString(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeModelUsage(value, fallbackModel = '') {
  const source = toObject(value);
  const totals = normalizeTotals(source);
  return {
    model: asString(first(source, ['model', 'modelId', 'model_id', 'name', 'id'], fallbackModel), fallbackModel || '未命名模型'),
    ...totals
  };
}

function normalizeModelList(modelsValue) {
  if (Array.isArray(modelsValue)) {
    return modelsValue.map((item) => normalizeModelUsage(item));
  }
  if (isObject(modelsValue)) {
    return Object.entries(modelsValue).map(([name, item]) => normalizeModelUsage(item, name));
  }
  return [];
}

export function normalizeBilling(value, { now = new Date() } = {}) {
  const source = toObject(value);
  const usage = toObject(source.usage || source.billing || source);
  const dailyCandidates = [
    usage.daily,
    usage.days,
    source.daily,
    source.days,
    source.dailyUsage,
    source.daily_usage,
    source.usageByDay,
    source.usage_by_day,
    getPath(source, 'billing.daily'),
    getPath(source, 'billing.days'),
    getPath(source, 'usage.daily')
  ];
  const dailyRaw = dailyCandidates.find((item) => Array.isArray(item)) || [];
  const currency = asString(first(usage, ['currency', 'currencyCode']) || first(source, ['currency']), 'CNY').toUpperCase();

  const days = asArray(dailyRaw).map((dayValue) => {
    const day = toObject(dayValue);
    const date = toDayKey(first(day, ['date', 'day', 'dayKey', 'day_key', 'dateKey', 'date_key']));
    const modelSource = day.models ?? day.byModel ?? day.by_model ?? day.usageByModel;
    let models = normalizeModelList(modelSource).filter((model) => model.available || model.model);
    for (const model of models) {
      if (!model.currency || model.currency === 'CNY') model.currency = currency;
    }
    const totalsSource = day.totals ?? day.total ?? day.summary;
    let totals = totalsSource ? normalizeTotals(totalsSource) : emptyTotals(currency);
    if (!totalsSource) {
      for (const model of models) addTotals(totals, model);
    }
    if (totals.available && models.length === 0 && (totals.costMicros || totals.totalTokens || totals.requests)) {
      models = [{ model: '未分类', ...totals }];
    }
    return { date, models, totals, currency };
  });

  const hasDaily = days.length > 0;
  days.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

  const explicitTotal = first(usage, ['total', 'totals', 'allTime', 'all_time']) ?? first(source, ['total', 'totals']);
  let total = explicitTotal ? normalizeTotals(explicitTotal) : emptyTotals(currency);
  if (!explicitTotal && hasDaily) {
    for (const day of days) addTotals(total, day.totals);
  }
  if (!total.currency || total.currency === 'CNY') total.currency = currency;

  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const explicitToday = first(usage, ['today', 'todayUsage', 'today_usage']) ?? first(source, ['today']);
  let today = explicitToday ? normalizeTotals(explicitToday) : emptyTotals(currency);
  if (!explicitToday) {
    const match = days.find((day) => day.date === todayKey);
    if (match) today = { ...match.totals };
  }
  if (!today.available && (today.costMicros || today.totalTokens || today.requests)) today.available = true;

  const windowDays = asNumber(first(usage, ['days', 'windowDays', 'window_days']) ?? first(source, ['days', 'windowDays']));
  const byModelSource = first(usage, ['byModel', 'by_model', 'models']) ?? first(source, ['byModel', 'by_model']);
  const byModel = isObject(byModelSource) || Array.isArray(byModelSource)
    ? normalizeModelList(byModelSource).sort((a, b) => b.costMicros - a.costMicros)
    : [];

  return {
    days,
    hasDaily,
    windowDays,
    today,
    total,
    byModel,
    byChat: asArray(usage.byChat).map(row => ({ date: asString(row.date), model: asString(row.model), platform: asString(row.platform), chatKey: asString(row.chatKey), requests: asNumber(row.requests) || 0, cachedTokens: asNumber(row.cachedTokens) || 0, costMicros: asNumber(row.costMicros) || 0, visionRequests: asNumber(row.visionRequests) || 0, visionRequestCostMicros: asNumber(row.visionRequestCostMicros) || 0, usageSources: toObject(row.usageSources) })),
    usageSources: toObject(usage.usageSources),
    visionRequests: asNumber(usage.visionRequests) || 0,
    visionRequestCostMicros: asNumber(usage.visionRequestCostMicros) || 0,
    currency,
    updatedAt: first(usage, ['updatedAt', 'updated_at']) ?? first(source, ['updatedAt']) ?? null
  };
}

export function normalizeQuota(value) {
  const source = toObject(value);
  const costLimit = asNumber(first(source, [
    'costLimitMicros', 'cost_limit_micros', 'limitMicros', 'limit_micros', 'monthlyCostMicros', 'monthly_cost_micros'
  ]));
  const costUsed = asNumber(first(source, [
    'costUsedMicros', 'cost_used_micros', 'usedMicros', 'used_micros', 'spentMicros', 'spent_micros'
  ]));
  const tokenLimit = asNumber(first(source, [
    'tokenLimit', 'token_limit', 'tokensLimit', 'tokens_limit', 'monthlyTokens', 'monthly_tokens', 'limitTokens', 'limit_tokens'
  ]));
  const tokenUsed = asNumber(first(source, [
    'tokenUsed', 'token_used', 'tokensUsed', 'tokens_used', 'usedTokens', 'used_tokens'
  ]));
  const requestsLimit = asNumber(first(source, ['requestsLimit', 'requests_limit', 'requestLimit', 'request_limit']));
  const requestsUsed = asNumber(first(source, ['requestsUsed', 'requests_used', 'requestUsed', 'request_used']));
  const unit = asString(first(source, ['unit', 'quotaUnit', 'quota_unit'])).toLowerCase();
  let finalCostLimit = costLimit;
  let finalCostUsed = costUsed;
  let finalTokenLimit = tokenLimit;
  let finalTokenUsed = tokenUsed;
  const genericLimit = asNumber(first(source, ['limit', 'quota']));
  const genericUsed = asNumber(first(source, ['used', 'consumed']));
  if (genericLimit !== null) {
    if (unit.includes('token')) {
      finalTokenLimit = finalTokenLimit ?? genericLimit;
      finalTokenUsed = finalTokenUsed ?? genericUsed ?? 0;
    } else if (unit.includes('micro') || unit.includes('cost') || unit.includes('currency') || unit.includes('money')) {
      finalCostLimit = finalCostLimit ?? genericLimit;
      finalCostUsed = finalCostUsed ?? genericUsed ?? 0;
    }
  }
  if (finalCostLimit !== null && finalCostUsed === null) finalCostUsed = 0;
  if (finalTokenLimit !== null && finalTokenUsed === null) finalTokenUsed = 0;
  return {
    costLimitMicros: finalCostLimit,
    costUsedMicros: finalCostUsed,
    tokenLimit: finalTokenLimit,
    tokenUsed: finalTokenUsed,
    requestsLimit,
    requestsUsed,
    periodStart: first(source, ['periodStart', 'period_start', 'cycleStart', 'cycle_start']) ?? null,
    periodEnd: first(source, ['periodEnd', 'period_end', 'cycleEnd', 'cycle_end', 'resetAt', 'reset_at']) ?? null,
    planName: asString(first(source, ['planName', 'plan_name', 'name']), ''),
    rpm: asNumber(first(source, ['rpm', 'requestsPerMinute', 'requests_per_minute'])),
    tpm: asNumber(first(source, ['tpm', 'tokensPerMinute', 'tokens_per_minute']))
  };
}

export function normalizeRelayOverview(payload) {
  const root = toObject(payload);
  const source = toObject(root.relay || root.overview || root);
  const keyValue = first(source, [
    'keyMasked', 'key_mask', 'maskedKey', 'masked_key', 'keyPreview', 'key_preview',
    'apiKeyMasked', 'api_key_masked', 'apiKey', 'api_key', 'key'
  ]);
  const keyObject = isObject(keyValue) ? keyValue : null;
  const keyRaw = typeof keyValue === 'string'
    ? keyValue
    : (keyObject && keyObject.prefix ? `${keyObject.prefix}••••` : '');
  const configuredRaw = first(source, ['configured', 'hasKey', 'keyConfigured', 'key_configured']);
  const configured = asBool(configuredRaw, Boolean(keyRaw));
  const keyStatusRaw = first(source, ['keyStatus', 'key_status', 'credentialStatus']);
  const keyStatus = isObject(keyStatusRaw)
    ? {
        status: asString(first(keyStatusRaw, ['status', 'state'], configured ? 'active' : 'missing')).toLowerCase(),
        message: asString(first(keyStatusRaw, ['message', 'detail'], ''))
      }
    : { status: asString(keyStatusRaw, configured ? 'active' : 'missing').toLowerCase(), message: '' };
  const lastErrorSource = source.lastError ?? source.error;
  const lastError = isObject(lastErrorSource)
    ? asString(first(lastErrorSource, ['message', 'detail'], ''))
    : asString(lastErrorSource);
  const baseValue = first(source, ['baseUrl', 'base_url', 'providerUrl']);
  const baseUrl = typeof baseValue === 'string' ? baseValue : '';
  let baseHost = '';
  if (baseUrl) {
    try {
      baseHost = new URL(baseUrl).host;
    } catch {
      baseHost = '';
    }
  }
  const planSource = toObject(source.plan);
  const plan = {
    id: asString(planSource.id),
    name: asString(planSource.name),
    monthlyCreditMicros: asNumber(planSource.monthlyCreditMicros ?? planSource.monthly_credit_micros),
    maxOutputTokens: asNumber(planSource.maxOutputTokens ?? planSource.max_output_tokens),
    maxConcurrent: asNumber(planSource.maxConcurrent ?? planSource.max_concurrent),
    rpm: asNumber(planSource.rpm),
    tpm: asNumber(planSource.tpm)
  };
  const walletSource = isObject(source.billing) && (
    Object.hasOwn(source.billing, 'balanceMicros') || Object.hasOwn(source.billing, 'availableMicros')
  ) ? source.billing : toObject(source.wallet);
  const walletAvailable = ['balanceMicros', 'heldMicros', 'availableMicros']
    .some((key) => walletSource[key] !== undefined && walletSource[key] !== null);
  const wallet = {
    available: walletAvailable,
    balanceMicros: asNumber(walletSource.balanceMicros ?? walletSource.balance_micros),
    heldMicros: asNumber(walletSource.heldMicros ?? walletSource.held_micros),
    availableMicros: asNumber(walletSource.availableMicros ?? walletSource.available_micros),
    currency: asString(walletSource.currency, 'CNY').toUpperCase()
  };
  const quota = normalizeQuota({
    ...planSource,
    ...toObject(source.quota ?? source.limits),
    planName: asString(planSource.name || source.quota?.planName || source.planName)
  });
  const billing = normalizeBilling(source);
  const localEstimateSource = source.localEstimate ?? source.localUsage ?? source.local_usage ?? source.estimates;
  const localEstimate = localEstimateSource ? normalizeTotals(localEstimateSource) : null;
  const model = asString(first(source, ['model', 'defaultModel', 'default_model', 'modelId']));
  return {
    configured,
    keyMasked: keyRaw ? maskSecret(keyRaw) : '',
    keyStatus,
    keyStatusLabel: KEY_STATUS_LABELS[keyStatus.status] || (configured ? '已绑定' : '未绑定'),
    keyStatusTone: configured ? (['invalid', 'expired', 'quota_exceeded', 'missing'].includes(keyStatus.status) ? 'danger' : 'ok') : 'warn',
    model,
    plan,
    baseHost,
    wallet,
    quota,
    billing,
    localEstimate,
    lastError,
    updatedAt: first(source, ['updatedAt', 'updated_at']) ?? null
  };
}

const KEY_STATUS_LABELS = {
  active: 'Key 有效',
  ok: 'Key 有效',
  valid: 'Key 有效',
  missing: '未绑定 Key',
  invalid: 'Key 无效',
  expired: 'Key 已过期',
  quota_exceeded: '额度已用尽',
  error: 'Key 异常'
};

export function normalizeModels(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (isObject(payload)) {
    if (Array.isArray(payload.models)) list = payload.models;
    else if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.data?.models)) list = payload.data.models;
    else if (Array.isArray(payload.items)) list = payload.items;
  }
  const seen = new Set();
  return asArray(list).map((item) => {
    if (typeof item === 'string') {
      return { id: item, name: item, description: '', contextWindow: null, ownedBy: '', priceLabel: '' };
    }
    const model = toObject(item);
    const id = asString(first(model, ['id', 'model', 'modelId', 'model_id', 'name']));
    if (!id) return null;
    const contextWindow = asNumber(first(model, ['contextWindow', 'context_window', 'contextLength', 'context_length', 'maxTokens', 'max_tokens']));
    const pricing = toObject(model.pricing || model.price);
    const inputPrice = first(pricing, ['input', 'prompt']) ?? first(model, ['inputPrice', 'input_price', 'promptPrice']);
    const outputPrice = first(pricing, ['output', 'completion']) ?? first(model, ['outputPrice', 'output_price', 'completionPrice']);
    let priceLabel = '';
    if (inputPrice !== undefined || outputPrice !== undefined) {
      const input = asNumber(inputPrice);
      const output = asNumber(outputPrice);
      const fmt = (value) => (value === null ? '—' : String(value));
      priceLabel = `入 ${fmt(input)} / 出 ${fmt(output)}`;
    }
    return {
      id,
      name: asString(first(model, ['displayName', 'display_name', 'title', 'name'], id), id),
      description: asString(first(model, ['description', 'desc'], '')),
      contextWindow,
      ownedBy: asString(first(model, ['ownedBy', 'owned_by'], '')),
      priceLabel
    };
  }).filter((model) => {
    if (!model || !model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}
