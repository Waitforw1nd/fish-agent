import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Client, loginAdmin, request, startManager } from './helpers.mjs';
import { startFakeUpstream, UPSTREAM_KEY } from './fixtures/fake-upstream.mjs';
import { FakeDockerRunner } from './fixtures/fake-docker-runner.mjs';

test('custom upstream works without platform credentials and synchronizes the running agent model', async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const env = await startManager({ relayCustomAllowPrivate: true });
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Custom agent', slug: 'custom-agent', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  const tenant = () => manager.tenants.row(tenantId);
  const base = `/api/tenants/${tenantId}`;
  const diskConfig = () => JSON.parse(fs.readFileSync(manager.agent.configPath(tenant()), 'utf8'));
  const runningModel = async () => {
    const port = manager.agent.port(tenant());
    const response = await request(`http://127.0.0.1:${port}`, {
      path: '/api/config',
      headers: { 'x-console-token': manager.secrets.get(tenantId, 'agent.console_token') }
    });
    assert.equal(response.status, 200);
    return response.json.api.model;
  };

  assert.equal(manager.relay.upstreamPublic().configured, false);
  const saved = await admin.call(base + '/relay/custom', {
    method: 'PUT', body: { baseUrl: upstream.baseUrl, model: 'upstream-only-model', apiKey: UPSTREAM_KEY }
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.restartRequired, false);
  assert.equal(diskConfig().api.model, 'upstream-only-model');
  assert.equal(diskConfig().api.apiKey, manager.relayKeys.plaintext(tenantId));
  assert.equal(diskConfig().api.baseUrl, `http://127.0.0.1:${config.relayPort}/v1`);

  const models = await admin.call(base + '/relay/models');
  assert.equal(models.status, 200, models.text);
  assert.equal(models.json.source, 'custom');
  assert.equal(models.json.upstream.ok, true);
  assert.equal(models.json.upstream.error, null);
  assert.equal(upstream.stats.models, 1);
  assert.deepEqual(models.json.models.map((model) => model.id), ['upstream-only-model']);
  const overview = await admin.call(base + '/relay/overview');
  assert.equal(overview.json.relay.model, 'upstream-only-model');
  assert.equal(overview.json.relay.source, 'custom');
  assert.equal(overview.json.relay.upstream.configured, true);
  assert.equal(overview.json.relay.upstream.ok, true);
  assert.equal(manager.relay.upstreamPublic().configured, false);
  const detail = await admin.getTenant(tenantId);
  assert.equal(detail.json.relay.model, 'upstream-only-model');

  assert.equal((await admin.startTenant(tenantId)).status, 200);
  assert.equal(await runningModel(), 'upstream-only-model');
  const oldPid = manager.supervisor.status(tenantId, 'agent').pid;
  const changed = await admin.call(base + '/relay/custom', { method: 'PUT', body: { model: 'deepseek-reasoner' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.restartRequired, false);
  assert.notEqual(manager.supervisor.status(tenantId, 'agent').pid, oldPid);
  assert.equal(await runningModel(), 'deepseek-reasoner');
  assert.equal(manager.customUpstreams.get(tenantId).apiKey, UPSTREAM_KEY);

  const rotated = await admin.call(base + '/relay/key', { method: 'PUT', body: { key: 'replacement-local-relay-key' } });
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal(rotated.json.model, 'deepseek-reasoner');
  assert.equal(rotated.json.relay.model, 'deepseek-reasoner');
  assert.equal(await runningModel(), 'deepseek-reasoner');
  assert.equal(diskConfig().api.apiKey, 'replacement-local-relay-key');
  const chat = await request(`http://127.0.0.1:${config.relayPort}`, {
    method: 'POST', path: '/v1/chat/completions',
    headers: { authorization: `Bearer ${diskConfig().api.apiKey}` },
    body: { model: diskConfig().api.model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 20 }
  });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(upstream.stats.requests.at(-1).body.model, 'deepseek-reasoner');

  const removed = await admin.call(base + '/relay/custom', { method: 'DELETE' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.restartRequired, false);
  assert.equal(await runningModel(), tenant().default_model);
  assert.equal(manager.secrets.has(tenantId, 'relay.custom.apiKey'), false);
  const restored = await admin.call(base + '/relay/overview');
  assert.equal(restored.json.relay.source, 'platform');
  assert.equal(restored.json.relay.upstream.configured, false);
});

async function switchFixture(t) {
  const env = await startManager({ relayCustomAllowPrivate: true, defaultQqDriver: 'llbot', napcatImage: `fish/napcat@sha256:${'a'.repeat(64)}` });
  t.after(() => env.stop());
  const { manager } = env;
  const runner = new FakeDockerRunner();
  manager.qq.docker.command = runner.command.bind(runner);
  t.after(() => runner.close());
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Relay switch', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.tenant.id;
  const base = `/api/tenants/${id}`;
  assert.equal((await admin.call(base + '/relay/custom', { method: 'PUT', body: { baseUrl: 'http://127.0.0.1:12345', model: 'custom-original', apiKey: 'test-custom-key' } })).status, 200);
  assert.equal((await admin.call(base + '/qq/prepare', { method: 'POST', body: { driver: 'llbot', uin: '12345' } })).status, 200);
  await manager.agent.start(manager.tenants.row(id));
  const switchBody = { driver: 'napcat', expectedRevision: manager.qq.account(id).revision, idempotencyKey: 'relay-switch', uin: '12345' };
  return { ...env, admin, id, base, switchBody };
}

test('active switch rejects custom save/delete and relay model/key changes before any mutation or restart', async (t) => {
  const { manager, admin, id, base, switchBody } = await switchFixture(t);
  const switched = await admin.call(base + '/qq/switch', { method: 'POST', body: switchBody });
  assert.equal(switched.status, 202, switched.text);
  assert.equal(switched.json.operation.phase, 'waiting_qr');
  assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  const snapshot = () => ({
    custom: manager.customUpstreams.get(id),
    customRow: manager.customUpstreams.row(id),
    tenant: manager.tenants.row(id),
    key: manager.relayKeys.active(id),
    keyValue: manager.relayKeys.plaintext(id),
    config: fs.readFileSync(manager.agent.configPath(manager.tenants.row(id)), 'utf8'),
    runs: manager.db.prepare("SELECT * FROM process_runs WHERE tenant_id=? AND kind='agent'").all(id)
  });
  const before = snapshot();
  for (const options of [
    { path: '/relay/custom', method: 'PUT', body: { model: 'changed', apiKey: 'changed-custom-key' } },
    { path: '/relay/custom', method: 'DELETE' },
    { path: '/relay/key', method: 'PUT', body: { key: 'changed-relay-key', model: 'deepseek-reasoner' } },
    { path: '/relay/key', method: 'PUT', body: { model: 'deepseek-reasoner' } }
  ]) {
    const response = await admin.call(base + options.path, options);
    assert.equal(response.status, 409, response.text);
    assert.equal(response.json.code, 'QQ_SWITCH_ACTIVE');
    assert.deepEqual(snapshot(), before);
    assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  }
});

test('relay update holds the QQ serial lock through persistence and agent restart', async (t) => {
  const { manager, admin, id, base, switchBody } = await switchFixture(t);
  const originalUpdate = manager.customUpstreams.update.bind(manager.customUpstreams);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  manager.customUpstreams.update = async (...args) => { entered(); await gate; return originalUpdate(...args); };
  t.after(() => release());
  const update = admin.call(base + '/relay/custom', { method: 'PUT', body: { model: 'custom-updated' } });
  await ready;
  const switchPromise = manager.qq.startSwitch(manager.tenants.row(id), switchBody);
  assert.equal(manager.qq.hasActiveSwitch(id), false);
  release();
  const [updated, switched] = await Promise.all([update, switchPromise]);
  assert.equal(updated.status, 200, updated.text);
  assert.equal(switched.phase, 'waiting_qr');
  assert.equal(manager.customUpstreams.get(id).model, 'custom-updated');
  assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  assert.equal(manager.db.prepare("SELECT COUNT(*) AS n FROM process_runs WHERE tenant_id=? AND kind='agent'").get(id).n, 2);
});

test('expired owner configuration writes never start the agent, including expiry during stop', async (t) => {
  const env = await startManager({ relayCustomAllowPrivate: true, expirySweepMs: 60000 });
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  assert.equal((await admin.call('/api/admin/users', { method: 'POST', body: { username: 'relayowner', password: 'relayowner-password-123' } })).status, 201);
  const owner = new Client(`http://127.0.0.1:${config.panelPort}`);
  assert.equal((await owner.login('relayowner', 'relayowner-password-123')).status, 200);
  const id = (await owner.createTenant({ name: 'Owner relay' })).json.tenant.id;
  const base = `/api/tenants/${id}`;
  await manager.agent.start(manager.tenants.row(id));
  const stop = manager.agent.stop.bind(manager.agent);
  manager.agent.stop = async (...args) => {
    await stop(...args);
    manager.db.prepare("UPDATE tenants SET status='expired', expires_at=? WHERE id=?").run(Date.now() - 1, id);
  };
  const saved = await owner.call(base + '/relay/custom', { method: 'PUT', body: { baseUrl: 'http://127.0.0.1:12345', model: 'expired-custom', apiKey: 'expired-custom-key' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  for (const [suffix, options] of [
    ['/relay/custom', { method: 'PUT', body: { model: 'still-expired' } }],
    ['/relay/key', { method: 'PUT', body: { key: 'expired-relay-key' } }],
    ['/relay/custom', { method: 'DELETE' }]
  ]) {
    const response = await owner.call(base + suffix, options);
    assert.equal(response.status, 200, response.text);
    assert.equal(manager.supervisor.status(id, 'agent').state, 'stopped');
  }
  assert.equal(manager.db.prepare("SELECT COUNT(*) AS n FROM process_runs WHERE tenant_id=? AND kind='agent'").get(id).n, 1);
});
