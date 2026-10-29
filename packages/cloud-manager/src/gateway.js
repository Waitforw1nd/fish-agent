import http from 'node:http';
import net from 'node:net';
import { guardApiBody, isApiAllowed } from './config-guard.js';
import { readBuffer, sendHtml, sendJson, sendText } from './http.js';
import { safeSkillStatus } from './extension-service.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP, 'host', 'cookie', 'origin', 'referer', 'x-console-token',
  'x-csrf-token', 'x-xsrf-token', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'forwarded', 'accept-encoding'
]);

const RESPONSE_STRIP = new Set([...HOP_BY_HOP, 'set-cookie', 'content-length']);

function hostnameOnly(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  return value.replace(/:\d+$/, '');
}

export function classifyHost(hostHeader, baseDomain) {
  const hostname = hostnameOnly(hostHeader);
  const base = String(baseDomain || '').toLowerCase();
  if (!hostname) return { type: 'base', hostname };
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (loopback || hostname === base) return { type: 'base', hostname };
  const reserved = new Set(['www', 'panel', 'app', 'api', 'admin', 'relay', 'auth', 'login', 'static', 'assets', 'health']);
  if (hostname.endsWith(`.${base}`)) {
    const prefix = hostname.slice(0, -1 * (base.length + 1));
    if (!prefix || prefix.includes('.')) return { type: 'invalid', hostname };
    if (reserved.has(prefix)) return { type: 'base', hostname };
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(prefix)) return { type: 'invalid', hostname };
    return { type: 'tenant', hostname, slug: prefix };
  }
  if (base === 'localhost' && hostname.endsWith('.localhost')) {
    const prefix = hostname.slice(0, -'.localhost'.length);
    if (prefix && !prefix.includes('.')) return { type: 'tenant', hostname, slug: prefix };
  }
  // Unknown hosts are treated as the panel; it is still auth protected, but can
  // never be mistaken for a tenant console.
  return { type: 'base', hostname };
}

function requestOrigin(req) {
  const host = String(req.headers.host || '');
  return `http://${host}`;
}

function schemeOf(config, req) {
  if (config.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https' || proto === 'http') return proto;
  }
  return config.publicScheme;
}

function sameSiteOrigin(config, req) {
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  const requestHost = String(req.headers.host || '').toLowerCase();
  const check = (raw) => {
    try {
      const parsed = new URL(raw);
      if (parsed.host.toLowerCase() !== requestHost) return false;
      return parsed.protocol === `${schemeOf(config, req)}:` || (!config.cookieSecure && parsed.protocol === 'http:');
    } catch {
      return false;
    }
  };
  if (origin && !check(origin)) return false;
  if (!origin && referer && String(req.method).toUpperCase() !== 'GET' && !check(referer)) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  return true;
}

export function rewriteLocation(location, upstreamPort, publicOrigin) {
  if (!location) return location;
  try {
    const parsed = new URL(location, `http://127.0.0.1:${upstreamPort}`);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return `${publicOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch { /* relative or opaque */ }
  return location;
}

export class Gateway {
  constructor({ config, tenants, auth, agentRuntime, logger }) {
    this.config = config;
    this.tenants = tenants;
    this.auth = auth;
    this.agentRuntime = agentRuntime;
    this.logger = logger;
    this.connections = new Map();
  }

  track(tenantId, cleanup) {
    let set = this.connections.get(tenantId);
    if (!set) { set = new Set(); this.connections.set(tenantId, set); }
    set.add(cleanup);
    return () => {
      set.delete(cleanup);
      if (set.size === 0) this.connections.delete(tenantId);
    };
  }

  closeTenant(tenantId) {
    const set = this.connections.get(tenantId);
    if (!set) return 0;
    let count = 0;
    for (const cleanup of [...set]) {
      try { cleanup(); count += 1; } catch { /* ignore */ }
    }
    this.connections.delete(tenantId);
    return count;
  }

  closeAll() {
    for (const tenantId of [...this.connections.keys()]) this.closeTenant(tenantId);
  }

  panelLoginUrl(req) {
    const baseHost = this.config.baseDomain;
    const port = this.config.panelPort;
    const isDefault = (this.config.publicScheme === 'http' && port === 80)
      || (this.config.publicScheme === 'https' && port === 443);
    const host = req.headers.host && String(req.headers.host).includes(':') && this.config.baseDomain === 'localhost'
      ? `localhost:${String(req.headers.host).split(':').pop()}`
      : `${baseHost}${isDefault ? '' : `:${port}`}`;
    return `${schemeOf(this.config, req)}://${host}/login`;
  }

  respondError(req, res, error, { tenant = null } = {}) {
    const status = Number(error?.status) || 500;
    const payload = {
      ok: false,
      error: status === 500 ? '服务器内部错误' : String(error?.message || 'request failed'),
      code: error?.code || `HTTP_${status}`
    };
    if (status === 500) this.logger?.error?.('gateway error', error);
    if (String(req.headers.accept || '').includes('text/html')) {
      const home = tenant ? `${schemeOf(this.config, req)}://${req.headers.host}` : '/';
      sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title>
<body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto">
<h1>${status}</h1><p>${escapeHtml(payload.error)}</p>
<p><a href="${escapeHtml(home)}">返回</a></p></body>`);
    } else {
      sendJson(res, status, payload);
    }
  }

  async handle(req, res) {
    const hostInfo = classifyHost(req.headers.host, this.config.baseDomain);
    if (hostInfo.type !== 'tenant') return false;
    if (!sameSiteOrigin(this.config, req)) {
      this.respondError(req, res, Object.assign(new Error('请求来源不被信任'), { status: 403, code: 'ORIGIN_REJECTED' }));
      return true;
    }
    const tenant = this.tenants.bySlug(hostInfo.slug);
    if (!tenant) {
      this.respondError(req, res, Object.assign(new Error('租户不存在'), { status: 404, code: 'TENANT_NOT_FOUND' }));
      return true;
    }
    const auth = this.auth.resolve(req);
    if (!auth) {
      if (String(req.headers.accept || '').includes('text/html')) {
        const next = encodeURIComponent(`${schemeOf(this.config, req)}://${req.headers.host}${req.url}`);
        res.writeHead(302, { location: `${this.panelLoginUrl(req)}?next=${next}`, 'cache-control': 'no-store' });
        res.end();
      } else {
        sendJson(res, 401, { ok: false, error: '请先登录', code: 'UNAUTHENTICATED' });
      }
      return true;
    }
    const role = this.tenants.roleFor(auth.user, tenant.id);
    if (!role) {
      this.respondError(req, res, Object.assign(new Error('无权访问该租户'), { status: 403, code: 'TENANT_FORBIDDEN' }), { tenant });
      return true;
    }
    if (role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())) {
      sendJson(res, 403, { ok: false, error: '当前角色无权修改实例', code: 'INSUFFICIENT_ROLE' });
      return true;
    }
    try {
      this.tenants.assertActive(tenant);
    } catch (error) {
      this.respondError(req, res, error, { tenant });
      return true;
    }
    const port = this.agentRuntime.port(tenant);
    const process = this.agentRuntime.supervisor.status(tenant.id, 'agent');
    if (!port || process.state !== 'running') {
      this.respondError(req, res, Object.assign(new Error('租户宿主未运行，请先在控制台启动'), { status: 503, code: 'AGENT_NOT_RUNNING' }), { tenant });
      return true;
    }
    const parsed = new URL(req.url || '/', requestOrigin(req));
    if (parsed.pathname === '/api/skills/install-zip' && String(req.method).toUpperCase() === 'POST') {
      if (!['owner', 'operator', 'admin'].includes(role)) {
        sendJson(res, 403, { ok: false, error: '无权安装扩展', code: 'TENANT_FORBIDDEN' });
        return true;
      }
      if (!req.headers.origin || !/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers['content-type'] || ''))) {
        sendJson(res, 403, { ok: false, error: '上传请求需要同源 JSON', code: 'ORIGIN_REJECTED' });
        return true;
      }
    }
    if (parsed.pathname.startsWith('/api/') && !isApiAllowed(req.method, parsed.pathname)) {
      sendJson(res, 403, { ok: false, error: '该 API 在云端控制台不可用', code: 'API_NOT_ALLOWED' });
      return true;
    }
    const method = String(req.method).toUpperCase();
    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(parsed.pathname);
    const skillAction = skillMatch && !['reload', 'cleanup', 'install-zip', 'capabilities'].includes(skillMatch[1]);
    const guardedRead = method === 'GET' && [
      '/api/config', '/api/skills', '/api/tools/availability', '/api/skills/capabilities'
    ].includes(parsed.pathname);
    const guardedWrite = method === 'POST' && (parsed.pathname === '/api/config'
      || parsed.pathname === '/api/skills/reload' || parsed.pathname === '/api/skills/cleanup' || skillAction);
    if ((guardedRead || guardedWrite) && !this.agentSettings) {
      sendJson(res, 503, { ok: false, error: '配置安全服务不可用', code: 'GUARD_UNAVAILABLE' });
      return true;
    }
    if (guardedRead) {
      try {
        let result;
        if (parsed.pathname === '/api/config') {
          result = (await this.agentSettings.getConfig(tenant)).config;
        } else {
          const visible = await this.agentSettings.skills(tenant);
          if (parsed.pathname === '/api/tools/availability') {
            result = { categories: visible.categories, tools: (visible.tools || []).map((item) => {
              const safe = safeSkillStatus(item);
              return { id: safe.id, category: safe.category, skillId: safe.skillId ?? null,
                enabled: safe.enabled, code: safe.code ?? null, reason: safe.reason || '' };
            }) };
          } else if (parsed.pathname === '/api/skills/capabilities') {
            const allowed = new Set((visible.skills || []).map((item) => item.id));
            const raw = await this.agentRuntime.request(tenant, 'GET', parsed.pathname);
            result = { capabilities: (raw.capabilities || []).map((capability) => {
              const providers = (capability.providers || []).filter((item) => allowed.has(item.skillId)).map((item) => {
                const safe = safeSkillStatus(item);
                return { skillId: safe.skillId, active: safe.active, code: safe.code ?? null,
                  reason: safe.reason || '', implemented: safe.implemented, usable: safe.usable };
              });
              const available = providers.some((item) => item.usable);
              return { name: capability.name, available,
                reason: available ? '' : '扩展能力当前不可用，请检查运行状态', providers };
            }).filter((capability) => capability.providers.length) };
          } else result = visible;
        }
        sendJson(res, 200, result);
      } catch (error) { this.respondError(req, res, error, { tenant }); }
      return true;
    }
    let bodyBuffer = null;
    let guardWarnings = null;
    if (['POST', 'PUT', 'PATCH'].includes(String(req.method).toUpperCase())) {
      const limit = parsed.pathname === '/api/skills/install-zip' ? 12 * 1024 * 1024 : Math.max(this.config.apiMaxBodyBytes, 4 * 1024 * 1024);
      try {
        const raw = await readBuffer(req, limit);
        if (raw.length && (parsed.pathname === '/api/config' || parsed.pathname === '/api/media-data')) {
          let payload;
          try { payload = JSON.parse(raw.toString('utf8')); } catch {
            sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'INVALID_JSON' });
            return true;
          }
          const guarded = guardApiBody({ method: req.method, pathname: parsed.pathname, body: payload });
          if (parsed.pathname === '/api/config') {
            bodyBuffer = Buffer.from(JSON.stringify(guarded.body.patch));
            guardWarnings = guarded.body.warnings;
          } else {
            bodyBuffer = Buffer.from(JSON.stringify(guarded.body));
            guardWarnings = guarded.warnings;
          }
        } else {
          bodyBuffer = raw;
        }
      } catch (error) {
        this.respondError(req, res, error, { tenant });
        return true;
      }
    }
    if (guardedWrite) {
      try {
        let body = {};
        if (bodyBuffer?.length) {
          try { body = JSON.parse(bodyBuffer.toString('utf8')); }
          catch { throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'INVALID_JSON' }); }
        }
        if (guardWarnings?.length) res.setHeader('x-cloud-guard', encodeURIComponent(JSON.stringify(guardWarnings)));
        const withExtensionLock = (fn) => this.agentSettings.extensionService
          ? this.agentSettings.extensionService.withLock(`tenant:${tenant.id}`, fn) : fn();
        let result;
        if (parsed.pathname === '/api/config') {
          result = await this.agentSettings.locked(tenant, async () => {
            this.agentSettings.assertStable(tenant);
            const response = await this.agentRuntime.request(tenant, 'POST', '/api/config', body);
            response.config = await this.agentSettings.publicConfig(tenant, response.config);
            return response;
          });
        } else if (parsed.pathname === '/api/skills/cleanup') {
          result = await withExtensionLock(() => this.agentSettings.locked(tenant, async () => {
            this.agentSettings.assertStable(tenant);
            const response = await this.agentRuntime.request(tenant, 'POST', parsed.pathname, body);
            response.config = await this.agentSettings.publicConfig(tenant, response.config);
            return response;
          }));
        } else if (parsed.pathname === '/api/skills/reload') {
          result = await withExtensionLock(async () => {
            const response = await this.agentRuntime.request(tenant, 'POST', parsed.pathname, body);
            const visible = await this.agentSettings.skills(tenant);
            const safeIds = (items) => Array.isArray(items)
              ? items.filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(id)) : [];
            const capabilities = safeIds(visible.capabilities);
            const summary = visible.summary || {};
            return {
              loaded: safeIds(response.loaded),
              failed: (Array.isArray(response.failed) ? response.failed : []).map((entry) => ({
                id: safeIds([entry?.id])[0] || '', error: '扩展加载失败，请检查 Agent 日志'
              })),
              pruned: safeIds(response.pruned),
              skills: visible.skills,
              summary: {
                total: Number(summary.total) || 0, active: Number(summary.active) || 0,
                disabled: Number(summary.disabled) || 0, broken: Number(summary.broken) || 0, capabilities
              },
              capabilities
            };
          });
        } else {
          let id;
          try { id = decodeURIComponent(skillMatch[1]); }
          catch { throw Object.assign(new Error('扩展 ID 不合法'), { status: 400, code: 'INVALID_EXTENSION_ID' }); }
          result = await withExtensionLock(() => this.agentSettings.updateSkill(tenant, id, body));
        }
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) { this.respondError(req, res, error, { tenant }); }
      return true;
    }
    this.proxyHttp({ req, res, tenant, port, bodyBuffer, guardWarnings, publicOrigin: `${schemeOf(this.config, req)}://${req.headers.host}` });
    return true;
  }

  proxyHttp({ req, res, tenant, port, bodyBuffer, guardWarnings, publicOrigin }) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (REQUEST_STRIP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = `127.0.0.1:${port}`;
    headers.origin = `http://127.0.0.1:${port}`;
    headers['accept-encoding'] = 'identity';
    const token = this.agentRuntime.consoleHeaders(tenant)['x-console-token'];
    if (token) headers['x-console-token'] = token;
    if (bodyBuffer) headers['content-length'] = String(bodyBuffer.length);
    else if (headers['content-length']) delete headers['content-length'];
    if (guardWarnings?.length) {
      res.setHeader('x-cloud-guard', encodeURIComponent(JSON.stringify(guardWarnings)));
    }
    const isSse = String(req.headers.accept || '').includes('text/event-stream');
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
      timeout: isSse ? 0 : this.config.gatewayTimeoutMs
    });
    let finished = false;
    const cleanup = () => {
      if (!finished) {
        finished = true;
        try { upstream.destroy(); } catch { /* ignore */ }
      }
    };
    const untrack = this.track(tenant.id, cleanup);
    res.on('close', () => { cleanup(); untrack(); });
    upstream.on('timeout', () => {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } }
      else this.respondError(req, res, Object.assign(new Error('上游超时'), { status: 504, code: 'GATEWAY_TIMEOUT' }), { tenant });
      cleanup();
    });
    upstream.on('error', (error) => {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } }
      else this.respondError(req, res, Object.assign(new Error(`上游不可达: ${error.message}`), { status: 502, code: 'UPSTREAM_UNREACHABLE' }), { tenant });
      cleanup();
    });
    upstream.on('response', (upstreamRes) => {
      const outHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (RESPONSE_STRIP.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === 'location') outHeaders[key] = rewriteLocation(value, port, publicOrigin);
        else outHeaders[key] = value;
      }
      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isStream = contentType.includes('text/event-stream');
      if (isStream) {
        outHeaders['x-accel-buffering'] = 'no';
        outHeaders['cache-control'] = 'no-cache, no-transform';
        res.writeHead(upstreamRes.statusCode || 200, outHeaders);
        res.flushHeaders?.();
        res.socket?.setNoDelay?.(true);
      } else {
        res.writeHead(upstreamRes.statusCode || 200, outHeaders);
      }
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => { finished = true; untrack(); });
      upstreamRes.on('error', () => { try { res.destroy(); } catch { /* ignore */ } cleanup(); untrack(); });
    });
    if (bodyBuffer) upstream.end(bodyBuffer);
    else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method).toUpperCase())) req.pipe(upstream);
    else upstream.end();
  }

  upgrade(req, socket, head) {
    const hostInfo = classifyHost(req.headers.host, this.config.baseDomain);
    if (hostInfo.type !== 'tenant') {
      rejectSocket(socket, 404, 'Not Found');
      return;
    }
    if (!sameSiteOrigin(this.config, req)) {
      rejectSocket(socket, 403, 'Origin rejected');
      return;
    }
    const tenant = this.tenants.bySlug(hostInfo.slug);
    if (!tenant) { rejectSocket(socket, 404, 'Tenant not found'); return; }
    const auth = this.auth.resolve(req);
    if (!auth || !this.tenants.roleFor(auth.user, tenant.id)) { rejectSocket(socket, 401, 'Unauthorized'); return; }
    try { this.tenants.assertActive(tenant); } catch (error) { rejectSocket(socket, error.status || 402, error.message); return; }
    const parsed = new URL(req.url || '/', requestOrigin(req));
    if (parsed.pathname.startsWith('/api/') && !isApiAllowed(req.method, parsed.pathname)) {
      rejectSocket(socket, 403, 'API not allowed');
      return;
    }
    const port = this.agentRuntime.port(tenant);
    const process = this.agentRuntime.supervisor.status(tenant.id, 'agent');
    if (!port || process.state !== 'running') { rejectSocket(socket, 503, 'Agent not running'); return; }

    const token = this.agentRuntime.consoleHeaders(tenant)['x-console-token'];
    const lines = [`GET ${req.url} HTTP/1.1`];
    const skip = new Set([...REQUEST_STRIP, 'sec-websocket-origin']);
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (skip.has(key.toLowerCase())) continue;
      lines.push(`${key}: ${value}`);
    }
    lines.push(`Host: 127.0.0.1:${port}`);
    lines.push(`Origin: http://127.0.0.1:${port}`);
    if (token) lines.push(`x-console-token: ${token}`);
    lines.push('Connection: Upgrade', 'Upgrade: websocket');
    lines.push('', '');
    const upstream = net.connect({ host: '127.0.0.1', port });
    const closeBoth = () => {
      try { upstream.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    };
    const untrack = this.track(tenant.id, closeBoth);
    upstream.setNoDelay?.(true);
    socket.setNoDelay?.(true);
    upstream.on('connect', () => {
      upstream.write(lines.join('\r\n'));
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      rejectSocket(socket, 502, 'Bad Gateway');
      closeBoth();
      untrack();
    });
    socket.on('error', () => { closeBoth(); untrack(); });
    socket.on('close', () => { closeBoth(); untrack(); });
    upstream.on('close', () => { closeBoth(); untrack(); });
  }
}

function rejectSocket(socket, status, message) {
  try {
    const body = String(message || '');
    socket.write(`HTTP/1.1 ${status} ${body || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch { /* ignore */ }
  socket.destroy();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
