import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, loginAdmin, startManager, waitFor } from './helpers.mjs';

test('owned instances, roles and QQ operations remain isolated over HTTP', async (t) => {
  const env = await startManager({ defaultQqDriver: 'llbot' });
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const users = {};
  for (const name of ['alice', 'bob', 'viewer', 'operator', 'empty']) {
    const response = await admin.call('/api/admin/users', { method: 'POST', body: { username: name, password: `${name}-password-123` } });
    assert.equal(response.status, 201, response.text);
    users[name] = response.json.user;
  }
  const client = async (name) => {
    const result = new Client(`http://127.0.0.1:${config.panelPort}`);
    assert.equal((await result.login(name, `${name}-password-123`)).status, 200);
    return result;
  };
  const alice = await client('alice');
  const bob = await client('bob');
  const viewer = await client('viewer');
  const operator = await client('operator');
  const first = await alice.createTenant({ name: 'Alice 1' });
  assert.equal(first.status, 201, first.text);
  assert.equal((await alice.createTenant({ name: 'Trial limit' })).json.code, 'TENANT_LIMIT');
  const second = await alice.createTenant({ name: 'Alice 2', planId: 'starter' });
  assert.equal(second.status, 201, second.text);
  const other = await admin.createTenant({ name: 'Bob 1', ownerUserId: users.bob.id });
  assert.equal(other.status, 201, other.text);
  assert.equal((await alice.createTenant({ name: 'Forbidden', ownerUserId: users.bob.id })).status, 403);
  const [a, a2, b] = [first, second, other].map((response) => response.json.tenant.id);
  manager.tenants.addMember(a, users.viewer, 'viewer');
  manager.tenants.addMember(a, users.operator, 'operator');
  manager.tenants.addMember(b, users.alice, 'viewer');

  const ids = (response) => response.json.tenants.map((item) => item.id).sort();
  assert.deepEqual(ids(await alice.call('/api/tenants')), [a, a2, b].sort());
  assert.deepEqual(ids(await bob.call('/api/tenants')), [b]);
  assert.deepEqual(ids(await admin.call('/api/tenants')), [a, a2, b].sort());
  const owned = await admin.call(`/api/admin/users/${users.alice.id}/tenants`);
  assert.equal(owned.status, 200, owned.text);
  assert.equal(owned.json.user.username, 'alice');
  assert.equal(Object.hasOwn(owned.json.user, 'password_hash'), false);
  assert.deepEqual(ids(owned), [a, a2].sort());
  assert.deepEqual(ids(await admin.call(`/api/admin/users/${users.bob.id}/tenants`)), [b]);
  assert.deepEqual(ids(await admin.call(`/api/admin/users/${users.empty.id}/tenants`)), []);
  assert.equal((await admin.call('/api/admin/users/missing/tenants')).status, 404);
  assert.equal((await alice.call(`/api/admin/users/${users.alice.id}/tenants`)).status, 403);

  const calls = { prepare: 0, start: 0, qrcode: 0 };
  for (const method of Object.keys(calls)) {
    const original = manager.qq[method].bind(manager.qq);
    manager.qq[method] = async (...args) => { calls[method]++; return original(...args); };
  }
  const paths = [
    ['prepare', 'POST', { uin: '12345' }], ['start', 'POST', { uin: '12345' }], ['qrcode', 'GET', null]
  ];
  const denied = async (who, id, expected) => {
    const before = { ...calls };
    for (const [action, method, body] of paths) {
      const response = await who.call(`/api/tenants/${id}/qq/${action}`, { method, body });
      assert.equal(response.status, expected, response.text);
    }
    assert.deepEqual(calls, before);
  };
  await denied(bob, a, 403);
  await denied(viewer, a, 403);
  const anonymous = new Client(`http://127.0.0.1:${config.panelPort}`);
  await denied(anonymous, a, 401);
  assert.equal((await anonymous.call(`/api/admin/users/${users.alice.id}/tenants`)).status, 401);
  assert.equal((await bob.call(`/api/tenants/${a}`)).status, 403);
  assert.equal((await viewer.call(`/api/tenants/${a}/qq/status`)).status, 200);

  const missing = await alice.call(`/api/tenants/${a}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  assert.equal(missing.status, 200, missing.text);
  assert.equal(missing.json.qq.driver, 'llbot');
  const started = await alice.call(`/api/tenants/${a}/qq/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const unavailable = await alice.call(`/api/tenants/${a}/qq/qrcode`);
  assert.equal(unavailable.status, 409, unavailable.text);
  assert.equal(unavailable.json.code, 'AUTH_TOKEN_REQUIRED');
  assert.match(unavailable.json.message || unavailable.json.error, /平台管理员/);

  const platformToken = 'test-platform-token-unique-987654321';
  manager.settings.set('platform.llbotAuthToken', platformToken);
  const prepared = await operator.call(`/api/tenants/${a2}/qq/prepare`, { method: 'POST', body: { uin: '12346' } });
  assert.equal(prepared.status, 403);
  const ownerPrepared = await alice.call(`/api/tenants/${a2}/qq/prepare`, { method: 'POST', body: { uin: '12346' } });
  assert.equal(ownerPrepared.status, 200, ownerPrepared.text);
  assert.equal(ownerPrepared.json.qq.driver, 'llbot');
  const ownerStarted = await alice.call(`/api/tenants/${a2}/qq/start`, { method: 'POST', body: { uin: '12346' } });
  assert.equal(ownerStarted.status, 200, ownerStarted.text);
  const qr = await waitFor(async () => {
    const response = await alice.call(`/api/tenants/${a2}/qq/qrcode`);
    return response.status === 200 ? response : null;
  }, { label: 'owner QR code' });
  assert.equal(qr.json.qrcode.state, 'ready');
  manager.tenants.addMember(a2, users.operator, 'operator');
  assert.equal((await operator.call(`/api/tenants/${a2}/qq/start`, { method: 'POST' })).status, 200);
  assert.equal((await operator.call(`/api/tenants/${a2}/qq/qrcode`)).status, 200);
  for (const response of [ownerPrepared, ownerStarted, qr, await operator.call(`/api/tenants/${a2}/qq/status`)]) {
    assert.equal(response.text.includes(platformToken), false);
    assert.equal(response.text.includes(manager.secrets.get(a2, 'qq.webui_password')), false);
    assert.equal(response.text.includes(manager.secrets.get(a2, 'qq.onebot_token')), false);
  }
  manager.tenants.setStatus(a2, 'suspended');
  await denied(operator, a2, 403);
  manager.tenants.setStatus(a2, 'expired');
  await denied(operator, a2, 402);
});
