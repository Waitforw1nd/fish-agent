import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase } from '../src/db.js';
import { BillingService } from '../src/billing.js';
import { AuthService } from '../src/auth.js';
import { UsersService } from '../src/users.js';
import { CustomUpstreamService } from '../src/relay/custom-upstreams.js';
import { guardApiBody, guardConfigPatch } from '../src/config-guard.js';
import { BackupService } from '../src/backup.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-stage2-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}

function authFixture(db) {
  return new AuthService({ db, config: { sessionTtlMs: 86400000, sessionTouchMs: 1000,
    loginWindowMs: 60000, loginMaxFailures: 50, cookieName: 'fish', publicScheme: 'http', cookieSecure: false,
    baseDomain: 'localhost' } });
}
function requestFor(session) { return { headers: { cookie: `fish=${session.token}` } }; }

test('v9 migration preserves historical rows and converts review metadata', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE tenants (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner'), ('admin'); INSERT INTO tenants VALUES ('tenant');
      CREATE TABLE recharges (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_micros INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','confirmed')), created_by_user_id TEXT NOT NULL,
        confirmed_by_user_id TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER);
      INSERT INTO recharges VALUES ('old','tenant',123,'confirmed','owner','admin',11,12),
        ('pending','tenant',456,'pending','owner',NULL,13,NULL);
      PRAGMA user_version = 8; PRAGMA foreign_keys = ON;`);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    const old = db.prepare("SELECT * FROM recharges WHERE id='old'").get();
    assert.equal(old.amount_micros, 123); assert.equal(old.created_at, 11);
    assert.equal(old.reviewed_by_user_id, 'admin'); assert.equal(old.reviewed_at, 12);
    assert.equal(db.prepare("SELECT status FROM recharges WHERE id='pending'").get().status, 'pending');
    db.prepare("UPDATE recharges SET status='rejected', review_note='declined' WHERE id='pending'").run();
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('recharge review is atomic and returns visible notes and wallet transactions', (t) => {
  const { db, dir } = fixture(t); const auth = authFixture(db); const billing = new BillingService({ db });
  const admin = auth.createUser({ username: 'admin', password: 'admin-password', role: 'admin' });
  const owner = auth.createUser({ username: 'owner', password: 'owner-password' });
  const ts = Date.now();
  db.prepare(`INSERT INTO tenants (id,slug,name,plan_id,owner_user_id,status,created_at,expires_at,updated_at,data_dir)
    VALUES ('tenant','tenant','Tenant','trial',?,'active',?,?,?,?)`).run(owner.id, ts, ts + 86400000, ts, dir);
  billing.ensureWallet('tenant', 100);
  const first = billing.createRecharge('tenant', 50, owner.id);
  const second = billing.createRecharge('tenant', 75, owner.id);
  assert.equal(billing.listRecharges({ status: 'pending' }).length, 2);
  const rejected = billing.rejectRecharge(first.id, admin.id, 'missing proof');
  assert.equal(rejected.reviewNote, 'missing proof'); assert.equal(rejected.reviewedByUserId, admin.id);
  assert.equal(billing.wallet('tenant').balanceMicros, 100);
  assert.throws(() => billing.confirmRecharge(first.id, admin.id), (e) => e.status === 409);
  assert.throws(() => billing.rejectRecharge(second.id, admin.id, ''), (e) => e.status === 400);
  const result = billing.confirmRecharge(second.id, admin.id, 'matched');
  assert.equal(result.wallet.balanceMicros, 175); assert.equal(result.recharge.reviewNote, 'matched');
  assert.throws(() => billing.confirmRecharge(second.id, admin.id), (e) => e.status === 409);
  assert.equal(billing.transactions('tenant').filter((entry) => entry.kind === 'recharge').length, 1);
  assert.equal(billing.listRecharges({ status: 'rejected' })[0].createdByUsername, 'owner');
  assert.equal(billing.platformStats().pendingRecharges.count, 0);
});

test('user changes protect last active admin and revoke the correct sessions', (t) => {
  const { db } = fixture(t); const auth = authFixture(db); const users = new UsersService(db);
  const admin = auth.createUser({ username: 'admin', password: 'admin-password', role: 'admin' });
  const user = auth.createUser({ username: 'alice', password: 'alice-password' });
  assert.throws(() => users.update(admin.id, { disabled: true }), (e) => e.code === 'LAST_ACTIVE_ADMIN');
  assert.throws(() => users.update(admin.id, { role: 'user' }), (e) => e.code === 'LAST_ACTIVE_ADMIN');
  const first = auth.login({ username: 'alice', password: 'alice-password' });
  const second = auth.login({ username: 'alice', password: 'alice-password' });
  assert.throws(() => auth.changePassword(user.id, first.sessionId, 'wrong', 'new-password'), (e) => e.status === 403);
  auth.changePassword(user.id, first.sessionId, 'alice-password', 'new-password');
  assert.ok(auth.resolve(requestFor(first))); assert.equal(auth.resolve(requestFor(second)), null);
  const third = auth.login({ username: 'alice', password: 'new-password' });
  users.update(user.id, { disabled: true });
  assert.equal(auth.resolve(requestFor(first)), null); assert.equal(auth.resolve(requestFor(third)), null);
  users.update(user.id, { disabled: false, password: 'reset-password' });
  assert.equal(auth.login({ username: 'alice', password: 'reset-password' }).user.id, user.id);
});

test('custom model probe pins DNS, refuses redirects and never returns credentials', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    assert.equal(req.headers.authorization, 'Bearer secret-test-key');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const service = new CustomUpstreamService({ db: {}, secrets: {}, config: { relayCustomAllowPrivate: true } });
  service.get = () => ({ configured: false });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await service.probe({ id: 'tenant' }, { baseUrl, apiKey: 'secret-test-key' });
  assert.equal(result.connected, true); assert.deepEqual(result.models, ['model-a', 'model-b']);
  assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
  const redirect = await service.probe({ id: 'tenant' }, { baseUrl: baseUrl + '/redirect', apiKey: 'secret-test-key' });
  assert.equal(redirect.connected, false); assert.match(redirect.error, /302/);
  const restricted = new CustomUpstreamService({ db: {}, secrets: {}, config: {} });
  restricted.get = () => ({ configured: false });
  await assert.rejects(restricted.probe({ id: 'tenant' }, { baseUrl, apiKey: 'secret-test-key' }), (e) => e.status === 400);
});

test('cloud config guard prevents replacement and prototype bypasses of protected fields', () => {
  const attack = JSON.parse(`{
    "api":{"__replace__":{"baseUrl":"http://127.0.0.1","apiKey":"evil"},"model":"safe"},
    "tools":{"__replace__":{"crossChatSend":true},"categories":{"constructor":{"prototype":{"x":1}}}},
    "security":null,
    "webSearch":{"custom":{"__replace__":{"baseUrl":"http://127.0.0.1"}}},
    "skills":{"plugin":{"enabled":true}},
    "__proto__":{"polluted":true}
  }`);
  const result = guardConfigPatch(attack);
  assert.equal(result.patch.api.model, 'safe');
  assert.equal(result.patch.api.__replace__, undefined);
  assert.equal(result.patch.tools.__replace__, undefined);
  assert.equal(result.patch.tools.categories.constructor, Object.prototype.constructor);
  assert.equal(result.patch.security, undefined);
  assert.equal(result.patch.webSearch.custom, undefined);
  assert.equal(Object.hasOwn(result.patch, '__proto__'), false);
  const gateway = guardApiBody({ method: 'POST', pathname: '/api/config', body: attack });
  assert.equal(gateway.body.patch.skills, undefined);
});

test('owner snapshot restore preserves current administrator extensions and absent state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tenant = { id: 'tenant', data_dir: path.join(dir, 'tenant') };
  const extRoot = path.join(tenant.data_dir, 'admin-extensions');
  const blocked = path.join(tenant.data_dir, 'data', 'blocked-extensions.json');
  fs.mkdirSync(path.join(extRoot, 'plugins', 'current'), { recursive: true });
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(path.join(extRoot, 'plugins', 'current', 'index.js'), 'current');
  fs.writeFileSync(blocked, '["blocked-now"]');
  const lockOrder = [];
  const service = new BackupService({
    tenants: { row: () => tenant }, hosting: { stop: async () => {} },
    db: { prepare: () => ({ run() {} }) }, vault: { drop() {} },
    agent: { supervisor: { status: () => ({ state: 'stopped' }) } }
  });
  service.extensionService = {
    withLock: async (_key, fn) => { lockOrder.push('extension'); return fn(); },
    agentSettings: { locked: async (_tenant, fn) => { lockOrder.push('settings'); return fn(); } }
  };
  service.snapshotRuntime = () => ({});
  service.importState = () => {};
  service.reallocatePortsAndRewrite = async () => {};
  let files = [
    { path: 'data/config.json', data: Buffer.from('{}'), mode: 0o600 },
    { path: 'data/blocked-extensions.json', data: Buffer.from('[]'), mode: 0o600 },
    { path: 'admin-extensions/plugins/deleted/index.js', data: Buffer.from('old'), mode: 0o600 }
  ];
  service.readArchive = () => ({ header: { state: {} }, files });
  await service.restore(tenant.id, 'old', { actor: { role: 'user' }, restart: false });
  assert.equal(fs.readFileSync(blocked, 'utf8'), '["blocked-now"]');
  assert.equal(fs.readFileSync(path.join(extRoot, 'plugins', 'current', 'index.js'), 'utf8'), 'current');
  assert.equal(fs.existsSync(path.join(extRoot, 'plugins', 'deleted')), false);
  fs.rmSync(extRoot, { recursive: true });
  fs.rmSync(blocked);
  await service.restore(tenant.id, 'old', { actor: { role: 'user' }, restart: false });
  assert.equal(fs.existsSync(extRoot), false);
  assert.equal(fs.existsSync(blocked), false);
  await service.restore(tenant.id, 'old', { actor: { role: 'admin' }, restart: false });
  assert.equal(fs.readFileSync(path.join(extRoot, 'plugins', 'deleted', 'index.js'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(blocked, 'utf8'), '[]');
  files = [{ path: 'data/config.json', data: Buffer.from('{}'), mode: 0o600 }];
  await service.restore(tenant.id, 'legacy', { actor: { role: 'user' }, restart: false });
  assert.equal(fs.readFileSync(path.join(extRoot, 'plugins', 'deleted', 'index.js'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(blocked, 'utf8'), '[]');
  assert.deepEqual(lockOrder, ['extension', 'settings', 'extension', 'settings', 'extension', 'settings', 'extension', 'settings']);
});
