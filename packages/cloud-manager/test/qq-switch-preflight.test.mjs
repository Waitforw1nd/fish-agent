import assert from 'node:assert/strict';
import test from 'node:test';
import { loginAdmin, startManager } from './helpers.mjs';

test('switch preflight failure preserves effective account and is idempotent', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Switch', slug: 'switch-preflight', planId: 'starter' })).json.tenant.id;
  await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { driver: 'napcat', uin: '12345' } });
  const tenant = env.manager.tenants.row(tenantId);
  const before = env.manager.qq.account(tenantId);
  const request = { driver: 'llbot', expectedRevision: before.revision, idempotencyKey: 'test-key' };
  const op = await env.manager.qq.startSwitch(tenant, request);
  assert.equal(op.status, 'failed');
  assert.ok(['LLBOT_NOT_BUILT', 'AUTH_TOKEN_REQUIRED'].includes(op.error.code));
  assert.deepEqual(env.manager.qq.account(tenantId), before);
  assert.equal((await env.manager.qq.startSwitch(tenant, request)).operationId, op.operationId);
  await assert.rejects(env.manager.qq.startSwitch(tenant, { ...request, uin: '54321' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
