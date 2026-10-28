import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase, migrate } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { KeyVault, TenantSecrets, hashPassword, verifyPassword, encrypt, decrypt } from '../src/crypto.js';
import { BillingService } from '../src/billing.js';
import { classifyHost, rewriteLocation } from '../src/gateway.js';
import { guardApiBody, guardConfigPatch, isApiAllowed } from '../src/config-guard.js';
import { isValidSlug, id } from '../src/util.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cloud-unit-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  return { dir, db, close() { try { db.close(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

function seedTenant(db, dir, slug = 'unit') {
  const userId = id('usr');
  const tenantId = id('tnt');
  const ts = Date.now();
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(userId, `user_${slug}`, hashPassword('password-123'), 'user', ts);
  db.prepare(`INSERT INTO tenants (id, slug, name, plan_id, owner_user_id, status, created_at, expires_at, updated_at, data_dir, agent_port)
    VALUES (?, ?, ?, 'starter', ?, 'active', ?, ?, ?, ?, NULL)`)
    .run(tenantId, `${slug}-${dir.slice(-5)}`, 'Unit', userId, ts, ts + 86400000, ts, path.join(dir, 'tenant'));
  return { userId, tenantId };
}

test('v3 ledger migration retains historical unassigned entries', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE ledger (id TEXT PRIMARY KEY, tenant_id TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, cost_micros INTEGER, created_at INTEGER);
      INSERT INTO ledger VALUES ('old', 'tenant', 'deepseek-chat', 10, 2, 1, 3, ${Date.now()}); PRAGMA user_version = 3;`);
    migrate(db);
    const summary = new BillingService({ db }).usageSummary('tenant');
    assert.equal(summary.byChat[0].chatKey, null);
    assert.equal(summary.usageSources.unknown, 1);
    assert.equal(summary.totals.costMicros, 3);
  } finally { db.close(); }
});

test('password hashing and envelope encryption', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.ok(verifyPassword('correct horse battery staple', hash));
  assert.equal(verifyPassword('wrong', hash), false);
  const key = Buffer.alloc(32, 7);
  const sealed = encrypt(key, 'secret-value', 'aad-1');
  assert.equal(decrypt(key, sealed, 'aad-1').toString('utf8'), 'secret-value');
  assert.throws(() => decrypt(key, sealed, 'aad-2'));
  const tampered = { ...sealed, ct: Buffer.from('x').toString('base64') };
  assert.throws(() => decrypt(key, tampered, 'aad-1'));
});

test('tenant secrets are isolated by tenant and AAD', () => {
  const { dir, db, close } = tempDb();
  try {
    const vault = new KeyVault(db, Buffer.alloc(32, 3));
    const secrets = new TenantSecrets(db, vault);
    const a = seedTenant(db, dir, 'a');
    const b = seedTenant(db, dir, 'b');
    secrets.set(a.tenantId, 'relay.key', 'key-a');
    secrets.set(b.tenantId, 'relay.key', 'key-b');
    assert.equal(secrets.get(a.tenantId, 'relay.key'), 'key-a');
    assert.equal(secrets.get(b.tenantId, 'relay.key'), 'key-b');
    assert.equal(secrets.get(a.tenantId, 'missing', 'fallback'), 'fallback');
    assert.equal(secrets.has(a.tenantId, 'relay.key'), true);
    secrets.delete(a.tenantId, 'relay.key');
    assert.equal(secrets.get(a.tenantId, 'relay.key'), null);
  } finally {
    close();
  }
});

test('billing holds, settlement, release and expiry', () => {
  const { dir, db, close } = tempDb();
  try {
    const billing = new BillingService({ db });
    const { tenantId } = seedTenant(db, dir, 'bill');
    db.prepare("INSERT INTO relay_keys (id, tenant_id, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)")
      .run('rk1', tenantId, 'hash', 'sk-fish', Date.now());
    billing.ensureWallet(tenantId, 1000);
    assert.equal(billing.wallet(tenantId).balanceMicros, 1000);
    const first = billing.reserve({ tenantId, keyId: 'rk1', model: 'deepseek-chat', estimatedMicros: 700, maxTokens: 100 });
    assert.equal(billing.wallet(tenantId).availableMicros, 300);
    assert.throws(
      () => billing.reserve({ tenantId, keyId: 'rk1', model: 'deepseek-chat', estimatedMicros: 400, maxTokens: 100 }),
      (error) => error.status === 402 && error.code === 'INSUFFICIENT_BALANCE'
    );
    const settled = billing.settle({
      reservation: first,
      usage: { prompt_tokens: 10, completion_tokens: 10, cached_tokens: 0 },
      upstreamStatus: 200,
      requestId: 'req-1'
    });
    assert.equal(settled.settled, true);
    assert.ok(settled.costMicros > 0);
    assert.equal(billing.wallet(tenantId).balanceMicros, 1000 - settled.costMicros);
    assert.equal(billing.wallet(tenantId).heldMicros, 0);
    const second = billing.reserve({ tenantId, keyId: 'rk1', model: 'deepseek-chat', estimatedMicros: 10, maxTokens: 10 });
    assert.equal(billing.release(second.id), true);
    assert.equal(billing.wallet(tenantId).availableMicros, 1000 - settled.costMicros);
    const third = billing.reserve({ tenantId, keyId: 'rk1', model: 'deepseek-chat', estimatedMicros: 10, maxTokens: 10, ttlMs: 1 });
    const until = Date.now() + 20;
    while (Date.now() < until) { /* spin briefly */ }
    billing.expireHolds(tenantId);
    const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(third.id);
    assert.equal(row.status, 'expired');
    assert.equal(billing.wallet(tenantId).heldMicros, 0);
    assert.equal(billing.credit(tenantId, 500, 'unit').balanceMicros, 1000 - settled.costMicros + 500);
  } finally {
    close();
  }
});

test('config guard locks cloud-owned fields and API allowlist blocks management routes', () => {
  const { patch, warnings } = guardConfigPatch({
    server: { token: 'evil' },
    channels: { qq: { enabled: false } },
    extensions: { dirs: ['/tmp'] },
    allowAllWhenEmpty: true,
    tools: { crossChatSend: true },
    api: { baseUrl: 'http://169.254.169.254', apiKey: 'x', provider: 'evil', model: 'deepseek-chat' },
    webSearch: { searchUrl: 'http://127.0.0.1', custom: { baseUrl: 'http://127.0.0.1' } },
    security: { allowPrivateImageHosts: true },
    persona: { botName: 'ok' }
  });
  assert.equal(patch.server, undefined);
  assert.equal(patch.channels, undefined);
  assert.equal(patch.extensions, undefined);
  assert.equal(patch.allowAllWhenEmpty, false);
  assert.equal(patch.tools.crossChatSend, false);
  assert.equal(patch.api.baseUrl, undefined);
  assert.equal(patch.api.apiKey, undefined);
  assert.equal(patch.api.provider, undefined);
  assert.equal(patch.api.model, 'deepseek-chat');
  assert.equal(patch.webSearch.searchUrl, undefined);
  assert.equal(patch.webSearch.custom, undefined);
  assert.equal(patch.security.allowPrivateImageHosts, false);
  assert.equal(patch.persona.botName, 'ok');
  assert.ok(warnings.length > 0);

  assert.equal(isApiAllowed('GET', '/api/status'), true);
  assert.equal(isApiAllowed('GET', '/api/sessions'), true);
  assert.equal(isApiAllowed('POST', '/api/config'), true);
  assert.equal(isApiAllowed('POST', '/api/config'), true);
  assert.equal(isApiAllowed('POST', '/api/reset-data'), false);
  assert.equal(isApiAllowed('POST', '/api/open-data-dir'), false);
  assert.equal(isApiAllowed('POST', '/api/providers/set-key'), false);
  assert.equal(isApiAllowed('GET', '/api/api-key'), false);
  assert.equal(isApiAllowed('POST', '/api/market/install'), false);
  assert.equal(isApiAllowed('POST', '/api/snowluma/launch'), false);
  assert.equal(isApiAllowed('POST', '/api/media-data'), true);
  assert.equal(isApiAllowed('POST', '/api/chats/group_123/test-send'), true);

  const media = guardApiBody({
    method: 'POST', pathname: '/api/media-data',
    body: { items: [{ path: 'C:/secret.txt' }, { url: 'https://example.com/a.png' }] }
  });
  assert.equal(media.body.items[0].path, undefined);
  assert.equal(media.body.items[1].url, 'https://example.com/a.png');
});

test('host classification, slug validation and redirect rewriting', () => {
  assert.equal(classifyHost('test.local:8080', 'test.local').type, 'base');
  assert.equal(classifyHost('panel.test.local', 'test.local').type, 'base');
  assert.equal(classifyHost('alice.test.local:8080', 'test.local').slug, 'alice');
  assert.equal(classifyHost('a.b.test.local', 'test.local').type, 'invalid');
  assert.equal(classifyHost('evil.example.com', 'test.local').type, 'base');
  assert.equal(classifyHost('localhost:8080', 'localhost').type, 'base');
  assert.equal(classifyHost('alice.localhost:8080', 'localhost').slug, 'alice');
  assert.equal(isValidSlug('alice-demo'), true);
  assert.equal(isValidSlug('-bad'), false);
  assert.equal(isValidSlug('a--b'), false);
  assert.equal(isValidSlug('a_b'), false);
  assert.equal(rewriteLocation('http://127.0.0.1:3210/api/x', 3210, 'http://alice.test.local'), 'http://alice.test.local/api/x');
  assert.equal(rewriteLocation('/relative', 3210, 'http://alice.test.local'), 'http://alice.test.local/relative');
});
