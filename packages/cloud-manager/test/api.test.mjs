import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Client, loginAdmin, readJsonLines, startManager, tenantHost, waitFor } from './helpers.mjs';

test('auth, RBAC and tenant gateway isolation', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;

  const admin = await loginAdmin(manager);
  const me = await admin.call('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'admin');
  assert.ok(me.json.csrfToken);

  for (const name of ['alice', 'bob']) {
    const created = await admin.call('/api/admin/users', {
      method: 'POST', body: { username: name, password: `${name}-password-123`, role: 'user' }
    });
    assert.equal(created.status, 201, created.text);
  }

  const aliceTenant = await admin.createTenant({
    name: 'Alice Demo', slug: 'alice-demo', planId: 'starter', ownerUsername: 'alice'
  });
  assert.equal(aliceTenant.status, 201, aliceTenant.text);
  const bobTenant = await admin.createTenant({
    name: 'Bob Demo', slug: 'bob-demo', planId: 'starter', ownerUsername: 'bob'
  });
  assert.equal(bobTenant.status, 201, bobTenant.text);
  const aliceId = aliceTenant.json.tenant.id;
  const bobId = bobTenant.json.tenant.id;
  assert.match(aliceTenant.json.tenant.publicUrl, /^http:\/\/alice-demo\.test\.local:\d+$/);

  const alice = new Client(`http://127.0.0.1:${config.panelPort}`);
  assert.equal((await alice.login('alice', 'alice-password-123')).status, 200);
  const bob = new Client(`http://127.0.0.1:${config.panelPort}`);
  assert.equal((await bob.login('bob', 'bob-password-123')).status, 200);

  const aliceList = await alice.call('/api/tenants');
  assert.equal(aliceList.status, 200);
  assert.equal(aliceList.json.tenants.length, 1);
  assert.equal(aliceList.json.tenants[0].role, 'owner');

  const forbidden = await alice.call(`/api/tenants/${bobId}`);
  assert.equal(forbidden.status, 403);
  const forbiddenStart = await alice.call(`/api/tenants/${bobId}/start`, { method: 'POST' });
  assert.equal(forbiddenStart.status, 403);
  const csrfFail = await alice.call('/api/tenants', {
    method: 'POST', body: { name: 'x', slug: 'x-demo' }, csrf: false
  });
  assert.equal(csrfFail.status, 403);
  assert.equal(csrfFail.json.code, 'CSRF_FAILED');

  const started = await alice.startTenant(aliceId);
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.runtime.agent.state, 'running');
  assert.ok(started.json.runtime.agent.port > 0);
  const serviceEnv = manager.supervisor.get(aliceId, 'agent').env;
  assert.equal(serviceEnv.QQ_AGENT_HOST, '127.0.0.1');
  assert.equal(serviceEnv.QQ_AGENT_PORT, String(started.json.runtime.agent.port));
  assert.equal(serviceEnv.QQ_AGENT_ALLOWED_HOSTS, `127.0.0.1:${serviceEnv.QQ_AGENT_PORT}`);
  assert.equal(serviceEnv.QQ_AGENT_TOKEN, manager.agent.consoleHeaders(manager.tenants.row(aliceId))['x-console-token']);
  assert.ok(serviceEnv.QQ_AGENT_TOKEN);

  const detail = await alice.getTenant(aliceId);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.tenant.summary.agent.state, 'running');

  const host = tenantHost(config, 'alice-demo');
  const tenantClient = new Client(`http://127.0.0.1:${config.panelPort}`, {
    host, cookie: alice.cookie, csrf: alice.csrf
  });
  const ui = await tenantClient.call('/');
  assert.equal(ui.status, 200);
  assert.match(ui.text, /fake agent console/);
  const status = await tenantClient.call('/api/status');
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.fake, true);

  const blocked = await tenantClient.call('/api/reset-data', { method: 'POST' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'API_NOT_ALLOWED');

  const guarded = await tenantClient.call('/api/config', {
    method: 'POST',
    body: {
      persona: { botName: '云端小鱼' },
      server: { port: 1, token: 'evil' },
      channels: { qq: { enabled: false } },
      allowAllWhenEmpty: true,
      tools: { crossChatSend: true },
      api: { baseUrl: 'http://169.254.169.254', apiKey: 'x', model: 'deepseek-chat' },
      webSearch: { custom: { baseUrl: 'http://127.0.0.1:1' } }
    }
  });
  assert.equal(guarded.status, 200, guarded.text);
  assert.ok(guarded.headers['x-cloud-guard']);
  const agentData = manager.agent.dataDir(manager.tenants.row(aliceId));
  const writes = readJsonLines(`${agentData}/fake-agent-config-writes.jsonl`);
  const lastWrite = writes.at(-1);
  assert.equal(lastWrite.persona.botName, '云端小鱼');
  assert.equal(lastWrite.allowAllWhenEmpty, false);
  assert.equal(lastWrite.tools.crossChatSend, false);
  assert.equal(lastWrite.server, undefined);
  assert.equal(lastWrite.channels, undefined);
  assert.equal(lastWrite.api.baseUrl, undefined);
  assert.equal(lastWrite.api.apiKey, undefined);
  assert.equal(lastWrite.api.model, 'deepseek-chat');
  assert.equal(lastWrite.webSearch.custom, undefined);

  const logEntries = readJsonLines(`${agentData}/fake-agent-requests.jsonl`);
  const proxied = logEntries.filter((entry) => entry.path === '/api/status').at(-1);
  const agentPort = manager.agent.port(manager.tenants.row(aliceId));
  assert.equal(proxied.host, `127.0.0.1:${agentPort}`);
  assert.equal(proxied.origin, `http://127.0.0.1:${agentPort}`);
  assert.equal(proxied.cookiePresent, false);
  assert.equal(proxied.tokenMatches, true);

  // Bob must not reach Alice's console even with Bob's valid session.
  const crossTenant = new Client(`http://127.0.0.1:${config.panelPort}`, {
    host, cookie: bob.cookie, csrf: bob.csrf
  });
  const cross = await crossTenant.call('/api/status');
  assert.equal(cross.status, 403);

  // Origin validation blocks cross-site writes before they reach the agent.
  const evilOrigin = await requestTenant(config, host, alice.cookie, '/api/config', {
    method: 'POST', origin: 'https://evil.example', body: { persona: { botName: 'evil' } }
  });
  assert.equal(evilOrigin.status, 403);

  // SSE streaming is proxied and closes cleanly.
  const sse = await openSse(config, host, alice.cookie, '/api/events');
  assert.equal(sse.res.statusCode, 200);
  const chunk = await firstChunk(sse.res);
  assert.match(chunk, /event: hello|event: tick/);
  sse.req.destroy();

  const stopped = await alice.call(`/api/tenants/${aliceId}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.runtime.agent.state, 'stopped');

  const bobStart = await bob.startTenant(bobId);
  assert.equal(bobStart.status, 200, bobStart.text);
  const bobHost = tenantHost(config, 'bob-demo');
  const bobConsole = new Client(`http://127.0.0.1:${config.panelPort}`, {
    host: bobHost, cookie: bob.cookie, csrf: bob.csrf
  });
  const bobStatus = await bobConsole.call('/api/status');
  assert.equal(bobStatus.status, 200);
  assert.equal(bobStatus.json.fake, true);
});

function requestTenant(config, host, cookie, pathname, { method = 'GET', body = null, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: config.panelPort,
      path: pathname,
      method,
      headers: {
        host,
        cookie,
        ...(origin ? { origin } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openSse(config, host, cookie, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: config.panelPort,
      path: pathname,
      method: 'GET',
      headers: { host, cookie, accept: 'text/event-stream' }
    }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

function firstChunk(res) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sse timeout')), 4000);
    res.once('data', (chunk) => { clearTimeout(timer); resolve(chunk.toString('utf8')); });
    res.once('error', reject);
  });
}
