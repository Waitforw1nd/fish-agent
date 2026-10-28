import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const driver = process.env.CLOUD_QQ_DRIVER || 'napcat';
const uin = process.env.CLOUD_QQ_UIN || '10001';
const webuiPort = Number(process.env.CLOUD_QQ_WEBUI_PORT || 0);
const httpPort = Number(process.env.CLOUD_QQ_HTTP_PORT || 0);
const cwd = process.cwd();

function readOnebotToken() {
  const candidates = driver === 'napcat'
    ? [path.join(cwd, 'config', `onebot11_${uin}.json`)]
    : [path.join(cwd, 'config', `onebot_${uin}.json`)];
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      return String(config.network?.httpServers?.[0]?.token || config.network?.websocketServers?.[0]?.token || '');
    } catch { /* ignore */ }
  }
  return '';
}

const token = readOnebotToken();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const httpServer = httpPort ? http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { status: 'failed', retcode: 401, wording: 'unauthorized' });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/get_login_info') {
    json(res, 200, { status: 'ok', retcode: 0, data: { user_id: Number(uin), nickname: `Fake ${driver}` } });
    return;
  }
  if (url.pathname === '/get_status') {
    json(res, 200, { status: 'ok', retcode: 0, data: { online: true, good: true } });
    return;
  }
  json(res, 200, { status: 'ok', retcode: 0, data: { echo: null } });
}) : null;

const webui = webuiPort ? http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><body>fake ${driver} webui</body></html>`);
}) : null;

let listening = 0;
const done = () => {
  listening += 1;
  if (listening === (httpServer ? 1 : 0) + (webui ? 1 : 0)) {
    fs.writeFileSync(path.join(cwd, 'fake-qqproto-ready.json'), JSON.stringify({ driver, httpPort, webuiPort, pid: process.pid }));
  }
};
if (httpServer) httpServer.listen(httpPort, '127.0.0.1', done);
if (webui) webui.listen(webuiPort, '127.0.0.1', done);

process.on('SIGTERM', () => {
  try { httpServer?.close(); } catch { /* ignore */ }
  try { webui?.close(); } catch { /* ignore */ }
  process.exit(0);
});
