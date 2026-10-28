function defaultPathFor(host, pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const index = pathname.lastIndexOf('/');
  if (index <= 0) return '/';
  return pathname.slice(0, index);
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^\./, '');
}

function domainMatches(host, domain) {
  const h = String(host || '').toLowerCase();
  const d = normalizeDomain(domain);
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(requestPath, cookiePath) {
  const path = requestPath || '/';
  const cookie = cookiePath || '/';
  if (path === cookie) return true;
  if (!path.startsWith(cookie)) return false;
  return cookie.endsWith('/') || path[cookie.length] === '/';
}

function parseExpires(text) {
  const value = Date.parse(text);
  return Number.isFinite(value) ? value : null;
}

function parseSetCookie(header) {
  const text = String(header ?? '');
  const parts = text.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: '',
    path: '',
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: '',
    hostOnly: true
  };
  if (!cookie.name) return null;
  for (const part of parts) {
    const index = part.indexOf('=');
    const key = (index >= 0 ? part.slice(0, index) : part).trim().toLowerCase();
    const value = index >= 0 ? part.slice(index + 1).trim() : '';
    if (key === 'domain') {
      cookie.domain = normalizeDomain(value);
      cookie.hostOnly = !cookie.domain;
    } else if (key === 'path') {
      cookie.path = value || '/';
    } else if (key === 'expires') {
      cookie.expires = parseExpires(value);
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.maxAge = seconds;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'samesite') {
      cookie.sameSite = value;
    }
  }
  return cookie;
}

/**
 * 最小但完整的 cookie jar：域名/路径匹配、Secure、过期、Max-Age 删除、Set-Cookie 与
 * 跨域登录跳转 query 导入。值是秘密，只在内存与 SecretStore 密文里出现。
 */
export class CookieJar {
  #cookies = new Map();

  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  #currentTime() {
    return typeof this.now === 'function' ? this.now() : Number(this.now);
  }

  static fromJSON(data, { now = Date.now } = {}) {
    const jar = new CookieJar({ now });
    const list = Array.isArray(data) ? data : data?.cookies;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item?.name || item.value == null) continue;
        jar.set(item.name, String(item.value), {
          domain: item.domain || '',
          path: item.path || '/',
          expires: item.expires ?? null,
          secure: Boolean(item.secure),
          httpOnly: Boolean(item.httpOnly),
          sameSite: item.sameSite || '',
          hostOnly: item.hostOnly ?? true
        });
      }
    }
    return jar;
  }

  #key(cookie) {
    return `${normalizeDomain(cookie.domain)}|${cookie.path || '/'}|${cookie.name}`;
  }

  #isExpired(cookie) {
    return cookie.expires != null && Number(cookie.expires) <= this.#currentTime();
  }

  #purgeExpired() {
    for (const [key, cookie] of this.#cookies) {
      if (this.#isExpired(cookie)) this.#cookies.delete(key);
    }
  }

  set(name, value, {
    domain = '',
    path = '/',
    expires = null,
    secure = false,
    httpOnly = false,
    sameSite = '',
    hostOnly = true
  } = {}) {
    const cookie = {
      name: String(name),
      value: String(value ?? ''),
      domain: normalizeDomain(domain),
      path: path || '/',
      expires: expires == null ? null : Number(expires),
      secure: Boolean(secure),
      httpOnly: Boolean(httpOnly),
      sameSite: sameSite || '',
      hostOnly: Boolean(hostOnly)
    };
    if (!cookie.name) throw new TypeError('cookie 名不能为空');
    const key = this.#key(cookie);
    this.#cookies.delete(key); // 保持 Map 插入序 = 最近更新
    this.#cookies.set(key, cookie);
    return cookie;
  }

  applySetCookie(setCookies, url) {
    const list = Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : []);
    let parsedUrl = null;
    try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
    const host = parsedUrl?.hostname || '';
    for (const header of list) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      const maxAge = cookie.maxAge;
      delete cookie.maxAge;
      if (maxAge != null && maxAge <= 0) {
        this.delete(cookie.name, { domain: cookie.domain || host, path: cookie.path || '/' });
        continue;
      }
      if (!cookie.domain) {
        cookie.domain = host;
        cookie.hostOnly = true;
      } else {
        cookie.hostOnly = false;
      }
      if (!cookie.path) cookie.path = defaultPathFor(host, parsedUrl?.pathname || '/');
      if (maxAge != null && maxAge > 0) cookie.expires = this.#currentTime() + maxAge * 1000;
      this.set(cookie.name, cookie.value, cookie);
    }
    return this;
  }

  get(name, { url } = {}) {
    this.#purgeExpired();
    let best = null;
    for (const cookie of this.#cookies.values()) {
      if (cookie.name !== name) continue;
      if (url) {
        const parsed = new URL(url);
        if (cookie.secure && parsed.protocol !== 'https:') continue;
        if (!domainMatches(parsed.hostname, cookie.domain)) continue;
        if (!pathMatches(parsed.pathname || '/', cookie.path)) continue;
      }
      if (!best || (cookie.path?.length ?? 0) > (best.path?.length ?? 0)) best = cookie;
    }
    return best?.value ?? null;
  }

  getCookie(name, options) {
    return this.get(name, options);
  }

  has(name, options) {
    this.#purgeExpired();
    return this.get(name, options) != null;
  }

  getAll(url) {
    this.#purgeExpired();
    if (!url) return [...this.#cookies.values()].map((cookie) => ({ ...cookie }));
    const parsed = new URL(url);
    return [...this.#cookies.values()]
      .filter((cookie) => {
        if (cookie.secure && parsed.protocol !== 'https:') return false;
        return domainMatches(parsed.hostname, cookie.domain) && pathMatches(parsed.pathname || '/', cookie.path);
      })
      .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
      .map((cookie) => ({ ...cookie }));
  }

  headerFor(url) {
    return this.getAll(url).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  delete(name, { domain = '', path = '' } = {}) {
    for (const [key, cookie] of this.#cookies) {
      if (cookie.name !== name) continue;
      if (domain && normalizeDomain(cookie.domain) !== normalizeDomain(domain)) continue;
      if (path && cookie.path !== path) continue;
      this.#cookies.delete(key);
    }
    return this;
  }

  clear() {
    this.#cookies.clear();
    return this;
  }

  get size() {
    this.#purgeExpired();
    return this.#cookies.size;
  }

  names() {
    this.#purgeExpired();
    return [...new Set([...this.#cookies.values()].map((cookie) => cookie.name))];
  }

  toJSON() {
    this.#purgeExpired();
    return { version: 1, cookies: [...this.#cookies.values()].map((cookie) => ({ ...cookie })) };
  }

  /** 登录跳转 URL 的 query 里带 Cookie（B 站扫码成功后的 crossDomain 跳转）。 */
  setFromRedirectUrl(url, names = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
    const raw = String(url ?? '');
    const queryIndex = raw.indexOf('?');
    if (queryIndex < 0) return [];
    const allowed = new Set(names);
    const applied = [];
    for (const pair of raw.slice(queryIndex + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      let key;
      try { key = decodeURIComponent(pair.slice(0, eq)); } catch { key = pair.slice(0, eq); }
      if (!allowed.has(key)) continue;
      const value = pair.slice(eq + 1); // 保留 %2C 等原始编码，SESSDATA 不能二次解码
      if (!value) continue;
      this.set(key, value, { domain: 'bilibili.com', hostOnly: false, path: '/' });
      applied.push(key);
    }
    return applied;
  }

  /** 只读的脱敏快照：键存在性可用于诊断，值绝不外流。 */
  publicSnapshot() {
    return this.names().sort().map((name) => ({ name, present: true }));
  }
}

export const BILI_SESSION_COOKIES = Object.freeze([
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4'
]);
