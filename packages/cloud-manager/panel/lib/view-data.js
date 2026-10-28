// 视图层派生数据：保持纯函数，便于测试租户统计、订阅合并、账单筛选和错误文案。

import { formatCountdown, formatDate, parseDate, redactText } from './format.js';

export function tenantSummary(tenants, now = Date.now()) {
  const list = Array.isArray(tenants) ? tenants : [];
  let running = 0;
  let expiring = 0;
  let expired = 0;
  for (const tenant of list) {
    if (tenant?.status === 'running' || tenant?.status === 'starting') running += 1;
    if (tenant?.expiry?.state === 'expired') expired += 1;
    else if (tenant?.expiry?.state === 'soon') expiring += 1;
  }
  return { total: list.length, running, expiring, expired };
}

export function resolveSubscriptions(config, bili) {
  const base = { ...(bili?.subscriptions || {}) };
  const known = config?.known || {};
  if (config?.available) {
    for (const key of ['mentions', 'upVideos', 'privateMessages', 'liveRooms']) {
      if (known[key]) base[key] = Boolean(config.subscriptions?.[key]);
    }
  }
  return {
    mentions: Boolean(base.mentions),
    upVideos: Boolean(base.upVideos),
    privateMessages: Boolean(base.privateMessages),
    liveRooms: Boolean(base.liveRooms)
  };
}

export function localDayKey(value = new Date()) {
  const date = parseDate(value) || new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function filterBillingDays(days, range = 'all', now = Date.now()) {
  const list = Array.isArray(days) ? days : [];
  if (range === 'all' || !Number.isFinite(Number(range))) return list;
  const span = Math.max(1, Number(range));
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (span - 1));
  const cutoffKey = localDayKey(cutoff);
  return list.filter((day) => {
    if (!day?.date) return false;
    return day.date >= cutoffKey;
  });
}

export function dayLabel(date, now = Date.now()) {
  if (!date) return '累计汇总';
  const parsed = parseDate(date);
  if (!parsed) return String(date);
  const today = localDayKey(now);
  const key = localDayKey(parsed);
  if (key === today) return '今天';
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  if (key === localDayKey(yesterdayDate)) return '昨天';
  const sameYear = parsed.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${parsed.getMonth() + 1} 月 ${parsed.getDate()} 日`
    : formatDate(parsed);
}

export function qrCountdown(expiresAt, now = Date.now()) {
  const date = parseDate(expiresAt);
  if (!date) return { hasExpiry: false, expired: false, text: '' };
  const left = date.getTime() - now;
  return {
    hasExpiry: true,
    expired: left <= 0,
    text: left <= 0 ? '二维码已过期' : `${formatCountdown(left)} 后过期`
  };
}

export function qrTone(status) {
  if (status === 'confirmed') return 'ok';
  if (status === 'expired' || status === 'error') return 'danger';
  if (status === 'scanned') return 'info';
  return 'warn';
}

export function apiErrorMessage(error, { fallback = '操作失败，请稍后重试。' } = {}) {
  if (!error) return fallback;
  if (error.isNetwork) return '无法连接云平台，请检查网络后重试。';
  if (error.status === 401) return '登录状态已失效，请重新登录。';
  if (error.status === 402) return '租户已到期或套餐额度不足，无法执行该操作。';
  if (error.status === 403) return '当前账号没有权限执行该操作。';
  if (error.status === 404) return '请求的资源不存在，可能已被删除。';
  if (error.status === 429) return '请求过于频繁，请稍后再试。';
  if (error.status >= 500) return '云平台暂时不可用，请稍后重试。';
  const message = redactText(error.message || '').trim();
  return message || fallback;
}

export function loginErrorMessage(error) {
  if (!error) return '登录失败，请重试。';
  if (error.isNetwork) return '无法连接云平台，请检查网络后重试。';
  if (error.status === 401) return '用户名或密码不正确。';
  if (error.status === 403) return '账号已被禁用或没有平台访问权限。';
  if (error.status === 429) return '尝试次数过多，请稍后再试。';
  const message = redactText(error.message || '').trim();
  return message || '登录失败，请重试。';
}

export function modelDisplayName(model) {
  if (!model) return '未选择';
  return model.name && model.name !== model.id ? `${model.name}` : model.id;
}

export function subscriptionLabel(key) {
  return SUBSCRIPTION_DEFS.find((item) => item.key === key)?.title || key;
}

export const SUBSCRIPTION_DEFS = [
  {
    key: 'mentions',
    title: '被 @ 回复',
    description: 'B 站评论、动态中有人 @ 机器人时进入 Agent'
  },
  {
    key: 'upVideos',
    title: 'UP 新视频',
    description: '监控的 UP 主发布新视频后触发处理'
  },
  {
    key: 'privateMessages',
    title: '私信',
    description: 'B 站私信会话，独立低频队列，避免刷屏'
  },
  {
    key: 'liveRooms',
    title: '直播房间',
    description: '弹幕、礼物、上舰事件（默认预过滤高流量弹幕）'
  }
];

export function summarizeRange(days) {
  const result = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    visionTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    available: false
  };
  for (const day of Array.isArray(days) ? days : []) {
    const totals = day?.totals;
    if (!totals) continue;
    result.requests += totals.requests || 0;
    result.promptTokens += totals.promptTokens || 0;
    result.completionTokens += totals.completionTokens || 0;
    result.cachedTokens += totals.cachedTokens || 0;
    result.visionTokens += totals.visionTokens || 0;
    result.totalTokens += totals.totalTokens || 0;
    result.costMicros += totals.costMicros || 0;
    if (totals.available) result.available = true;
  }
  return result;
}
