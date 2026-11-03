import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export function requestJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 3000, lookup = undefined, maxBytes = Infinity, deadlineMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { reject(error); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = body === null || body === undefined
      ? null
      : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      lookup,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      let text = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { req.destroy(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' })); return; }
        text += chunk;
      });
      res.on('end', () => {
        clearTimeout(deadline);
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* text response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
      res.on('error', error => { clearTimeout(deadline); reject(error); });
      res.on('aborted', () => { clearTimeout(deadline); reject(Object.assign(new Error('response aborted'), { code: 'RESPONSE_ABORTED' })); });
    });
    const deadline = deadlineMs > 0 ? setTimeout(() => req.destroy(Object.assign(new Error('request deadline exceeded'), { code: 'ETIMEDOUT' })), deadlineMs) : null;
    deadline?.unref?.();
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    if (payload) req.write(payload);
    req.end();
  });
}

export function llbotWebuiHeaders(password) {
  const hash = crypto.createHash('sha256').update(String(password)).digest('hex');
  return { 'x-webui-token': hash };
}

export function isPortListening(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.unref?.();
  });
}

export function normalizedOnebotStatus(response) {
  const body = response?.body;
  if (!body) return { ok: false, error: `HTTP ${response?.status ?? 'no response'}` };
  if (body.status === 'ok' || body.retcode === 0) {
    const data = body.data || {};
    return { ok: true, userId: data.user_id ? String(data.user_id) : null, nickname: data.nickname || null, data };
  }
  return { ok: false, error: body.wording || body.message || `retcode=${body.retcode}` };
}
