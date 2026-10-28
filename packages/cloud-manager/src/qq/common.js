import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export function requestJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 3000, lookup = undefined } = {}) {
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
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* text response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
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
