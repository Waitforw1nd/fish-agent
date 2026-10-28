import { URL } from 'node:url';

export function createRouter() {
  const routes = [];
  return {
    add(method, path, handler) {
      routes.push({ method: String(method).toUpperCase(), segments: splitPath(path), handler, path });
      return this;
    },
    get(path, handler) { return this.add('GET', path, handler); },
    post(path, handler) { return this.add('POST', path, handler); },
    put(path, handler) { return this.add('PUT', path, handler); },
    patch(path, handler) { return this.add('PATCH', path, handler); },
    delete(path, handler) { return this.add('DELETE', path, handler); },
    match(method, pathname) {
      const parts = splitPath(pathname);
      const verb = String(method).toUpperCase();
      for (const route of routes) {
        if (route.method !== verb && route.method !== '*' && !(verb === 'HEAD' && route.method === 'GET')) continue;
        if (route.segments.length !== parts.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < parts.length; i += 1) {
          const expected = route.segments[i];
          if (expected.startsWith(':')) params[expected.slice(1)] = parts[i];
          else if (expected !== parts[i]) { matched = false; break; }
        }
        if (matched) return { route, params };
      }
      return null;
    },
    list() { return routes.map((route) => ({ method: route.method, path: route.path })); }
  };
}

function splitPath(value) {
  return String(value || '/').split('/').filter(Boolean);
}

export function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
}

export function sendHtml(res, status, html, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(html);
}

export async function readJson(req, maxBytes = 1024 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes) {
    throw Object.assign(new Error('请求体过大'), { status: 413, code: 'BODY_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!total) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'INVALID_JSON' });
  }
}

export async function readBuffer(req, maxBytes = 1024 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes) {
    throw Object.assign(new Error('请求体过大'), { status: 413, code: 'BODY_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function requestIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return normalizeIp(forwarded);
  }
  return normalizeIp(req.socket?.remoteAddress || '');
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

export function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

export function parseUrl(req, base = 'http://127.0.0.1') {
  return new URL(req.url || '/', base);
}

export function errorPayload(error) {
  const status = Number(error?.status) || 500;
  const code = error?.code || (status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`);
  const message = status === 500 ? '服务器内部错误' : String(error?.message || 'request failed');
  const payload = { ok: false, error: message, code };
  for (const key of ['retryAfterMs', 'expiresAt', 'authToken', 'helpUrl', 'balanceMicros', 'heldMicros', 'availableMicros', 'requiredMicros']) {
    if (error?.[key] !== undefined) payload[key] = error[key];
  }
  return { status, payload };
}
