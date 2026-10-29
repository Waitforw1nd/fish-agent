// 同源 API 客户端：只允许计划约定的路径，不拼接外部地址。
// 所有写操作携带同源 Cookie；401 会通知应用会话过期，登录失败除外。

import { redactText } from '../format.js';

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

export function createTransport({
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

  return { request, getCsrfToken: () => csrfToken, setCsrfToken(value) { csrfToken = String(value || ''); } };
}
