import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeError, asBridgeError } from '../errors.js';
import { constantTimeEqual, safeJsonParse } from '../util.js';
import { buildHeartbeatEvent, buildLifecycleEvent } from './message.js';

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders
  });
  res.end(body);
}

function readHeaderToken(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(req.headers['x-access-token'] || req.headers['x-admin-token'] || '').trim();
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.write([
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}`,
    'content-type: text/plain; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    '',
    body
  ].join('\r\n'));
  socket.destroy();
}

/**
 * OneBot v11 正向 WS（事件推送）+ HTTP action（兼容根路径 {action,params} 与 /<action>）。
 * 管理 API 同端口 /admin，使用独立 admin token；无 token 时管理接口直接 503。
 */
export class OneBotServer {
  constructor({
    host = '127.0.0.1',
    port = 0,
    path = '/',
    token = '',
    adminToken = '',
    actionHandler,
    adminHandler = null,
    bridge = null,
    heartbeatIntervalMs = 30_000,
    logger = null,
    maxBodyBytes = DEFAULT_MAX_BODY
  } = {}) {
    if (typeof actionHandler !== 'function') throw new TypeError('OneBotServer 需要 actionHandler');
    this.host = host;
    this.port = port;
    this.path = path || '/';
    this.token = String(token || '');
    this.adminToken = String(adminToken || '');
    this.actionHandler = actionHandler;
    this.adminHandler = adminHandler;
    this.bridge = bridge;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.maxBodyBytes = maxBodyBytes;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.heartbeatTimer = null;
    this.started = false;
    this.allowedUpgradePaths = new Set([this.path, '/ws', '/onebot/v11/ws']);
    if (this.path.endsWith('/') && this.path !== '/') this.allowedUpgradePaths.add(this.path.slice(0, -1));
  }

  get address() {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address : null;
  }

  #checkToken(req, url) {
    if (!this.token) return true;
    const queryToken = url.searchParams.get('access_token') || '';
    const headerToken = readHeaderToken(req);
    if (queryToken && constantTimeEqual(queryToken, this.token)) return true;
    if (headerToken && constantTimeEqual(headerToken, this.token)) return true;
    return false;
  }

  #checkAdmin(req) {
    if (!this.adminToken) return false;
    // 管理令牌只接受请求头，避免出现在 URL/代理日志中。
    const headerToken = readHeaderToken(req);
    return Boolean(headerToken) && constantTimeEqual(headerToken, this.adminToken);
  }

  async #readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > this.maxBodyBytes) {
        throw new BridgeError('HTTP body 过大', { kind: 'INPUT', code: 413, retcode: 1413, wording: '请求体过大' });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async #handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', `http://${this.host}:${this.port || 80}`);
    } catch {
      sendJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: '非法 URL' });
      return;
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'bili-bridge',
        version: '0.1.0',
        wsClients: this.clients.size
      });
      return;
    }
    if (pathname.startsWith('/admin')) {
      if (!this.adminToken) {
        sendJson(res, 503, {
          ok: false,
          error: { kind: 'DISABLED', code: 503, retcode: 1503, wording: '管理 API 未启用：未配置 BILI_ADMIN_TOKEN' }
        });
        return;
      }
      if (!this.#checkAdmin(req)) {
        sendJson(res, 401, {
          ok: false,
          error: { kind: 'AUTH', code: 401, retcode: 1401, wording: '管理令牌无效' }
        });
        return;
      }
      if (!this.adminHandler) {
        sendJson(res, 503, {
          ok: false,
          error: { kind: 'DISABLED', code: 503, retcode: 1503, wording: '管理 API 未挂载' }
        });
        return;
      }
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          const text = await this.#readBody(req);
          body = text ? safeJsonParse(text, null) : null;
          if (text && body == null) throw new BridgeError('管理请求不是合法 JSON', { kind: 'INPUT', code: 400, retcode: 1400 });
        } catch (error) {
          const err = asBridgeError(error);
          sendJson(res, err.code || 400, { ok: false, error: { kind: err.kind, code: err.code, retcode: err.retcode, wording: err.wording } });
          return;
        }
      }
      const query = Object.fromEntries(url.searchParams);
      const result = await this.adminHandler({ method: req.method, pathname, query, body });
      sendJson(res, result.status, result.payload);
      return;
    }

    if (!this.#checkToken(req, url)) {
      sendJson(res, 401, { status: 'failed', retcode: 401, data: null, wording: 'OneBot 访问令牌无效' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { status: 'failed', retcode: 1405, data: null, wording: 'OneBot action 只接受 POST' });
      return;
    }
    let text;
    try {
      text = await this.#readBody(req);
    } catch (error) {
      const err = asBridgeError(error);
      sendJson(res, err.code === 413 ? 413 : 400, { status: 'failed', retcode: err.retcode, data: null, wording: err.wording });
      return;
    }
    const body = text ? safeJsonParse(text, null) : null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: '请求体必须是 JSON 对象' });
      return;
    }
    let action;
    let params;
    let echo;
    if (pathname === '/') {
      action = body.action;
      params = body.params ?? {};
      echo = body.echo;
    } else {
      action = pathname.slice(1);
      params = body;
      echo = body.echo;
    }
    if (!action) {
      sendJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: '缺少 action' });
      return;
    }
    try {
      const result = await this.actionHandler(action, params, echo);
      sendJson(res, 200, result);
    } catch (error) {
      const err = asBridgeError(error);
      sendJson(res, 200, { status: 'failed', retcode: err.retcode, data: null, wording: err.wording, ...(echo !== undefined ? { echo } : {}) });
    }
  }

  #upgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', `http://${this.host}:${this.port || 80}`);
    } catch {
      rejectUpgrade(socket, 400, 'bad url');
      return;
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!this.allowedUpgradePaths.has(pathname)) {
      rejectUpgrade(socket, 404, 'not found');
      return;
    }
    if (!this.#checkToken(req, url)) {
      rejectUpgrade(socket, 401, 'unauthorized');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  #handleWsConnection(ws) {
    this.clients.add(ws);
    const selfId = this.bridge?.selfId;
    if (selfId) this.#send(ws, buildLifecycleEvent({ selfId }));
    ws.on('message', async (data) => {
      let payload;
      try { payload = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
      if (!payload || typeof payload !== 'object' || !payload.action) return;
      try {
        const result = await this.actionHandler(payload.action, payload.params || {}, payload.echo);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
      } catch (error) {
        const err = asBridgeError(error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ status: 'failed', retcode: err.retcode, data: null, wording: err.wording, ...(payload.echo !== undefined ? { echo: payload.echo } : {}) }));
        }
      }
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  #send(ws, event) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(event) {
    const text = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(text); sent += 1; } catch (error) { this.logger?.debug?.('WS 推送失败', error); }
    }
    return sent;
  }

  notifyReady() {
    if (!this.bridge?.selfId) return 0;
    return this.broadcast(buildLifecycleEvent({ selfId: this.bridge.selfId }));
  }

  async start() {
    if (this.started) return this;
    this.server = http.createServer((req, res) => {
      this.#handleHttp(req, res).catch((error) => {
        this.logger?.error?.('OneBot HTTP 处理异常', error);
        if (!res.headersSent) {
          sendJson(res, 500, { status: 'failed', retcode: 1500, data: null, wording: '内部错误' });
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxBodyBytes });
    this.wss.on('connection', (ws) => this.#handleWsConnection(ws));
    this.server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening);
        try { this.server?.close(); } catch { /* ignore */ }
        reject(new BridgeError(`OneBot 端口监听失败: ${error?.message || error}`, {
          kind: 'NETWORK', code: 502, retcode: 1502, cause: error
        }));
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    this.started = true;
    const address = this.address;
    this.port = address?.port ?? this.port;
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.bridge?.selfId || !this.clients.size) return;
        this.broadcast(buildHeartbeatEvent({
          selfId: this.bridge.selfId,
          intervalMs: this.heartbeatIntervalMs,
          status: true
        }));
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
    if (!this.token) this.logger?.warn?.('OneBot token 未配置：当前仅依赖回环绑定，生产环境必须配置 BILI_ONEBOT_TOKEN');
    if (!this.adminToken) this.logger?.warn?.('管理 API 未启用：未配置 BILI_ADMIN_TOKEN');
    this.logger?.info?.('OneBot 服务已监听', { host: this.host, port: this.port, path: this.path });
    return this;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const ws of this.clients) {
      try { ws.close(1001, 'server stopping'); } catch { /* ignore */ }
      try { ws.terminate?.(); } catch { /* ignore */ }
    }
    this.clients.clear();
    await new Promise((resolve) => {
      if (!this.wss) return resolve();
      try { this.wss.close(() => resolve()); } catch { resolve(); }
    });
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      try {
        this.server.close(() => resolve());
        this.server.closeAllConnections?.();
      } catch {
        resolve();
      }
    });
    this.wss = null;
    this.server = null;
  }

  status() {
    return {
      host: this.host,
      port: this.port,
      path: this.path,
      clients: this.clients.size,
      tokenConfigured: Boolean(this.token),
      adminConfigured: Boolean(this.adminToken)
    };
  }
}
