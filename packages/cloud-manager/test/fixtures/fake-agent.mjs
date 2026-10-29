import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
const configPath = path.join(dataDir, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* keep empty */ }
const port = Number(process.env.QQ_AGENT_PORT || config.server?.port || 3210);
const token = String(config.server?.token || '');
const requestLog = path.join(dataDir, 'fake-agent-requests.jsonl');
const writeLog = path.join(dataDir, 'fake-agent-config-writes.jsonl');

function record(entry) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
  } catch { /* ignore */ }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function tokenMatches(req) {
  return !token || req.headers['x-console-token'] === token;
}

const sseClients = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  for await (const chunk of req) body += chunk;
  record({
    method: req.method,
    path: url.pathname,
    query: url.search,
    host: req.headers.host || null,
    origin: req.headers.origin || null,
    referer: req.headers.referer || null,
    cookiePresent: Boolean(req.headers.cookie),
    tokenMatches: tokenMatches(req),
    body
  });
  if (req.headers.host !== `127.0.0.1:${port}`) {
    json(res, 421, { ok: false, error: 'bad host' });
    return;
  }
  if (url.pathname.startsWith('/api/') && !tokenMatches(req)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>fake agent console</h1></body></html>');
    return;
  }
  if (url.pathname === '/__state') {
    let entries = [];
    try { entries = fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { /* ignore */ }
    json(res, 200, { ok: true, entries });
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    sseClients.add(res);
    const timer = setInterval(() => {
      try { res.write(`event: tick\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); } catch { /* ignore */ }
    }, 100);
    timer.unref?.();
    res.on('close', () => { clearInterval(timer); sseClients.delete(res); });
    return;
  }
  if (url.pathname === '/api/status') {
    json(res, 200, {
      onebot: { connected: true, everConnected: true, error: null, self: { userId: '10001', nickname: 'fake' } },
      fake: true,
      port
    });
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const safe = JSON.parse(JSON.stringify(config));
    if (safe.server) safe.server.token = '';
    json(res, 200, safe);
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    fs.appendFileSync(writeLog, `${JSON.stringify(parsed)}\n`);
    json(res, 200, { ok: true, config: parsed });
    return;
  }
  if (url.pathname === '/api/logs') {
    json(res, 200, { logs: [] });
    return;
  }
  if (url.pathname === '/api/pause') {
    json(res, 200, { ok: true, paused: req.method !== 'DELETE' });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, 200, { ok: true, path: url.pathname, method: req.method });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  record({ method: 'UPGRADE', path: url.pathname, host: req.headers.host || null, origin: req.headers.origin || null, cookiePresent: Boolean(req.headers.cookie), tokenMatches: tokenMatches(req) });
  if (req.headers.host !== `127.0.0.1:${port}` || !tokenMatches(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => ws.send(`pong:${data}`));
    ws.send('hello');
  });
});

server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'fake-agent-ready.json'), JSON.stringify({ port, pid: process.pid, tokenHash: token ? crypto.createHash('sha256').update(token).digest('hex') : null }));
  if (process.env.QQ_AGENT_READY_IPC === '1' && process.connected && process.send) {
    process.send({ type: 'fish-agent-listening', pid: process.pid, port }, () => {});
  }
});

process.on('SIGTERM', () => { try { server.close(); } catch { /* ignore */ } process.exit(0); });
