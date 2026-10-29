import { isObject, getPath, first, asArray, asString, asNumber, asBool, toObject, unwrapKey } from './core.js';
import { expiryInfo, maskSecret, parseDate, safeImageSrc } from '../format.js';
import { normalizeQQStatus, normalizeBiliStatus } from './channels.js';
import { normalizeRelayOverview } from './relay-billing.js';

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
    subscriptionStatus: asString(tenantSource.subscriptionStatus ?? tenantSource.subscription_status),
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
    notes: asString(tenantSource.notes ?? ''),
    role: asString(tenantSource.role ?? root.role),
    readiness: normalizeReadiness(tenantSource.readiness ?? root.readiness)
  };
}

export function normalizeReadiness(value) {
  if (!isObject(value)) return null;
  const labels = { agentRunning: '启动实例', qqOnline: '扫码登录 QQ', channelReady: '模型渠道可用', whitelistReady: '选择互动白名单' };
  const aliases = { agent: 'agentRunning', qq: 'qqOnline', channel: 'channelReady', whitelist: 'whitelistReady' };
  const steps = asArray(value.steps).length
    ? value.steps.map((step) => ({ id: aliases[step.id] || asString(step.id), label: asString(step.label), ready: Boolean(step.ready) }))
    : Object.entries(labels).map(([id, label]) => ({ id, label, ready: Boolean(value[id]) }));
  return { ...value, steps, ready: Boolean(value.ready ?? steps.every((step) => step.ready)), completed: Number(value.completed ?? steps.filter((step) => step.ready).length), total: Number(value.total ?? steps.length) };
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
