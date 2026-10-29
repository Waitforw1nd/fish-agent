// 同源 API 客户端：只允许计划约定的路径，不拼接外部地址。
// 所有写操作携带同源 Cookie；401 会通知应用会话过期，登录失败除外。

import { redactText } from './format.js';

const ENVELOPE_KEYS = new Set(['ok', 'success', 'data', 'message', 'error', 'code', 'requestId', 'request_id', 'traceId', 'meta']);

export class ApiError extends Error {
  constructor(status, code, message, payload = null, extra = {}) {
    super(redactText(message || '请求失败'));
    this.name = 'ApiError';
    this.status = Number(status) || 0;
    this.code = code || 'request_failed';
    this.payload = payload;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    if (extra.cause) this.cause = extra.cause;
  }

  get isAuthExpired() {
    return this.status === 401;
  }

  get isSubscriptionExpired() {
    return this.status === 402 || /expired|subscription|quota_exceeded|insufficient/i.test(this.code);
  }

  get isNetwork() {
    return this.status === 0 && this.code === 'network_error';
  }
}

export function unwrapPayload(payload) {
  if (!isPlainObject(payload)) return payload;
  if (!Object.prototype.hasOwnProperty.call(payload, 'data')) return payload;
  const keys = Object.keys(payload);
  if (keys.length && keys.every((key) => ENVELOPE_KEYS.has(key))) return payload.data;
  return payload;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractError(payload) {
  if (!isPlainObject(payload)) return { code: '', message: '' };
  const error = isPlainObject(payload.error) ? payload.error : null;
  const code = String(payload.code ?? payload.errorCode ?? error?.code ?? '');
  let message = '';
  if (typeof payload.error === 'string') message = payload.error;
  else if (error) message = String(error.message ?? error.detail ?? '');
  if (!message) message = String(payload.message ?? payload.wording ?? payload.detail ?? '');
  if (!message && Array.isArray(payload.errors)) {
    message = payload.errors.map((item) => (typeof item === 'string' ? item : item?.message)).filter(Boolean).join('；');
  }
  return { code, message };
}

function statusMessage(status) {
  if (status === 400) return '请求参数有误';
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 402) return '租户已到期或套餐额度不足';
  if (status === 403) return '没有权限执行此操作';
  if (status === 404) return '请求的资源不存在';
  if (status === 409) return '当前状态不允许该操作';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return '云平台暂时不可用，请稍后重试';
  return `请求失败（HTTP ${status}）`;
}

function parseRetryAfter(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  return null;
}

export function createApi({
  fetchImpl = globalThis.fetch?.bind?.(globalThis),
  onUnauthorized = null
} = {}) {
  let csrfToken = '';

  function rememberCsrf(payload) {
    if (isPlainObject(payload) && typeof payload.csrfToken === 'string' && payload.csrfToken) {
      csrfToken = payload.csrfToken;
    }
  }

  async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
    if (!path.startsWith('/api/')) throw new TypeError(`非法的 API 路径：${path}`);
    const upperMethod = String(method).toUpperCase();
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(upperMethod);
    const headers = { Accept: 'application/json' };
    if (mutation && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const init = {
      method: upperMethod,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      signal
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
      response = await fetchImpl(path, init);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(0, 'network_error', '无法连接云平台，请检查网络后重试。', null, { cause: error });
    }

    const rawText = await response.text().catch(() => '');
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText;
      }
    }

    if (!response.ok) {
      if (response.status === 401) csrfToken = '';
      const { code: payloadCode, message } = extractError(payload);
      const code = payloadCode || `http_${response.status}`;
      const error = new ApiError(
        response.status,
        code,
        message || statusMessage(response.status),
        payload,
        { retryAfterMs: parseRetryAfter(response.headers?.get?.('Retry-After')) }
      );
      if (auth && response.status === 401 && typeof onUnauthorized === 'function') {
        try {
          onUnauthorized(error);
        } catch {
          // 回调不能改变原始错误
        }
      }
      throw error;
    }

    if (isPlainObject(payload) && (payload.ok === false || payload.success === false)) {
      const { code, message } = extractError(payload);
      throw new ApiError(response.status, code || 'request_failed', message || '操作未完成', payload);
    }
    rememberCsrf(payload);
    return unwrapPayload(payload);
  }

  const tenantPath = (tenantId, suffix = '') => {
    const id = encodeURIComponent(String(tenantId ?? ''));
    if (!id) throw new TypeError('缺少租户 ID');
    return `/api/tenants/${id}${suffix}`;
  };

  return {
    request,
    getCsrfToken: () => csrfToken,
    setCsrfToken(value) { csrfToken = String(value || ''); },
    login(username, password) {
      return request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false
      });
    },
    logout() {
      return request('/api/auth/logout', { method: 'POST', auth: false }).finally(() => { csrfToken = ''; });
    },
    me() {
      return request('/api/me');
    },
    listTenants() {
      return request('/api/tenants');
    },
    listPlans() {
      return request('/api/plans');
    },
    getPlans() {
      return request('/api/plans');
    },
    getUsers() {
      return request('/api/admin/users');
    },
    createUser({ username, password, role } = {}) {
      return request('/api/admin/users', { method: 'POST', body: { username, password, role } });
    },
    getUserTenants(userId) {
      const id = encodeURIComponent(String(userId ?? ''));
      if (!id) throw new TypeError('缺少用户 ID');
      return request(`/api/admin/users/${id}/tenants`);
    },
    createTenant({ name, slug, planId, ownerUserId } = {}) {
      const body = { name };
      if (slug) body.slug = slug;
      if (planId) body.planId = planId;
      if (ownerUserId) body.ownerUserId = ownerUserId;
      return request('/api/tenants', { method: 'POST', body });
    },
    getTenant(tenantId) {
      return request(tenantPath(tenantId));
    },
    startTenant(tenantId) {
      return request(tenantPath(tenantId, '/start'), { method: 'POST' });
    },
    stopTenant(tenantId) {
      return request(tenantPath(tenantId, '/stop'), { method: 'POST' });
    },
    getQQDrivers() {
      return request('/api/qq/drivers');
    },
    switchQQ(tenantId, { driver, expectedRevision, idempotencyKey, uin } = {}, { signal } = {}) {
      const body = { driver, expectedRevision, idempotencyKey };
      if (uin !== undefined) body.uin = uin;
      return request(tenantPath(tenantId, '/qq/switch'), { method: 'POST', body, signal });
    },
    getQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}`), { signal });
    },
    advanceQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}/advance`), { method: 'POST', signal });
    },
    cancelQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}/cancel`), { method: 'POST', signal });
    },
    prepareQQ(tenantId, { kernel, uin } = {}) {
      return request(tenantPath(tenantId, '/qq/prepare'), {
        method: 'POST', body: qqBody(kernel, uin)
      });
    },
    startQQ(tenantId, { kernel, uin } = {}) {
      return request(tenantPath(tenantId, '/qq/start'), {
        method: 'POST', body: qqBody(kernel, uin)
      });
    },
    refreshQQQrcode(tenantId, runtimeGeneration = null) {
      return request(tenantPath(tenantId, '/qq/qrcode/refresh'), { method: 'POST', body: { runtimeGeneration } });
    },
    getQQQrcode(tenantId) {
      return request(tenantPath(tenantId, '/qq/qrcode'));
    },
    getQQStatus(tenantId) {
      return request(tenantPath(tenantId, '/qq/status'));
    },
    biliLoginQr(tenantId) {
      return request(tenantPath(tenantId, '/bili/login/qr'), { method: 'POST' });
    },
    getBiliLoginStatus(tenantId) {
      return request(tenantPath(tenantId, '/bili/login/status'));
    },
    getBiliStatus(tenantId) {
      return request(tenantPath(tenantId, '/bili/status'));
    },
    getBiliConfig(tenantId) {
      return request(tenantPath(tenantId, '/bili/config'));
    },
    updateBiliConfig(tenantId, subscriptions) {
      return request(tenantPath(tenantId, '/bili/config'), {
        method: 'PUT',
        body: {
          subscriptions: {
            mentions: Boolean(subscriptions?.mentions),
            upVideos: Boolean(subscriptions?.upVideos),
            privateMessages: Boolean(subscriptions?.privateMessages),
            liveRoom: Boolean(subscriptions?.liveRooms ?? subscriptions?.liveRoom)
          }
        }
      });
    },
    getRelayOverview(tenantId) {
      return request(tenantPath(tenantId, '/relay/overview'));
    },
    getRelayModels(tenantId) {
      return request(tenantPath(tenantId, '/relay/models'));
    },
    updateRelayKey(tenantId, { key, model } = {}) {
      const body = {};
      if (key) body.key = String(key).trim();
      if (model) body.model = String(model).trim();
      return request(tenantPath(tenantId, '/relay/key'), { method: 'PUT', body });
    },
    getRelayCustom(tenantId) {
      return request(tenantPath(tenantId, '/relay/custom'));
    },
    updateRelayCustom(tenantId, { baseUrl, apiKey, model } = {}) {
      const body = {
        baseUrl: String(baseUrl ?? '').trim(),
        model: String(model ?? '').trim()
      };
      if (apiKey) body.apiKey = String(apiKey).trim();
      return request(tenantPath(tenantId, '/relay/custom'), { method: 'PUT', body });
    },
    deleteRelayCustom(tenantId) {
      return request(tenantPath(tenantId, '/relay/custom'), { method: 'DELETE' });
    },
    getRelayLogs(tenantId, { days, model, status } = {}) {
      const query = new URLSearchParams();
      if (days !== undefined && days !== null && days !== '') query.set('days', String(days));
      if (model) query.set('model', String(model).trim());
      if (status) query.set('status', String(status).trim());
      const suffix = query.size ? `?${query.toString()}` : '';
      return request(tenantPath(tenantId, `/relay/logs${suffix}`));
    },
    getRecharges(tenantId) {
      return request(tenantPath(tenantId, '/billing/recharges'));
    },
    createRecharge(tenantId, { amount } = {}) {
      return request(tenantPath(tenantId, '/billing/recharges'), {
        method: 'POST',
        body: { amountMicros: Math.round(Number(amount) * 1_000_000) }
      });
    }
  };
}

function qqBody(kernel, uin) {
  const body = {};
  if (kernel) body.kernel = String(kernel);
  if (uin) body.uin = String(uin).trim();
  return body;
}
