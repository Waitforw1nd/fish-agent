import { AuthRequiredError, BiliApiError, BiliRiskError, BridgeError } from '../errors.js';
import { encodeQuery, sleep } from '../util.js';

export const DEFAULT_ENDPOINTS = Object.freeze({
  passport: 'https://passport.bilibili.com',
  api: 'https://api.bilibili.com',
  web: 'https://www.bilibili.com',
  live: 'https://api.live.bilibili.com',
  vc: 'https://api.vc.bilibili.com',
  subtitle: 'https://aisubtitle.hdslb.com'
});

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const BILI_CODE_WORDING = Object.freeze({
  '-101': 'B 站账号未登录或登录已失效',
  '-111': 'CSRF 校验失败，请重新登录',
  '-352': 'B 站触发风控，需要完成人机验证',
  '-403': 'B 站接口拒绝访问（可能需要更新 WBI 签名或登录）',
  '-404': 'B 站资源不存在',
  '-412': 'B 站请求被风控拦截',
  '-509': 'B 站请求过于频繁，请稍后再试',
  '-102': 'B 站账号被封停',
  12002: '评论区已关闭或无权限评论',
  12003: '禁止回复该评论',
  12006: '没有该评论',
  12009: '评论主体 type 不合法',
  12015: '评论需要验证码，请稍后重试或人工处理',
  12016: '评论内容包含敏感信息，被 B 站拒绝',
  12025: '评论字数过多',
  12035: '该账号被 UP 主列入评论黑名单',
  12045: '购买后即可发表评论',
  12051: '重复评论，请勿刷屏',
  12052: '评论区已关闭',
  12019: '举报或操作过于频繁',
  21007: '私信内容过长，B 站拒绝发送',
  21020: '私信发送过于频繁，请稍后再试',
  21026: '不能给自己发送私信',
  21047: '对方主动回复或关注你前，最多发送 1 条私信',
  25003: '对方隐私设置导致无法发送私信',
  60004: 'B 站直播间不存在',
  86095: 'cookie 保活凭据不匹配，请重新扫码登录'
});

function refererFor(service) {
  if (service === 'passport') return 'https://passport.bilibili.com/';
  if (service === 'live') return 'https://live.bilibili.com/';
  if (service === 'vc') return 'https://message.bilibili.com/';
  return 'https://www.bilibili.com/';
}

function readSetCookies(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  } catch {
    return [];
  }
}

function normalizeAllowedCodes(value) {
  if (value == null) return [0];
  return value.map((code) => Number(code));
}

export class BiliApi {
  constructor({
    endpoints = {},
    jar,
    signer = null,
    risk = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxResponseBytes = 8 * 1024 * 1024,
    userAgent = DEFAULT_USER_AGENT,
    now = Date.now,
    logger = null
  } = {}) {
    if (!jar) throw new TypeError('BiliApi 需要 cookie jar');
    if (typeof fetchImpl !== 'function') throw new TypeError('BiliApi 需要 fetch 实现');
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.jar = jar;
    this.signer = signer;
    this.risk = risk;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.userAgent = userAgent;
    this.now = now;
    this.logger = logger;
    this.requests = 0;
    if (this.risk?.setApi) this.risk.setApi(this);
  }

  setSigner(signer) { this.signer = signer; }
  setRisk(risk) {
    this.risk = risk;
    if (risk?.setApi) risk.setApi(this);
  }

  csrf() {
    return this.jar.get('bili_jct') || '';
  }

  get loggedIn() {
    return Boolean(this.jar.get('SESSDATA'));
  }

  requireLogin({ csrf = false } = {}) {
    if (!this.loggedIn) throw new AuthRequiredError();
    if (csrf && !this.csrf()) throw new AuthRequiredError('缺少 bili_jct，请重新扫码登录');
    return true;
  }

  resolveUrl(service, path) {
    const value = String(path ?? '');
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('//')) return `https:${value}`;
    const base = this.endpoints[service];
    if (!base) throw new BridgeError(`未知的 B 站服务基址: ${service}`, { kind: 'CONFIG', code: 500, retcode: 1500 });
    return `${base.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
  }

  async #prepare(args) {
    const method = String(args.method || 'GET').toUpperCase();
    const service = args.service || 'api';
    let url = this.resolveUrl(service, args.path);
    const params = { ...(args.params || {}) };
    if (args.signed) {
      if (!this.signer) throw new BridgeError('请求需要 WBI 签名但未配置 signer', { kind: 'WBI', code: 500, retcode: 1500 });
      const signed = await this.signer.sign(params, { wts: args.wts });
      const query = encodeQuery(signed);
      if (query) url += `${url.includes('?') ? '&' : '?'}${query}`;
    } else {
      const query = encodeQuery(params);
      if (query) url += `${url.includes('?') ? '&' : '?'}${query}`;
    }
    const headers = {
      'user-agent': this.userAgent,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: args.referer || refererFor(service),
      ...(args.headers || {})
    };
    const cookie = this.jar.headerFor(url);
    if (cookie) headers.cookie = cookie;
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      if (args.multipart instanceof FormData) {
        body = args.multipart;
      } else if (args.form) {
        body = encodeQuery(args.form);
        headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      } else if (args.body !== undefined) {
        body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
        headers['content-type'] = headers['content-type'] || 'application/json; charset=UTF-8';
      }
      if (!headers.origin) headers.origin = new URL(headers.referer).origin;
    }
    return { method, url, headers, body, service };
  }

  async #fetchOnce(prepared, args) {
    const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : this.timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (args.signal) signals.push(args.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let response;
    try {
      response = await this.fetchImpl(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        redirect: args.redirect || 'manual',
        signal
      });
    } catch (error) {
      const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new BiliApiError(aborted ? `请求 B 站超时（${timeoutMs}ms）` : '请求 B 站失败', {
        kind: 'NETWORK',
        code: aborted ? 504 : 502,
        retcode: aborted ? 1504 : 1502,
        retryable: true,
        wording: aborted ? 'B 站接口超时，请稍后重试' : '无法连接 B 站接口',
        cause: error
      });
    }
    this.requests += 1;
    const setCookies = readSetCookies(response.headers);
    if (setCookies.length) this.jar.applySetCookie(setCookies, prepared.url);
    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new BiliApiError('读取 B 站响应失败', {
        kind: 'NETWORK', code: 502, retcode: 1502, retryable: true, cause: error
      });
    }
    const maxBytes = Number(args.maxBytes) > 0 ? Number(args.maxBytes) : this.maxResponseBytes;
    if (buffer.length > maxBytes) {
      throw new BiliApiError(`B 站响应过大（${buffer.length} > ${maxBytes} 字节）`, {
        kind: 'PROTOCOL', code: 502, retcode: 1502
      });
    }
    return { response, buffer, setCookies, url: prepared.url };
  }

  #networkRetryDelay(attempt) {
    return 200 * 2 ** attempt + Math.floor(Math.random() * 150);
  }

  async request(args = {}) {
    const method = String(args.method || 'GET').toUpperCase();
    const allowedCodes = normalizeAllowedCodes(args.allowedCodes);
    const attempts = args.retries != null
      ? Math.max(0, Number(args.retries) || 0)
      : (method === 'GET' ? 1 : 0);
    let lastError = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const prepared = await this.#prepare(args);
      let raw;
      try {
        raw = await this.#fetchOnce(prepared, args);
      } catch (error) {
        lastError = error;
        if (error?.retryable && attempt < attempts) {
          await sleep(this.#networkRetryDelay(attempt));
          continue;
        }
        throw error;
      }
      const text = raw.buffer.toString('utf8');
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (payload == null) {
        if (args.expectJson === false) return text;
        const status = raw.response.status;
        if (status >= 500 && attempt < attempts) {
          await sleep(this.#networkRetryDelay(attempt));
          continue;
        }
        throw new BiliApiError(`B 站返回了非 JSON 响应（HTTP ${status}）`, {
          kind: status === 403 ? 'FORBIDDEN' : 'PROTOCOL',
          code: status || 502,
          retcode: status === 403 ? 1403 : 1502,
          retryable: status >= 500,
          url: raw.url
        });
      }
      const hasCode = payload != null
        && Object.prototype.hasOwnProperty.call(payload, 'code')
        && payload.code != null
        && Number.isFinite(Number(payload.code));
      const code = hasCode ? Number(payload.code) : null;
      if (hasCode && allowedCodes.includes(code)) {
        return payload;
      }
      if (!hasCode) {
        if (raw.response.ok) return payload;
        throw new BiliApiError(`B 站接口 HTTP ${raw.response.status}`, {
          kind: 'HTTP',
          code: raw.response.status,
          retcode: raw.response.status === 403 ? 1403 : 1502,
          retryable: raw.response.status >= 500,
          url: raw.url,
          wording: `B 站接口 HTTP ${raw.response.status}`
        });
      }
      const httpStatus = raw.response.status;
      const error = new BiliApiError(BILI_CODE_WORDING[code] || payload?.message || payload?.msg || `B 站接口错误 ${code}`, {
        apiCode: code,
        kind: code === -101 ? 'AUTH' : (code === -352 || code === -412 ? 'RISK' : (httpStatus >= 400 ? 'HTTP' : 'API')),
        code: code === -101 ? 401 : (code === -352 ? 403 : (code === -404 ? 404 : 502)),
        retcode: code === -101 ? 1401 : (code === -352 || code === -412 ? 1403 : 200),
        retryable: code === -509 || code === 12019,
        data: payload?.data ?? null,
        url: raw.url,
        wording: BILI_CODE_WORDING[code] || payload?.message || payload?.msg || ''
      });
      lastError = error;

      if (this.risk && !args.skipRisk && this.risk.capture(payload, { code, url: raw.url })) {
        if (!args.skipRiskExchange && code !== -101) {
          await this.risk.exchange({ csrf: this.csrf() });
        }
        throw new BiliRiskError('B 站触发风控，需要完成人机验证', {
          apiCode: code,
          data: payload?.data ?? null,
          url: raw.url,
          challenge: this.risk.challenge()
        });
      }

      if (args.signed && code === -403 && !args._wbiRetried) {
        // 签名过期/密钥轮换：刷新 WBI 后只重放一次（POST 也安全：服务端已拒绝，未产生副作用）。
        this.signer?.invalidate();
        this.logger?.warn?.('WBI 签名被拒绝，刷新密钥后重试一次', { url: raw.url });
        return this.request({ ...args, _wbiRetried: true });
      }
      if (error.retryable && attempt < attempts) {
        await sleep(this.#networkRetryDelay(attempt));
        continue;
      }
      throw error;
    }
    throw lastError ?? new BiliApiError('B 站请求失败', { kind: 'INTERNAL', code: 500, retcode: 1500 });
  }

  async get(service, path, options = {}) {
    return this.request({ ...options, method: 'GET', service, path });
  }

  async post(service, path, options = {}) {
    return this.request({ ...options, method: 'POST', service, path });
  }

  async fetchText(args = {}) {
    const method = String(args.method || 'GET').toUpperCase();
    const attempts = args.retries != null ? Math.max(0, Number(args.retries) || 0) : 1;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const prepared = await this.#prepare({ ...args, method });
      let raw;
      try {
        raw = await this.#fetchOnce(prepared, args);
      } catch (error) {
        if (error?.retryable && attempt < attempts) { await sleep(this.#networkRetryDelay(attempt)); continue; }
        throw error;
      }
      if (raw.response.status < 200 || raw.response.status >= 300) {
        const status = raw.response.status;
        if (status >= 500 && attempt < attempts) { await sleep(this.#networkRetryDelay(attempt)); continue; }
        throw new BiliApiError(`B 站页面请求失败（HTTP ${status}）`, {
          kind: status === 403 ? 'FORBIDDEN' : 'HTTP',
          code: status,
          retcode: status === 403 ? 1403 : 1502,
          url: raw.url,
          wording: status === 403 ? 'B 站页面拒绝访问' : `B 站页面请求失败（HTTP ${status}）`
        });
      }
      return { text: raw.buffer.toString('utf8'), status: raw.response.status, headers: raw.response.headers, url: raw.url };
    }
    throw new BiliApiError('B 站页面请求失败', { kind: 'NETWORK', code: 502, retcode: 1502 });
  }

  /** 跟随短链重定向，只取最终 URL（不下载页面正文；限制最多 4 跳）。 */
  async resolveFinalUrl(url, { timeoutMs = this.timeoutMs, maxRedirects = 4 } = {}) {
    let current = String(url || '');
    if (!/^https?:\/\//i.test(current)) {
      throw new BridgeError('短链必须是 http(s) URL', { kind: 'INPUT', code: 400, retcode: 1400 });
    }
    for (let hop = 0; hop < maxRedirects; hop += 1) {
      const headers = {
        'user-agent': this.userAgent,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        referer: 'https://www.bilibili.com/'
      };
      const cookie = this.jar.headerFor(current);
      if (cookie) headers.cookie = cookie;
      let response;
      try {
        response = await this.fetchImpl(current, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        throw new BiliApiError('解析 B 站短链失败', {
          kind: 'NETWORK', code: 502, retcode: 1502, retryable: true, wording: '无法解析 B 站短链', cause: error
        });
      }
      try { await response.body?.cancel?.(); } catch { /* ignore */ }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          current = new URL(location, current).toString();
          continue;
        }
      }
      return response.url || current;
    }
    return current;
  }

  async fetchBuffer(args = {}) {
    const method = String(args.method || 'GET').toUpperCase();
    const attempts = args.retries != null ? Math.max(0, Number(args.retries) || 0) : 1;
    const maxBytes = Number(args.maxBytes) > 0 ? Number(args.maxBytes) : (args.sizeLimit || 5 * 1024 * 1024);
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const prepared = await this.#prepare({ ...args, method });
      let raw;
      try {
        raw = await this.#fetchOnce(prepared, { ...args, maxBytes });
      } catch (error) {
        if (error?.retryable && attempt < attempts) { await sleep(this.#networkRetryDelay(attempt)); continue; }
        throw error;
      }
      if (raw.response.status < 200 || raw.response.status >= 300) {
        const status = raw.response.status;
        if (status >= 500 && attempt < attempts) { await sleep(this.#networkRetryDelay(attempt)); continue; }
        throw new BiliApiError(`B 站文件下载失败（HTTP ${status}）`, {
          kind: status === 403 || status === 404 ? 'EXPIRED' : 'HTTP',
          code: status,
          retcode: status === 403 ? 1403 : 1502,
          url: raw.url,
          wording: status === 403 || status === 404 ? 'B 站文件地址已过期或需要登录' : `B 站文件下载失败（HTTP ${status}）`
        });
      }
      return { data: raw.buffer, status: raw.response.status, headers: raw.response.headers, contentType: raw.response.headers.get('content-type') || '', url: raw.url };
    }
    throw new BiliApiError('B 站文件下载失败', { kind: 'NETWORK', code: 502, retcode: 1502 });
  }

  snapshot() {
    return { requests: this.requests, loggedIn: this.loggedIn, endpoints: Object.keys(this.endpoints) };
  }
}
