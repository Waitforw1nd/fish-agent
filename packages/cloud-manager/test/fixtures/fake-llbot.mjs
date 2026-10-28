import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const cwd = process.cwd();
const dataDir = path.join(cwd, 'data');
const files = fs.readdirSync(dataDir).filter((name) => /^config_\d+\.json$/.test(name));
const configFile = files.sort().pop();
if (!configFile) {
  console.error('fake-llbot: no config_<uin>.json in', dataDir);
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(path.join(dataDir, configFile), 'utf8'));
const uin = configFile.replace(/^config_/, '').replace(/\.json$/, '');
const password = fs.existsSync(path.join(dataDir, 'webui_token.txt'))
  ? fs.readFileSync(path.join(dataDir, 'webui_token.txt'), 'utf8').trim()
  : '';
const expectedHash = password ? crypto.createHash('sha256').update(password).digest('hex') : '';
const authTokenPath = path.join(dataDir, 'auth_token.txt');
const statePath = path.join(dataDir, 'fake-llbot-state.json');
const state = {
  online: process.env.FAKE_LLBOT_ONLINE === '1',
  uin,
  nick: 'Fake QQ',
  hasToken: fs.existsSync(authTokenPath),
  validation: fs.existsSync(authTokenPath) ? 'valid' : 'idle'
};
try {
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  Object.assign(state, saved);
} catch { /* ignore */ }

function persist() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}
persist();

const webuiPort = Number(config.webui?.port);
if (!webuiPort) {
  console.error('fake-llbot: missing webui.port');
  process.exit(2);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
  return expectedHash && req.headers['x-webui-token'] === expectedHash;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!authorized(req)) return json(res, 403, { success: false, message: '请输入密码' });
  if (url.pathname === '/__fake/online' && req.method === 'POST') {
    const body = await readBody(req);
    state.online = true;
    if (body.uin) state.uin = String(body.uin);
    state.nick = body.nick || state.nick;
    persist();
    return json(res, 200, { success: true, data: state });
  }
  if (url.pathname === '/__fake/offline' && req.method === 'POST') {
    state.online = false;
    persist();
    return json(res, 200, { success: true, data: state });
  }
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { success: false, message: 'not found' });
  if (url.pathname === '/api/login-info') {
    return json(res, 200, {
      success: true,
      data: { online: state.online, uin: state.online ? state.uin : '', nick: state.online ? state.nick : '', mode: 'direct' }
    });
  }
  if (url.pathname === '/api/auth-token/status') {
    return json(res, 200, {
      success: true,
      data: {
        applicable: true,
        online: state.online,
        hasToken: state.hasToken,
        validation: state.validation,
        message: state.hasToken ? '' : '尚未配置 Auth Token',
        loginError: '',
        authTokenPageUrl: 'https://auth.example.test'
      }
    });
  }
  if (url.pathname === '/api/login-qrcode') {
    return json(res, 200, {
      success: true,
      data: {
        qrcodeUrl: `https://qr.example.test/${uin}`,
        pngBase64QrcodeData: 'data:image/png;base64,iVBORw0KGgo=',
        expireTime: 60,
        pollTimeInterval: 3
      }
    });
  }
  if (url.pathname === '/api/auth-token' && req.method === 'POST') {
    const body = await readBody(req);
    const token = String(body.token || '').trim();
    if (!token) return json(res, 400, { success: false, message: 'empty' });
    fs.writeFileSync(authTokenPath, token);
    state.hasToken = true;
    state.validation = 'validating';
    setTimeout(() => { state.validation = 'valid'; persist(); }, 50);
    persist();
    return json(res, 200, { success: true, message: 'saved' });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    state.online = false;
    persist();
    return json(res, 200, { success: true });
  }
  return json(res, 404, { success: false, message: 'not found' });
});

server.listen(webuiPort, '127.0.0.1', () => {
  fs.writeFileSync(path.join(dataDir, 'fake-llbot-ready.json'), JSON.stringify({ webuiPort, pid: process.pid }));
});

const ob11 = config.ob11?.connect?.find((entry) => entry.type === 'ws' && entry.enable);
if (ob11?.port) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: Number(ob11.port) });
  wss.on('connection', (ws, req) => {
    if (ob11.token && String(req.headers.authorization || '') !== `Bearer ${ob11.token}`) {
      ws.close(401, 'bad token');
      return;
    }
    ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
    ws.on('message', (data) => {
      let action = {};
      try { action = JSON.parse(String(data)); } catch { /* ignore */ }
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { echo: action.echo ?? null, message_id: 1 } }));
    });
  });
}

process.on('SIGTERM', () => {
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
});
