import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.BILI_ONEBOT_PORT);
const adminToken = String(process.env.BILI_ADMIN_TOKEN || '');
const onebotToken = String(process.env.BILI_ONEBOT_TOKEN || '');
const dataDir = process.env.BILI_BRIDGE_DATA_DIR || process.cwd();
fs.mkdirSync(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'fake-bili-state.json');
const state = {
  online: process.env.FAKE_BILI_ONLINE === '1',
  mid: process.env.FAKE_BILI_MID || '123456',
  name: 'Fake Bili',
  qr: {
    qrcodeKey: 'fake-qr-key',
    url: 'https://bili.example.test/qr',
    state: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 180_000,
    scannedAt: null,
    polls: 0,
    message: '等待扫码'
  },
  subscriptions: {
    at: process.env.BILI_SUBSCRIBE_AT !== 'false',
    up: process.env.BILI_SUBSCRIBE_UP !== 'false',
    dm: process.env.BILI_SUBSCRIBE_DM !== 'false',
    live: process.env.BILI_SUBSCRIBE_LIVE === 'true'
  },
  watches: {
    videos: [],
    ups: String(process.env.BILI_WATCH_UPS || '').split(',').filter(Boolean),
    liveRooms: String(process.env.BILI_WATCH_LIVE_ROOMS || '').split(',').filter(Boolean)
  },
  lastError: null
};
try {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  Object.assign(state, saved);
} catch { /* ignore */ }
function persist() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
persist();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function ok(res, data) { json(res, 200, { ok: true, data }); }
function bad(res, status, wording) { json(res, status, { ok: false, error: { kind: 'TEST', code: status, retcode: status, wording } }); }
function authed(req) {
  return adminToken && (req.headers['x-admin-token'] === adminToken || req.headers.authorization === `Bearer ${adminToken}`);
}
async function readBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
function qrData() {
  return {
    ...state.qr,
    account: state.online ? { loggedIn: true, mid: state.mid, name: state.name, avatar: '' } : null
  };
}
function adminStatus() {
  return {
    ok: true,
    tenantId: process.env.BILI_BRIDGE_TENANT || 'default',
    version: '0.1.0',
    self: state.online ? { mid: state.mid, name: state.name } : { mid: '', name: '' },
    bili: {
      loggedIn: state.online,
      account: { loggedIn: state.online, mid: state.online ? state.mid : null, name: state.online ? state.name : '', avatar: '' },
      qr: state.qr,
      lastError: state.lastError
    },
    cookies: { lastCheckAt: Date.now(), lastCheck: state.online, lastRefreshAt: null, refreshCount: 0, lastError: null },
    subscriptions: { ...state.subscriptions },
    watches: {
      videos: [...state.watches.videos],
      ups: [...state.watches.ups],
      liveRooms: [...state.watches.liveRooms]
    },
    pollers: {
      msgfeed: { enabled: state.subscriptions.at, lastRunAt: Date.now(), lastError: null },
      comment: { enabled: state.subscriptions.at, lastRunAt: Date.now(), lastError: null },
      up: { enabled: state.subscriptions.up, lastRunAt: Date.now(), lastError: null },
      dm: { enabled: state.subscriptions.dm, lastRunAt: Date.now(), lastError: null }
    },
    watchers: { msgfeed: {}, comment: {}, up: {}, dm: {} },
    queues: { comment: { pending: 0, lastError: null }, dm: { pending: 0, lastError: null }, live: { pending: 0, lastError: null } },
    live: { clients: [] },
    liveStatus: {},
    liveSyncError: null,
    risk: { limited: false }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health') return ok(res, { ok: true, service: 'bili-bridge' });
  if (url.pathname === '/__fake/online' && req.method === 'POST') {
    if (!authed(req)) return bad(res, 401, '管理令牌无效');
    const body = await readBody(req);
    state.online = true;
    state.mid = body.mid || state.mid;
    state.name = body.name || body.nickname || state.name;
    state.qr.state = 'success';
    persist();
    return ok(res, state);
  }
  if (!url.pathname.startsWith('/admin')) {
    if (req.headers.authorization !== `Bearer ${onebotToken}` && req.headers['x-access-token'] !== onebotToken) {
      return json(res, 401, { status: 'failed', retcode: 401, wording: 'unauthorized' });
    }
    return json(res, 200, { status: 'ok', retcode: 0, data: { user_id: Number(state.mid), nickname: state.name } });
  }
  if (!authed(req)) return bad(res, 401, '管理令牌无效');
  if (url.pathname === '/admin/status') return ok(res, adminStatus());
  if (url.pathname === '/admin/health') return ok(res, { ok: true, service: 'bili-bridge' });
  if (url.pathname === '/admin/login/qr' && req.method === 'POST') {
    state.qr = {
      qrcodeKey: `fake-${Date.now()}`,
      url: 'https://bili.example.test/qr',
      state: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 180_000,
      scannedAt: null,
      polls: 0,
      message: '等待扫码'
    };
    persist();
    return ok(res, qrData());
  }
  if (url.pathname === '/admin/login/qr' && req.method === 'GET') {
    state.qr.polls += 1;
    if (state.online) state.qr.state = 'success';
    persist();
    return ok(res, qrData());
  }
  if (url.pathname === '/admin/subscriptions' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    for (const key of ['at', 'up', 'dm', 'live']) {
      if (body[key] !== undefined) state.subscriptions[key] = Boolean(body[key]);
    }
    persist();
    return ok(res, { ...state.subscriptions });
  }
  if (url.pathname === '/admin/watches' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    if (Array.isArray(body.ups)) state.watches.ups = body.ups.map(String);
    if (Array.isArray(body.liveRooms)) state.watches.liveRooms = body.liveRooms.map(String);
    persist();
    return ok(res, { ...state.watches });
  }
  if (url.pathname === '/admin/logout' && req.method === 'POST') {
    state.online = false;
    state.qr.state = 'pending';
    persist();
    return ok(res, { loggedIn: false });
  }
  return bad(res, 404, `unknown ${req.method} ${url.pathname}`);
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(dataDir, 'fake-bili-ready.json'), JSON.stringify({ port, pid: process.pid }));
});
process.on('SIGTERM', () => {
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
});
