import { isObject, getPath, first, asArray, asString, asNumber, asBool, toObject, unwrapKey } from './core.js';
import { expiryInfo, maskSecret, parseDate, safeImageSrc } from '../format.js';

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

export function normalizeQQOperation(value) {
  const root = toObject(value);
  const source = toObject(root.operation || root);
  const error = toObject(source.error);
  return {
    operationId: asString(source.operationId), status: asString(source.status), phase: asString(source.phase),
    sourceDriver: asString(source.sourceDriver), targetDriver: asString(source.targetDriver),
    expectedUin: asString(source.expectedUin), expectedRevision: source.expectedRevision ?? null,
    runtimeGeneration: source.runtimeGeneration ?? null, qrGeneration: source.qrGeneration ?? null,
    canCancel: source.canCancel === true, error: asString(error.message || source.error),
    rollback: toObject(source.rollback), createdAt: source.createdAt ?? null, updatedAt: source.updatedAt ?? null
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
    revision: source.revision ?? null,
    activeOperationId: asString(source.activeOperationId),
    latestOperationId: asString(source.latestOperationId),
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
    operationId: isObject(source) ? asString(source.operationId) : '',
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
