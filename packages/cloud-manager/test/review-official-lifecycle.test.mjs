import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startManager, loginAdmin, waitFor, fixture } from './helpers.mjs';
const { WebSocketServer } = createRequire(import.meta.url)('ws');

test('official lifecycle uses production links, isolated loopback gateway and tenant metering', { timeout: 90000 }, async () => {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof a === 'object' && a !== null ? a : { port: a, host: args[1] };
    if (options.path || !['127.0.0.1', '::1'].includes(options.host || options.hostname)) throw new Error('non-loopback TCP blocked');
    return originalConnect.apply(this, args);
  };
  const secret = 'review-secret-fixture-123', token = 'review-token-fixture', upstreamKey = 'review-upstream-fixture';
  const calls = [], sends = [], sockets = new Set(); let gateway;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}; calls.push({ url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (['/token','/app/getAppAccessToken'].includes(req.url)) return res.end(JSON.stringify({ access_token: token, expires_in: 3600 }));
    if (req.url === '/gateway/bot') return res.end(JSON.stringify({ url: `ws://127.0.0.1:${server.address().port}/official` }));
    if (req.url.startsWith('/v2/users/')) { sends.push({ url: req.url, body }); return res.end(JSON.stringify({ id: 'local-reply' })); }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
    if (req.url === '/v1/chat/completions') {
      const done = body.messages.some(m => m.role === 'tool' && m.name === 'send_message');
      return res.end(JSON.stringify({ id: 'local', model: 'deepseek-chat', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls.length}`, type: 'function', function: { name: done ? 'finish' : 'send_message', arguments: JSON.stringify(done ? { reason: 'done' } : { messages: ['local review reply'] }) } }] } }] }));
    }
    res.writeHead(404).end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (req.url !== '/official') { ws.terminate(); return; }
    gateway = ws; sockets.add(ws); ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'local-session', user: { id: 'bot', username: 'Fish' } } })); else if (m.op === 1) ws.send(JSON.stringify({ op: 11, d: null })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-review-official-'));
  const entry = path.join(temp, 'agent.mjs');
  // Block all non-loopback TCP connections in the real child, before loading the
  // existing fixture which rewrites only QQ's production fetch URLs to loopback.
  fs.writeFileSync(entry, `import net from 'node:net';\nconst original=net.Socket.prototype.connect;\nnet.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0][0]:args[0];const o=typeof a==='object'&&a!==null?a:{port:a,host:args[1]};if(o.path||!['127.0.0.1','::1'].includes(o.host || o.hostname))throw new Error('non-loopback TCP blocked');return original.apply(this,args);};\nawait import(${JSON.stringify(pathToFileURL(fixture('v1-qq-agent.mjs')).href)});\n`);
  let env, pid; const responses = [];
  try {
    env = await startManager({ agentEntry: entry, qqbotTokenUrl: `${base}/token` });
    const { manager } = env, admin = await loginAdmin(manager);
    const call = async (url, options) => { const r = await admin.call(url, options); responses.push(r.text); return r; };
    let r = await call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: base, apiKey: upstreamKey } }); assert.equal(r.status, 200, r.text);
    const a = await admin.createTenant({ name: 'review-a', slug: 'review-a', planId: 'starter' }); const b = await admin.createTenant({ name: 'review-b', slug: 'review-b', planId: 'starter' });
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text);
    const id = a.json.tenant.id, other = b.json.tenant.id, tenant = manager.tenants.row(id);
    r = await call(`/api/tenants/${id}/qq/prepare`, { method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: secret, intents: 1 << 25 } }); assert.equal(r.status, 200, r.text);
    r = await call(`/api/tenants/${other}/qq/prepare`, { method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: secret } }); assert.equal(r.status, 409, r.text);
    r = await call(`/api/tenants/${id}/qq/start`, { method: 'POST', body: {} }); assert.equal(r.status, 200, r.text);
    await manager.agent.ensure(tenant); const configPath = manager.agent.configPath(tenant); const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    Object.assign(config, { allow: { groups: [], private: ['qqbot_user_OpenID_Aa'] }, v1FixtureBase: base, wakeDelayMs: 10, extensions: { hotReload: false }, proactive: { enabled: false } }); fs.writeFileSync(configPath, JSON.stringify(config));
    r = await admin.startTenant(id); responses.push(r.text); assert.equal(r.status, 200, r.text);
    pid = manager.supervisor.status(id, 'agent').pid; assert.ok(pid);
    const ws = await waitFor(() => gateway, { timeoutMs: 10000, label: 'official connection' });
    await waitFor(() => calls.some(x => x.url === '/gateway/bot'), { label: 'gateway discovery' });
    await new Promise(resolve => setTimeout(resolve, 200));
    const event = { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'review-message', timestamp: new Date().toISOString(), author: { user_openid: 'OpenID_Aa' }, content: 'hello local fish' } };
    ws.send(JSON.stringify(event));
    const sent = await waitFor(() => sends.find(x => x.url.includes('/v2/users/OpenID_Aa')), { timeoutMs: 25000, label: 'official reply' });
    assert.equal(sent.body.msg_id, 'review-message'); assert.match(sent.body.content, /local review reply/);
    await waitFor(() => manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=? AND entry=?').get(id, 'qq_official').n, { timeoutMs: 10000, label: 'ledger' });
    const ledger = manager.db.prepare('SELECT tenant_id,platform,chat_key,prompt_tokens,completion_tokens FROM ledger WHERE entry=?').all('qq_official');
    assert.ok(ledger.length); assert.ok(ledger.every(x => x.tenant_id === id && x.platform === 'qqbot' && x.chat_key === 'private:qqbot_user_OpenID_Aa' && x.prompt_tokens + x.completion_tokens > 0));
    await waitFor(() => { const meters = manager.billingProvider.usage({ tenantId: id }).map(x => x.meter); return ['qq_official.message.in','qq_official.message.out','qq_official.llm.tokens','qq_official.api.call'].every(x => meters.includes(x)); }, { timeoutMs: 15000, label: 'meters' });
    assert.equal(manager.billingProvider.usage({ tenantId: other, meter: 'qq_official.message.in' }).length, 0);
    const models = calls.filter(x => x.url === '/v1/chat/completions').length, output = sends.length;
    ws.send(JSON.stringify(event)); await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(calls.filter(x => x.url === '/v1/chat/completions').length, models); assert.equal(sends.length, output);
    assert.equal(manager.billingProvider.usage({ tenantId: id, meter: 'qq_official.message.in' })[0].quantity, 1);
    for (const url of [`/api/tenants/${id}/qq/status`, `/api/tenants/${id}/entries`, `/api/tenants/${id}/billing/entries/qq_official/usage`]) { r = await call(url); assert.equal(r.status, 200, r.text); }
    r = await call(`/api/tenants/${id}/stop`, { method: 'POST' }); assert.equal(r.status, 200, r.text);
    assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped'); assert.throws(() => process.kill(pid, 0));
    const logs = [JSON.stringify(manager.supervisor.logs(id, 'agent', 1000))];
    const logFile = path.join(env.config.logDir, 'tenants', `${id}.agent.log`);
    if (fs.existsSync(logFile)) logs.push(fs.readFileSync(logFile, 'utf8'));
    for (const sensitive of [secret, token, upstreamKey]) { assert.equal(responses.join('\n').includes(sensitive), false, 'API response leaked fixture secret'); assert.equal(logs.join('\n').includes(sensitive), false, 'log leaked fixture secret'); }
  } finally {
    try {
      await env?.stop();
      for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
      if (pid) assert.throws(() => process.kill(pid, 0), 'child must exit');
    } finally { net.Socket.prototype.connect = originalConnect; }
  }
});

