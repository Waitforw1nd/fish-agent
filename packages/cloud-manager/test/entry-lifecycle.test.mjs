import test from 'node:test';
import assert from 'node:assert/strict';
import { startManager, loginAdmin } from './helpers.mjs';

test('strict CSRF applies to canonical and repeated-slash entry routes', async t => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const created = await admin.createTenant({ name: 'CSRF routes', slug: 'csrf-routes', planId: 'starter' });
  const id = created.json.tenant.id;
  const headers = { origin: admin.baseUrl };
  const routes = [
    [`/api/tenants/${id}/entries/desktop`, 'PUT', { enabled: true }],
    [`/api/tenants/${id}/desktop/pairing-codes`, 'POST', {}],
    [`/api/tenants/${id}/bili/explore`, 'PUT', { enabled: false }]
  ];
  for (const [path, method, body] of routes) {
    for (const target of [path, path.replace('/api/tenants/', '/api//tenants/')]) {
      const response = await admin.call(target, { method, body, headers, csrf: false });
      assert.equal(response.status, 403, `${target}: ${response.text}`);
      assert.equal(response.json.code, 'CSRF_FAILED');
    }
  }
  assert.equal(env.manager.entries.enabled(id, 'desktop'), false);
  env.manager.bili.control = async () => ({ config: {} });
  for (const [path, method, body] of routes) {
    const response = await admin.call(path.replace('/api/tenants/', '/api//tenants/'), { method, body, headers });
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.text}`);
  }
});

test('malformed multi-entry control bodies are rejected before state or process changes', async t => {
  const env = await startManager(); t.after(() => env.stop()); const { manager } = env;
  const admin = await loginAdmin(manager), created = await admin.createTenant({ name: 'Body validation', slug: 'body-validation', planId: 'starter' });
  const id = created.json.tenant.id, base = `/api/tenants/${id}`;
  const routes = [
    ['PUT', `${base}/entries/desktop`], ['PUT', `${base}/bili/explore`], ['PUT', `${base}/bili/config`],
    ['POST', `${base}/bili/explore/drafts/12345678-1234-1234-1234-123456789012/edit`],
    ['PUT', `/api/admin/tenants/${id}/entitlements`], ['POST', `${base}/qq/prepare`], ['POST', `${base}/qq/start`]
  ];
  const initial = manager.entries.list(id);
  for (const [method, route] of routes) for (const body of ['null', '[]', '1', '"PRIVATE_FIXTURE"', '{invalid']) {
    const response = await admin.call(route, { method, body });
    assert.equal(response.status, 400, `${method} ${route} ${body}: ${response.text}`);
    assert.doesNotMatch(response.text, /PRIVATE_FIXTURE|TypeError/);
  }
  for (const entitlements of [[null], [{ meter: 123 }]]) {
    const response = await admin.call(`/api/admin/tenants/${id}/entitlements`, { method: 'PUT', body: { entitlements } });
    assert.equal(response.status, 400, response.text);
  }
  for (const config of [null, []]) assert.equal((await admin.call(`${base}/bili/config`, { method: 'PUT', body: { config } })).status, 400);
  assert.deepEqual(manager.entries.list(id), initial);
  assert.notEqual(manager.supervisor.status(id, 'qq').state, 'running');
  assert.notEqual(manager.supervisor.status(id, 'bili').state, 'running');
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM tenant_entitlements WHERE tenant_id=?').get(id).n, 0);
});

test('Bili entry controls start, login and tenant restart', async t => {
  const env = await startManager(); t.after(() => env.stop()); const { manager } = env;
  const admin = await loginAdmin(manager), created = await admin.createTenant({ name: 'Entry lifecycle', slug: 'entry-lifecycle', planId: 'starter' });
  const id = created.json.tenant.id, base = `/api/tenants/${id}`;
  const put = (entry, enabled) => admin.call(`${base}/entries/${entry}`, { method: 'PUT', body: { enabled } });
  assert.equal((await admin.call(`${base}/start`, { method: 'POST' })).status, 200);
  assert.equal((await put('bili', true)).status, 200);
  assert.equal(manager.supervisor.status(id, 'bili').state, 'running');
  assert.equal((await put('bili', false)).status, 200);
  assert.equal(manager.supervisor.status(id, 'bili').state, 'stopped');
  const start = await admin.call(`${base}/bili/start`, { method: 'POST' }); assert.equal(start.status, 409); assert.equal(start.json.code, 'BILI_ENTRY_DISABLED');
  const login = await admin.call(`${base}/bili/login/qr`, { method: 'POST' }); assert.equal(login.status, 409); assert.equal(manager.supervisor.status(id, 'bili').state, 'stopped');
  assert.equal((await admin.call(`${base}/restart`, { method: 'POST' })).status, 200);
  assert.equal(manager.supervisor.status(id, 'bili').state, 'stopped');
  await manager.bili.updateConfig(manager.tenants.row(id), { enabled: false });
  const enabled = await put('bili', true); assert.equal(enabled.status, 200, enabled.text);
  assert.equal(manager.bili.getConfig(manager.tenants.row(id)).enabled, true);
  assert.equal(manager.supervisor.status(id, 'bili').state, 'running');
  assert.equal((await admin.call(`${base}/restart`, { method: 'POST' })).status, 200);
  assert.equal(manager.supervisor.status(id, 'bili').state, 'running');
  assert.equal(manager.entries.enabled(id, 'bili'), true);
});

test('concurrent entry changes finish in request order', { timeout: 20000 }, async t => {
  const env = await startManager(); t.after(() => env.stop()); const { manager } = env;
  const admin = await loginAdmin(manager), created = await admin.createTenant({ name: 'Concurrent entry', slug: 'concurrent-entry', planId: 'starter' });
  const id = created.json.tenant.id, base = `/api/tenants/${id}`;
  const put = enabled => admin.call(`${base}/entries/bili`, { method: 'PUT', body: { enabled } });
  assert.equal((await admin.call(`${base}/start`, { method: 'POST' })).status, 200);
  assert.equal((await put(true)).status, 200);
  const originalStop = manager.bili.stop.bind(manager.bili);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const stopping = new Promise(resolve => { entered = resolve; });
  manager.bili.stop = async (...args) => { entered(); await gate; return originalStop(...args); };
  let timer;
  try {
    const disable = put(false);
    await Promise.race([stopping, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stop gate timed out')), 5000); })]);
    clearTimeout(timer);
    const enable = put(true);
    const deadline = Date.now() + 5000;
    while (manager.lifecycleLock.queues.get(id)?.count !== 2) {
      if (Date.now() > deadline) throw new Error('Entry request did not queue');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    release();
    assert.equal((await disable).status, 200);
    assert.equal((await enable).status, 200);
    assert.equal(manager.entries.enabled(id, 'bili'), true);
    assert.equal(manager.supervisor.status(id, 'bili').state, 'running');
  } finally { clearTimeout(timer); release(); }
});

test('entry enable starts selected prepared QQ; explicit QQ start re-enables after disable', async t => {
  const env = await startManager(); t.after(() => env.stop()); const { manager } = env;
  const admin = await loginAdmin(manager), created = await admin.createTenant({ name: 'QQ entry lifecycle', slug: 'qq-entry-lifecycle', planId: 'starter' });
  const id = created.json.tenant.id, base = `/api/tenants/${id}`;
  const put = (entry, enabled) => admin.call(`${base}/entries/${entry}`, { method: 'PUT', body: { enabled } });
  let result = await admin.call(`${base}/qq/prepare`, { method: 'POST', body: { driver: 'llbot', uin: '12345' } }); assert.equal(result.status, 200, result.text);
  assert.equal((await put('qq_official', true)).status, 409);
  assert.equal((await put('qq_protocol', false)).status, 200);
  assert.equal((await admin.call(`${base}/start`, { method: 'POST' })).status, 200);
  assert.equal(manager.supervisor.status(id, 'qq').state, 'stopped');
  result = await put('qq_protocol', true); assert.equal(result.status, 200, result.text);
  assert.equal(manager.supervisor.status(id, 'qq').state, 'running');
  assert.equal((await put('qq_protocol', false)).status, 200);
  assert.equal(manager.supervisor.status(id, 'qq').state, 'stopped');
  result = await admin.call(`${base}/qq/start`, { method: 'POST', body: {} }); assert.equal(result.status, 200, result.text);
  assert.equal(manager.entries.enabled(id, 'qq_protocol'), true);
  assert.equal(manager.entries.enabled(id, 'qq_official'), false);
  assert.equal((await admin.call(`${base}/restart`, { method: 'POST' })).status, 200);
  assert.equal(manager.supervisor.status(id, 'qq').state, 'running');
});
import http from 'node:http';

test('QQ driver preparation reports only selected driver despite stale entries', async t => {
  const tokenServer = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'fixture', expires_in: '120' })); }); });
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve)); t.after(() => { tokenServer.closeAllConnections(); tokenServer.close(); });
  const env = await startManager({ qqbotTokenUrl: `http://127.0.0.1:${tokenServer.address().port}/token` }); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager), created = await admin.createTenant({ name: 'Driver switch', slug: 'driver-switch', planId: 'starter' });
  const id = created.json.tenant.id, base = `/api/tenants/${id}`;
  let result = await admin.call(`${base}/qq/prepare`, { method: 'POST', body: { driver: 'llbot', uin: '11111' } }); assert.equal(result.status, 200, result.text);
  result = await admin.call(`${base}/entries/qq_protocol`, { method: 'PUT', body: { enabled: true } }); assert.equal(result.status, 200, result.text);
  result = await admin.call(`${base}/qq/prepare`, { method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: 'secret-fixture-1' } }); assert.equal(result.status, 200, result.text);
  let entries = (await admin.call(`${base}/entries`)).json.entries; assert.equal(entries.qq_protocol.enabled, false); assert.equal(entries.qq_official.enabled, false);
  result = await admin.call(`${base}/qq/start`, { method: 'POST', body: {} }); assert.equal(result.status, 200, result.text);
  entries = (await admin.call(`${base}/entries`)).json.entries; assert.equal(entries.qq_protocol.enabled, false); assert.equal(entries.qq_official.enabled, true);
});
