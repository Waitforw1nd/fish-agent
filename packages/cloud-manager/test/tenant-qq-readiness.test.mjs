import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, loginAdmin, startManager } from './helpers.mjs';
import { FakeDockerRunner } from './fixtures/fake-docker-runner.mjs';

async function onlineNapcat(t) {
  const env = await startManager({ napcatImage: `fixture/napcat@sha256:${'a'.repeat(64)}` });
  const docker = new FakeDockerRunner();
  docker.online = true;
  env.manager.qq.docker.command = docker.command.bind(docker);
  t.after(async () => { await env.stop(); await docker.close(); });
  const admin = await loginAdmin(env.manager);
  const created = await admin.createTenant({ name: 'QQ readiness', slug: 'qq-readiness', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  const base = `/api/tenants/${tenantId}`;
  const prepared = await admin.call(`${base}/qq/prepare`, { method: 'POST', body: { driver: 'napcat', uin: '12345' } });
  assert.equal(prepared.status, 200, prepared.text);
  const started = await admin.call(`${base}/qq/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  assert.equal(env.manager.supervisor.status(tenantId, 'qq').state, 'stopped');
  return { ...env, docker, admin, tenantId, base };
}

function assertOnline(view) {
  assert.equal(view.readiness.qqOnline, true);
  assert.equal(view.qq.running, true);
  assert.equal(view.qq.loggedIn, true);
  assert.equal(view.qq.uin, '12345');
  assert.equal(view.qq.expectedUin, '12345');
}

test('tenant detail, lists and auth use the verified Docker QQ status and keep OneBot separate', async (t) => {
  const { manager, config, docker, admin, tenantId, base } = await onlineNapcat(t);
  const list = await admin.call('/api/tenants');
  assert.equal(list.status, 200, list.text);
  assertOnline(list.json.tenants.find(row => row.id === tenantId));
  assert.equal(list.json.tenants[0].qq.onebotConnected, false);
  assert.equal(list.json.tenants[0].qq.canChat, false);

  const inspections = () => docker.calls.filter(call => call[0] === 'inspect').length;
  const beforeLists = inspections();
  const me = await admin.call('/api/me');
  const secondList = await admin.call('/api/tenants');
  const owned = await admin.call(`/api/admin/users/${admin.user.id}/tenants`);
  assertOnline(me.json.tenants.find(row => row.id === tenantId));
  assertOnline(secondList.json.tenants.find(row => row.id === tenantId));
  assertOnline(owned.json.tenants.find(row => row.id === tenantId));
  assert.equal(inspections(), beforeLists, 'repeated list views reuse the verified status');

  const beforeDetail = inspections();
  const detail = await admin.call(base);
  assert.equal(detail.status, 200, detail.text);
  assertOnline(detail.json.tenant);
  assert.equal(detail.json.qq.loggedIn, detail.json.runtime.qq.loggedIn);
  assert.equal(detail.json.qq.onebotConnected, detail.json.runtime.qq.onebotConnected);
  assert.equal(inspections() - beforeDetail, 1, 'detail reuses its existing runtime status');

  const client = new Client(`http://127.0.0.1:${config.panelPort}`);
  const login = await client.login('admin', 'admin-password-123');
  assert.equal(login.status, 200, login.text);
  assertOnline(login.json.tenants.find(row => row.id === tenantId));
  const overview = await admin.call('/api/admin/overview');
  assert.equal(overview.status, 200, overview.text);
  assert.equal(typeof overview.json.overview.tenants.ready, 'number');
  assert.equal(manager.qq.account(tenantId).runtime_generation, 0, 'legacy accounts use the Docker generation');
});

test('summary rejects changed Docker identity, an active switch and a stopped container', async (t) => {
  const { manager, docker, admin, tenantId, base } = await onlineNapcat(t);
  const listView = async () => {
    const response = await admin.call('/api/tenants');
    assert.equal(response.status, 200, response.text);
    return response.json.tenants.find(row => row.id === tenantId);
  };
  assertOnline(await listView());
  const runtime = manager.qq.docker.row(tenantId);
  manager.db.prepare('UPDATE qq_accounts SET runtime_generation = ?, effective_runtime_id = ? WHERE tenant_id = ?')
    .run(runtime.generation + 1, 'another-runtime', tenantId);
  const unconfirmed = await listView();
  assert.equal(unconfirmed.readiness.qqOnline, false);
  assert.equal(unconfirmed.qq.running, false);
  assert.equal(unconfirmed.qq.phase, 'error');
  assert.equal(unconfirmed.qq.onebotConnected, false);

  manager.db.prepare('UPDATE qq_accounts SET runtime_generation = 0, effective_runtime_id = NULL WHERE tenant_id = ?').run(tenantId);
  assertOnline((await admin.call(base)).json.tenant);
  manager.db.prepare(`INSERT INTO qq_operations
    (id, tenant_id, idempotency_key, request_hash, status, phase, source_driver, target_driver, expected_uin,
     expected_revision, target_json, runtime_generation, created_at, updated_at)
    VALUES ('summary-switch', ?, 'summary-switch', 'test', 'running', 'waiting_qr', 'napcat', 'llbot', '12345', 0, ?, ?, ?, ?)`)
    .run(tenantId, JSON.stringify({ account: { driver: 'llbot', expected_uin: '12345' } }), runtime.generation + 1, Date.now(), Date.now());
  const switching = await listView();
  assert.equal(switching.qq.state, 'switching');
  assert.equal(switching.qq.activeOperationId, 'summary-switch');
  assert.equal(switching.readiness.qqOnline, false);
  assert.equal(switching.qq.onebotConnected, false);
  manager.db.prepare("DELETE FROM qq_operations WHERE id = 'summary-switch'").run();
  assertOnline((await admin.call(base)).json.tenant);

  const container = docker.containers.get(runtime.container_id);
  await Promise.all(container.servers.map(server => new Promise(resolve => server.close(resolve))));
  container.servers = [];
  container.State.Running = false;
  container.State.Status = 'exited';
  Object.values(container.NetworkSettings.Networks)[0].NetworkID = '';
  const cached = manager.qq.summaryStatusCache.get(tenantId);
  assert.ok(cached);
  cached.at -= 3001;
  const stopped = await listView();
  assert.equal(stopped.qq.running, false);
  assert.equal(stopped.readiness.qqOnline, false);
  const detail = await admin.call(base);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.runtime.qq.running, false);
  assert.equal(detail.json.tenant.readiness.qqOnline, false);
  assert.equal((await listView()).readiness.qqOnline, false);
});

test('OneBot connectivity in summaries requires the verified generation and account', async (t) => {
  const { manager, admin, tenantId, base } = await onlineNapcat(t);
  const tenant = manager.tenants.row(tenantId);
  await manager.agent.start(tenant);
  const generation = manager.qq.docker.row(tenantId).generation;
  let channel = { connected: true, generation, selfId: '12345' };
  manager.agent.health = async () => ({ ok: true, channels: { qq: channel } });
  const connected = await admin.call(base);
  assertOnline(connected.json.tenant);
  assert.equal(connected.json.qq.onebotConnected, true);
  assert.equal(connected.json.qq.canChat, true);
  const list = await admin.call('/api/tenants');
  assert.equal(list.json.tenants.find(row => row.id === tenantId).qq.onebotConnected, true);

  channel = { connected: true, generation: generation + 1, selfId: '12345' };
  const wrongGeneration = await admin.call(base);
  assertOnline(wrongGeneration.json.tenant);
  assert.equal(wrongGeneration.json.qq.onebotConnected, false);
  assert.equal(wrongGeneration.json.qq.canChat, false);
  channel = { connected: true, generation, selfId: '99999' };
  const wrongAccount = await admin.call(base);
  assertOnline(wrongAccount.json.tenant);
  assert.equal(wrongAccount.json.qq.onebotConnected, false);
  assert.equal(wrongAccount.json.qq.canChat, false);
});

test('a mismatched QQ login is never presented as ready', async (t) => {
  const { manager, docker, admin, tenantId, base } = await onlineNapcat(t);
  docker.uin = '99999';
  const detail = await admin.call(base);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.runtime.qq.state, 'uin_mismatch');
  assert.equal(detail.json.tenant.qq.phase, 'error');
  assert.equal(detail.json.tenant.readiness.qqOnline, false);
  assert.equal(manager.qq.account(tenantId).state, 'uin_mismatch');
  assert.equal(manager.qq.docker.row(tenantId).desired_state, 'stopped');
  const list = await admin.call('/api/tenants');
  assert.equal(list.json.tenants.find(row => row.id === tenantId).readiness.qqOnline, false);
});

test('an individual status failure leaves lists and login available without reporting QQ ready', async (t) => {
  const { manager, config, admin, tenantId } = await onlineNapcat(t);
  const first = await admin.call('/api/tenants');
  assertOnline(first.json.tenants.find(row => row.id === tenantId));
  manager.qq.summaryStatusCache.get(tenantId).at -= 3001;
  manager.agent.health = async () => { throw new Error('internal-secret'); };
  const list = await admin.call('/api/tenants');
  assert.equal(list.status, 200, list.text);
  const view = list.json.tenants.find(row => row.id === tenantId);
  assert.equal(view.qq.phase, 'error');
  assert.equal(view.qq.running, false);
  assert.equal(view.qq.loggedIn, false);
  assert.equal(view.qq.onebotConnected, false);
  assert.equal(view.qq.canChat, false);
  assert.equal(view.readiness.qqOnline, false);
  assert.doesNotMatch(list.text, /internal-secret/);
  const client = new Client(`http://127.0.0.1:${config.panelPort}`);
  const login = await client.login('admin', 'admin-password-123');
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.tenants.find(row => row.id === tenantId).readiness.qqOnline, false);
  assert.doesNotMatch(login.text, /internal-secret/);
});

test('an in-flight login probe cannot certify a changed Docker generation', async (t) => {
  const { manager, admin, tenantId } = await onlineNapcat(t);
  const tenant = manager.tenants.row(tenantId);
  const originalDriver = manager.qq.driver.bind(manager.qq);
  let entered;
  const probing = new Promise(resolve => { entered = resolve; });
  let release;
  const proceed = new Promise(resolve => { release = resolve; });
  manager.qq.driver = id => {
    const driver = originalDriver(id);
    if (id !== 'napcat') return driver;
    return { ...driver, async status(ctx) { entered(); await proceed; return driver.status(ctx); } };
  };
  const request = manager.qq.status(tenant);
  await probing;
  const runtime = manager.qq.docker.row(tenantId);
  manager.qq.docker.save({ ...runtime, generation: runtime.generation + 1 });
  release();
  const status = await request;
  assert.equal(status.loggedIn, false);
  manager.qq.docker.save(runtime);
  manager.qq.driver = originalDriver;
  const detail = await admin.call(`/api/tenants/${tenantId}`);
  assertOnline(detail.json.tenant);
});
