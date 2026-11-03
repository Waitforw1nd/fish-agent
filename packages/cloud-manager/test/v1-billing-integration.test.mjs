import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startManager, loginAdmin, request, Client } from './helpers.mjs';

test('billing API requires the tenant session and strict CSRF for entitlement changes', async t => {
  const env = await startManager();
  t.after(async () => { await env.stop(); assert.equal(env.manager.stopped, true); assert.equal(fs.existsSync(env.dataDir), false); });
  const { manager } = env, admin = await loginAdmin(manager);
  const user = manager.auth.createUser({ username: 'billing-user', password: 'password-123' });
  const a = (await admin.createTenant({ name: 'Owned', slug: 'billing-owned', planId: 'starter', ownerUserId: user.id })).json.tenant.id;
  const b = (await admin.createTenant({ name: 'Other', slug: 'billing-other', planId: 'starter' })).json.tenant.id;
  const userClient = new Client(`http://127.0.0.1:${manager.config.panelPort}`);
  assert.equal((await userClient.login('billing-user', 'password-123')).status, 200);
  assert.equal((await userClient.call(`/api/tenants/${a}/billing/usage`)).status, 200);
  assert.equal((await userClient.call(`/api/tenants/${b}/billing/usage`)).status, 403);
  const relayKey = manager.relayKeys.plaintext(a);
  assert.equal((await request(userClient.baseUrl, { path: `/api/tenants/${a}/billing/usage`, headers: { authorization: `Bearer ${relayKey}` } })).status, 401);
  const entitlements = { entitlements: [{ meter: 'qq_protocol.message.in', window: 'day', limit: 1, mode: 'hard' }] };
  assert.equal((await userClient.call(`/api/admin/tenants/${a}/entitlements`, { method: 'PUT', body: entitlements })).status, 403);
  const noCsrf = await admin.call(`/api/admin//tenants/${a}/entitlements`, { method: 'PUT', body: entitlements, csrf: false,
    headers: { origin: userClient.baseUrl } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_FAILED');
  assert.equal((await admin.call(`/api/admin/tenants/${a}/entitlements`, { method: 'PUT', body: entitlements })).status, 200);
});

test('four entry usage APIs reflect idempotent authenticated batches and isolate tenants', async t => {
  const env = await startManager();
  t.after(async () => { await env.stop(); assert.equal(env.manager.stopped, true); assert.equal(fs.existsSync(env.dataDir), false); });
  const { manager } = env, admin = await loginAdmin(manager);
  const create = async slug => { const r = await admin.createTenant({ name: slug, slug, planId: 'starter' }); assert.equal(r.status, 201, r.text); return r.json.tenant.id; };
  const a = await create('meter-four-a'), b = await create('meter-four-b');
  const entries = ['qq_protocol', 'qq_official', 'desktop', 'bili'];
  const events = entries.map((entry, i) => ({ idempotencyKey: 'four:' + i, entry, meter: entry + '.message.in', quantity: i + 1, unit: 'count', source: 'agent', occurredAt: Date.now() }));
  const base = `http://127.0.0.1:${manager.config.relayPort}`;
  const send = (tenant, batch) => request(base, { method: 'POST', path: '/v1/fish/meter-events', headers: { authorization: `Bearer ${manager.relayKeys.plaintext(tenant)}` }, body: { events: batch } });
  let result = await send(a, events); assert.equal(result.status, 200, result.text); assert.equal(result.json.accepted, 4); assert.equal(result.json.duplicates, 0);
  result = await send(a, events); assert.equal(result.json.accepted, 0); assert.equal(result.json.duplicates, 4);
  result = await send(b, events); assert.equal(result.json.accepted, 4);
  const bad = { ...events[0], idempotencyKey: 'bad', meter: 'qq_protocol.llm.tokens', unit: 'tokens' };
  result = await send(a, [{ ...events[0], idempotencyKey: 'rollback' }, bad]); assert.equal(result.status, 400);
  result = await send(a, [{ ...events[2], idempotencyKey: 'wrong-chat', attrs: { chatKey: 'group:123' } }]); assert.equal(result.status, 400);
  result = await send(a, [{ ...events[2], idempotencyKey: 'wrong-platform', attrs: { platform: 'bili' } }]); assert.equal(result.status, 400);
  result = await send(a, [{ ...events[2], idempotencyKey: 'wrong-tenant', tenantId: b }]); assert.equal(result.status, 400);
  for (const [i, entry] of entries.entries()) {
    const direct = manager.billingProvider.usage({ tenantId: a, entry });
    assert.equal(direct.length, 1); assert.equal(direct[0].quantity, i + 1);
    const api = await admin.call(`/api/tenants/${a}/billing/entries/${entry}/usage`);
    assert.equal(api.status, 200, api.text); assert.equal(api.json.usage.length, 1); assert.equal(api.json.usage[0].quantity, i + 1);
  }
  const all = await admin.call(`/api/tenants/${a}/billing/usage`); assert.equal(all.status, 200); assert.equal(all.json.usage.length, 4);
  const listing = await admin.call(`/api/tenants/${a}/billing/entries`); assert.equal(listing.status, 200); assert.deepEqual(new Set(listing.json.entries.map(x => x.entry)), new Set(entries));
  const other = await admin.call(`/api/tenants/${b}/billing/usage`); assert.equal(other.status, 200); assert.equal(other.json.usage.length, 4);
});
