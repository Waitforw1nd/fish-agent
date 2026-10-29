import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiRouter } from '../src/api.js';
import { Client, loginAdmin, startManager } from './helpers.mjs';
import { FakeDockerRunner } from './fixtures/fake-docker-runner.mjs';

test('switch routes enforce roles and active tenant, and pass through operation contract', async () => {
  const calls = [];
  const tenant = { id: 't', status: 'active' };
  let role = 'operator', active = true;
  const operation = { operationId: 'op', status: 'running', phase: 'preflight' };
  const router = createApiRouter({ config: { apiMaxBodyBytes: 10000 }, auth: {}, tenants: {
    require(id, user, minRole) { calls.push(['require', id, minRole]); if (role === 'viewer' && minRole !== 'viewer') throw Object.assign(new Error('forbidden'), { status: 403 }); return { tenant, role }; },
    assertActive() { if (!active) throw Object.assign(new Error('inactive'), { status: 403 }); }
  }, db: { prepare() { return { get(tenantId, operationId) { calls.push(['read', tenantId, operationId]); return operation; } }; } }, qq: {
    publicOperation(row) { return row; },
    async startSwitch(t, body) { calls.push(['start', t, body]); return operation; },
    async getOperation(t, id) { calls.push(['get', t, id]); return operation; },
    async cancelSwitch(t, id) { calls.push(['cancel', t, id]); return operation; }
  } });
  async function request(method, path, body) {
    const match = router.match(method, path);
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.headers = {};
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await match.route.handler({ req, res, params: match.params, auth: { user: { id: 'u' } } });
    return res;
  }
  const body = { driver: 'napcat', expectedRevision: 2, idempotencyKey: 'key', uin: '12345' };
  const result = await request('POST', '/api/tenants/t/qq/switch', body);
  assert.equal(result.status, 202); assert.deepEqual(result.body.operation, operation); assert.deepEqual(calls[1][2], body);
  role = 'viewer'; await assert.rejects(request('POST', '/api/tenants/t/qq/switch', body), { status: 403 });
  assert.equal((await request('GET', '/api/tenants/t/qq/operations/op')).body.operation.operationId, 'op');
  assert.equal(calls.some(call => call[0] === 'get'), false);
  await assert.rejects(request('POST', '/api/tenants/t/qq/operations/op/advance'), { status: 403 });
  await assert.rejects(request('POST', '/api/tenants/t/qq/operations/op/cancel'), { status: 403 });
  role = 'operator';
  assert.equal((await request('POST', '/api/tenants/t/qq/operations/op/advance')).status, 200);
  active = false;
  await assert.rejects(request('POST', '/api/tenants/t/qq/operations/op/advance'), { status: 403 });
  await assert.rejects(request('POST', '/api/tenants/t/qq/switch', body), { status: 403 });
  assert.equal((await request('POST', '/api/tenants/t/qq/operations/op/cancel')).status, 200);
  role = 'viewer';
  await assert.rejects(request('GET', '/api/tenants/t/qq/qrcode'), { status: 403 });
  operation.error = { code: 'UPSTREAM_FAILED', message: 'token=secret-token-123 Credential=internal-credential-123' };
  operation.rollback = { status: 'failed', message: 'Bearer rollback-token-123 password=secret-password-123' };
  const safe = await request('GET', '/api/tenants/t/qq/operations/op');
  assert.doesNotMatch(JSON.stringify(safe.body), /secret-token-123|internal-credential-123|rollback-token-123|secret-password-123/);
  assert.equal(safe.body.operation.error.code, 'UPSTREAM_FAILED');
  assert.match(operation.error.message, /secret-token-123/, 'serialization must not mutate stored error');
});


test('real HTTP, SQLite, session and CSRF enforce switch isolation and idempotency', async (t) => {
  const env = await startManager({ defaultQqDriver: 'llbot', napcatImage: `fish/napcat@sha256:${'a'.repeat(64)}` });
  t.after(() => env.stop());
  const { manager, config } = env;
  const fake = new FakeDockerRunner();
  manager.qq.docker.command = fake.command.bind(fake);
  t.after(() => fake.close());
  const admin = await loginAdmin(manager);
  const users = {};
  for (const name of ['switchowner', 'switchviewer', 'switchother', 'switchoperator']) {
    const result = await admin.call('/api/admin/users', { method: 'POST', body: { username: name, password: `${name}-password-123` } });
    assert.equal(result.status, 201, result.text); users[name] = result.json.user;
  }
  const login = async name => {
    const client = new Client(`http://127.0.0.1:${config.panelPort}`);
    assert.equal((await client.login(name, `${name}-password-123`)).status, 200); return client;
  };
  const owner = await login('switchowner'), viewer = await login('switchviewer'), other = await login('switchother'), operator = await login('switchoperator');
  const created = await owner.createTenant({ name: '切换测试' }); assert.equal(created.status, 201, created.text);
  const id = created.json.tenant.id;
  manager.tenants.addMember(id, users.switchviewer, 'viewer');
  manager.tenants.addMember(id, users.switchoperator, 'operator');
  const base = `/api/tenants/${id}/qq`;
  const body = { driver: 'napcat', expectedRevision: 0, idempotencyKey: 'http-test-key', uin: '12345' };
  for (const client of [viewer, other]) assert.equal((await client.call(`${base}/switch`, { method: 'POST', body })).status, 403);
  const csrf = await owner.call(`${base}/switch`, { method: 'POST', body, csrf: false });
  assert.equal(csrf.status, 403); assert.equal(csrf.json.code, 'CSRF_FAILED');
  manager.tenants.setStatus(id, 'suspended');
  assert.equal((await owner.call(`${base}/switch`, { method: 'POST', body })).status, 403);
  manager.tenants.setStatus(id, 'active');
  const prepared = await owner.call(`${base}/prepare`, { method: 'POST', body: { driver: 'llbot', uin: '12345' } });
  assert.equal(prepared.status, 200, prepared.text);
  const status = await owner.call(`${base}/status`); assert.equal(status.status, 200, status.text);
  body.expectedRevision = status.json.qq.revision;
  const started = await owner.call(`${base}/switch`, { method: 'POST', body });
  assert.equal(started.status, 202, started.text);
  const op = started.json.operation;
  assert.ok(op.operationId);
  assert.equal(op.status, 'running', started.text);
  assert.equal(op.phase, 'waiting_qr', started.text);
  assert.ok([...fake.containers.values()].some(container => container.State.Running), 'switch must start the target runtime');
  const repeated = await operator.call(`${base}/switch`, { method: 'POST', body });
  assert.equal(repeated.status, 202, repeated.text); assert.equal(repeated.json.operation.operationId, op.operationId);
  const conflict = await owner.call(`${base}/switch`, { method: 'POST', body: { ...body, uin: '54321' } });
  assert.equal(conflict.status, 409, conflict.text);
  const operationPath = `${base}/operations/${op.operationId}`;
  const beforeRead = manager.db.prepare('SELECT * FROM qq_operations WHERE id = ?').get(op.operationId);
  const beforeCommands = fake.calls.length;
  fake.online = true;
  assert.equal((await viewer.call(operationPath, { csrf: false })).status, 200);
  assert.deepEqual(manager.db.prepare('SELECT * FROM qq_operations WHERE id = ?').get(op.operationId), beforeRead, 'viewer GET must not advance or commit a switch');
  assert.equal(fake.calls.length, beforeCommands, 'GET operation must not control runtime resources');
  assert.equal((await viewer.call(`${operationPath}/advance`, { method: 'POST' })).status, 403);
  assert.equal((await other.call(`${operationPath}/advance`, { method: 'POST' })).status, 403);
  assert.equal((await owner.call(`${operationPath}/advance`, { method: 'POST', csrf: false })).json.code, 'CSRF_FAILED');
  fake.online = false;
  assert.equal((await operator.call(`${operationPath}/advance`, { method: 'POST' })).json.operation.phase, 'waiting_qr');
  assert.equal((await viewer.call(operationPath, { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await other.call(operationPath)).status, 403);
  assert.equal((await other.call(`${operationPath}/cancel`, { method: 'POST' })).status, 403);
  assert.equal((await viewer.call(`${operationPath}/cancel`, { method: 'POST' })).status, 403);
  assert.equal((await owner.call(`${operationPath}/cancel`, { method: 'POST', csrf: false })).json.code, 'CSRF_FAILED');
  manager.tenants.setStatus(id, 'suspended');
  assert.equal((await operator.call(`${operationPath}/advance`, { method: 'POST' })).status, 403);
  const cancel = await operator.call(`${operationPath}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(cancel.json.operation.operationId, op.operationId);
  assert.equal(cancel.json.operation.status, 'cancelled', cancel.text);
  assert.equal(cancel.json.operation.rollback.restore, false);
  assert.equal([...fake.containers.values()].some(container => container.State.Running), false);
  assert.notEqual(op.error?.code, 'QQ_SWITCH_NOT_IMPLEMENTED', '后端切换执行器尚未实现');
  manager.tenants.setStatus(id, 'active');
  const current = await owner.call(`${base}/status`);
  const second = await owner.call(`${base}/switch`, { method: 'POST', body: { ...body, expectedRevision: current.json.qq.revision, idempotencyKey: 'http-success-key' } });
  assert.equal(second.status, 202, second.text);
  assert.equal(second.json.operation.phase, 'waiting_qr', second.text);
  fake.online = true;
  const advanced = await operator.call(`${base}/operations/${second.json.operation.operationId}/advance`, { method: 'POST' });
  assert.equal(advanced.status, 200, advanced.text);
  assert.equal(advanced.json.operation.status, 'succeeded', advanced.text);
  assert.equal(manager.qq.account(id).driver, 'napcat');
  assert.equal(manager.qq.account(id).uin, '12345');
});
