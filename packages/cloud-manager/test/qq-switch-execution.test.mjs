import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { openDatabase } from '../src/db.js';
import { QQService } from '../src/qq-service.js';
import { PortAllocator } from '../src/ports.js';

function setup(t, sourceDriver = 'llbot') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-switch-'));
  const db = openDatabase(path.join(dir, 'state.sqlite'));
  db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES ('owner','owner','unused',0)").run();
  db.prepare("INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,status,created_at,expires_at,updated_at,data_dir) VALUES ('tenant','tenant','tenant','starter','owner','active',0,?,0,?)").run(Date.now() + 3600000, dir);
  const tenant = db.prepare("SELECT * FROM tenants WHERE id='tenant'").get();
  const events = [];
  const controls = { online: false, wrong: false, onebotWrong: false, failStart: false, failStop: false, failRestore: false, agent: true, health: true };
  let running = sourceDriver;
  const secrets = new Map();
  const config = { qqDrivers: ['llbot', 'napcat'], platformAuthToken: 'test-auth-token', llbotEntry: import.meta.filename, logDir: dir, processStartTimeoutMs: 10000, portRangeStart: 42000, portRangeEnd: 49000 };
  const supervisor = {
    status: () => ({ state: running === 'llbot' ? 'running' : 'stopped' }),
    async stop() { events.push('stop:llbot'); if (controls.failStop && running === 'llbot') throw Object.assign(new Error('stop refused'), { code: 'STOP_FAILED' }); if (running === 'llbot') running = null; },
    async start() { events.push('start:llbot'); if ((controls.failStart && sourceDriver !== 'llbot') || (controls.failRestore && sourceDriver === 'llbot')) throw Object.assign(new Error('start failed'), { code: 'START_FAILED' }); assert.equal(running, null); running = 'llbot'; }
  };
  const service = new QQService({ db, config, allocator: new PortAllocator({ db, config }), supervisor,
    secrets: { get: (tenantId, key, fallback = '') => secrets.get(key) || fallback, set: (tenantId, key, value) => secrets.set(key, value), delete: (tenantId, key) => secrets.delete(key) },
    settings: { get: () => '' } });
  const save = service.docker.save.bind(service.docker);
  service.docker.preflight = async () => ({ image: 'fixture', imageId: 'fixture' });
  service.docker.inspect = async () => ({ State: { Running: running === 'napcat' } });
  service.docker.stop = async () => {
    events.push('stop:napcat');
    if (controls.failStop && running === 'napcat') throw Object.assign(new Error('stop refused'), { code: 'STOP_FAILED' });
    if (running === 'napcat') running = null;
    const row = service.docker.row(tenant.id);
    save({ ...row, container_id: null, network_id: null, desired_state: 'stopped', state: 'stopped' });
  };
  service.docker.start = async (tenant, account, directory, options = {}) => {
    events.push('start:napcat');
    if ((controls.failStart && sourceDriver !== 'napcat') || (controls.failRestore && sourceDriver === 'napcat')) throw Object.assign(new Error('start failed'), { code: 'START_FAILED' });
    assert.equal(running, null);
    running = 'napcat';
    save({ tenant_id: tenant.id, runtime_id: options.runtimeId, driver: 'napcat', generation: options.generation, container_id: 'fake-container', network_id: 'fake-network', image: 'fixture', desired_state: 'running', state: 'running', updated_at: Date.now() });
  };
  const originalDriver = service.driver.bind(service);
  service.driver = (driver) => ({ ...originalDriver(driver),
    async prepare(ctx) { events.push(`prepare:${driver}`); assert.ok(ctx.paths.dir.includes(driver)); },
    async launch(ctx) { return { command: 'fixture', args: [], cwd: ctx.paths.dir, readyOptional: true }; },
    async status() { const online = driver === sourceDriver || controls.online; return { online, uin: online ? (controls.wrong && driver !== sourceDriver ? '99999' : '12345') : null, nickname: 'fixture' }; },
    async qrcode() { return { state: 'ready', qrcodeUrl: 'https://fixture.test/qr' }; }
  });
  service.switchLifecycle = {
    snapshot: async () => { events.push('snapshot'); return { agentWasRunning: controls.agent }; },
    quiesce: async () => { events.push('quiesce'); },
    resume: async (_, operation) => { assert.equal(operation.agentWasRunning, controls.agent); events.push('resume'); }
  };
  service.agentRuntime = { health: async () => ({ ok: true, channels: { qq: { connected: controls.health, selfId: '12345', generation: service.account(tenant.id).runtime_generation } } }) };
  service.switches.loginInfo = async (_, account) => controls.onebotWrong && account.driver !== sourceDriver ? '99999' : '12345';
  service.upsertAccount({ tenant_id: tenant.id, driver: sourceDriver, expected_uin: '12345', uin: '12345', state: 'online', webui_port: 41001, ob11_port: 41002, http_port: sourceDriver === 'napcat' ? 41003 : null });
  if (sourceDriver === 'napcat') save({ tenant_id: tenant.id, runtime_id: 'source', driver: 'napcat', generation: 1, container_id: 'source-container', network_id: 'source-network', image: 'fixture', desired_state: 'running', state: 'running', updated_at: Date.now() });
  service.switches.claim(tenant, service.account(tenant.id));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, tenant, db, events, controls, secrets, running: () => running,
    start: () => service.startSwitch(tenant, { driver: sourceDriver === 'llbot' ? 'napcat' : 'llbot', expectedRevision: service.account(tenant.id).revision, idempotencyKey: 'switch-1' }) };
}

for (const source of ['llbot', 'napcat']) test(`switch ${source} commits only after target UIN and OneBot verification`, async (t) => {
  const e = setup(t, source);
  const original = e.service.account(e.tenant.id);
  let op = await e.start();
  assert.equal(op.phase, 'waiting_qr', JSON.stringify(op));
  assert.deepEqual(e.service.account(e.tenant.id), original);
  assert.equal((await e.service.status(e.tenant)).activeOperationId, op.operationId);
  const qr = await e.service.qrcode(e.tenant);
  assert.equal(qr.operationId, op.operationId);
  assert.equal(qr.runtimeGeneration, op.runtimeGeneration);
  assert.equal(qr.qrGeneration, 1);
  assert.equal((await e.service.qrcode(e.tenant)).qrGeneration, 1);
  await assert.rejects(e.service.start(e.tenant), { code: 'QQ_SWITCH_ACTIVE' });
  await assert.rejects(e.service.prepare(e.tenant), { code: 'QQ_SWITCH_ACTIVE' });
  await assert.rejects(e.service.stop(e.tenant), { code: 'QQ_SWITCH_ACTIVE' });
  e.controls.online = true;
  const replies = await Promise.all(Array.from({ length: 5 }, () => e.service.getOperation(e.tenant, op.operationId)));
  op = replies[0];
  assert.equal(op.status, 'succeeded', JSON.stringify(op));
  assert.equal(e.service.account(e.tenant.id).driver, source === 'llbot' ? 'napcat' : 'llbot');
  assert.equal(e.service.account(e.tenant.id).revision, 1);
  assert.equal(e.events.filter(event => event === 'resume').length, 1);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_profiles').get().n, 2);
  const links = await e.service.describeChannels(e.tenant);
  assert.equal(links.generation, op.runtimeGeneration);
  assert.ok([...e.secrets.keys()].some(key => key.includes('.runtime.')));
  assert.equal((await e.service.startSwitch(e.tenant, { driver: op.targetDriver, expectedRevision: 0, idempotencyKey: 'switch-1' })).operationId, op.operationId);
});

test('missing LLBot auth fails without snapshot, stop, profile or secret mutation', async (t) => {
  const e = setup(t, 'napcat'); e.service.config.platformAuthToken = '';
  const account = e.service.account(e.tenant.id);
  const op = await e.start();
  assert.equal(op.status, 'failed'); assert.equal(op.error.code, 'AUTH_TOKEN_REQUIRED');
  assert.deepEqual(e.service.account(e.tenant.id), account);
  assert.deepEqual(e.events, []); assert.equal(e.secrets.size, 0);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_profiles').get().n, 0);
});

for (const scenario of ['start', 'wrong', 'onebotWrong', 'cancel']) test(`${scenario} stops target before restoring source`, async (t) => {
  const e = setup(t);
  if (scenario === 'start') e.controls.failStart = true;
  let op = await e.start();
  if (scenario === 'cancel') op = await e.service.cancelSwitch(e.tenant, op.operationId);
  else if (scenario !== 'start') { e.controls.online = true; e.controls[scenario] = true; op = await e.service.getOperation(e.tenant, op.operationId); }
  assert.equal(op.status, scenario === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(op));
  assert.equal(op.rollback.status, 'restored');
  assert.equal(e.running(), 'llbot');
  assert.equal(e.service.account(e.tenant.id).driver, 'llbot');
  if (scenario !== 'start') assert.ok(e.events.indexOf('stop:napcat') < e.events.lastIndexOf('start:llbot'));
});

test('restore false stops target and never restarts source or agent', async (t) => {
  const e = setup(t); let op = await e.start();
  op = await e.service.cancelSwitch(e.tenant, op.operationId, { restore: false });
  assert.equal(op.status, 'cancelled', JSON.stringify(op)); assert.equal(op.rollback.status, 'stopped');
  assert.equal(e.running(), null); assert.equal(e.events.includes('resume'), false); assert.equal(e.events.includes('start:llbot'), false);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_account_claims').get().n, 0);
});

test('unconfirmed old stop retains claim and never starts target or rollback', async (t) => {
  const e = setup(t); e.controls.failStop = true;
  const op = await e.start(); assert.equal(op.status, 'needs_attention');
  assert.equal(e.events.some(event => event.startsWith('start:')), false);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_account_claims').get().n, 1);
});

test('unconfirmed target stop prevents rollback start', async (t) => {
  const e = setup(t); const op = await e.start(); e.controls.failStop = true;
  const cancelled = await e.service.cancelSwitch(e.tenant, op.operationId);
  assert.equal(cancelled.status, 'needs_attention'); assert.equal(e.events.includes('start:llbot'), false);
  assert.equal(e.running(), 'napcat');
});

test('failed rollback is explicit and keeps operation locked', async (t) => {
  const e = setup(t); const op = await e.start(); e.controls.failRestore = true;
  const cancelled = await e.service.cancelSwitch(e.tenant, op.operationId);
  assert.equal(cancelled.status, 'needs_attention'); assert.equal(cancelled.rollback.status, 'failed');
  assert.equal(e.service.hasActiveSwitch(e.tenant.id), true);
});

test('manager restart can adopt verified waiting NapCat and cannot adopt unknown LLBot', async (t) => {
  const e = setup(t); const op = await e.start();
  await e.service.recoverSwitches();
  assert.equal((await e.service.getOperation(e.tenant, op.operationId)).phase, 'waiting_qr');
  e.controls.online = true; await e.service.recoverSwitches();
  assert.equal((await e.service.getOperation(e.tenant, op.operationId)).status, 'succeeded');
});

test('manager restart marks in-flight process generation needs attention', async (t) => {
  const e = setup(t, 'napcat'); const op = await e.start();
  await e.service.recoverSwitches();
  assert.equal((await e.service.getOperation(e.tenant, op.operationId)).status, 'needs_attention');
  assert.equal(e.events.filter(event => event === 'start:llbot').length, 1);
});

test('agent generation must be confirmed and resume occurs only once', async (t) => {
  const e = setup(t); e.controls.online = true; e.controls.health = false;
  const op = await e.start(); assert.equal(op.phase, 'verify_agent');
  await e.service.getOperation(e.tenant, op.operationId);
  assert.equal(e.events.filter(event => event === 'resume').length, 1);
  e.controls.health = true;
  assert.equal((await e.service.getOperation(e.tenant, op.operationId)).status, 'succeeded');
});

test('OneBot probe exercises authenticated HTTP and WebSocket get_login_info', async (t) => {
  const e = setup(t);
  const realProbe = Object.getPrototypeOf(e.service.switches).loginInfo.bind(e.service.switches);
  const account = { expected_uin: '12345', driver: 'napcat', runtime_secret_namespace: 'qq.napcat.runtime.test' };
  const token = e.service.tokens(e.tenant, account).onebotToken;
  const server = http.createServer((req, res) => { assert.equal(req.url, '/get_login_info'); assert.equal(req.headers.authorization, `Bearer ${token}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 12345 } })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  account.http_port = server.address().port;
  assert.equal(await realProbe(e.tenant, account), '12345');
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  t.after(() => new Promise(resolve => ws.close(resolve)));
  ws.on('connection', (client, req) => { assert.equal(req.headers.authorization, `Bearer ${token}`); client.on('message', raw => { const data = JSON.parse(raw); assert.equal(data.action, 'get_login_info'); client.send(JSON.stringify({ echo: data.echo, status: 'ok', retcode: 0, data: { user_id: 12345 } })); }); });
  account.driver = 'llbot'; account.ob11_port = ws.address().port;
  assert.equal(await realProbe(e.tenant, account), '12345');
});

test('normal restart after switch retains profile and rotates generation and credentials', async (t) => {
  const e = setup(t); e.controls.agent = false; e.controls.online = true;
  const op = await e.start(); assert.equal(op.status, 'succeeded');
  const before = e.service.account(e.tenant.id);
  const token = e.service.tokens(e.tenant, before).onebotToken;
  e.service.agentRuntime.stop = async () => {};
  await e.service.stop(e.tenant);
  await e.service.start(e.tenant);
  const after = e.service.account(e.tenant.id);
  assert.equal(after.effective_profile_id, before.effective_profile_id);
  assert.ok(after.runtime_generation > before.runtime_generation);
  assert.notEqual(e.service.tokens(e.tenant, after).onebotToken, token);
  assert.equal(e.db.prepare('SELECT runtime_id FROM qq_account_claims').get().runtime_id, after.effective_runtime_id);
});

test('normal start refuses another tenant account claim before launch', async (t) => {
  const e = setup(t); await e.service.switches.stopRuntime(e.tenant, e.service.account(e.tenant.id));
  e.db.prepare("INSERT INTO tenants(id,slug,name,plan_id,owner_user_id,status,created_at,expires_at,updated_at,data_dir) VALUES ('other','other','other','starter','owner','active',0,?,0,'unused')").run(Date.now() + 3600000);
  e.db.prepare("UPDATE qq_account_claims SET tenant_id='other'").run();
  await assert.rejects(e.service.start(e.tenant), { code: 'QQ_ACCOUNT_IN_USE' });
  assert.equal(e.events.some(event => event.startsWith('start:')), false);
});

test('rollback waiting login can be cancelled with restore false without starting again', async (t) => {
  const e = setup(t); const op = await e.start();
  e.controls.failRestore = true;
  assert.equal((await e.service.cancelSwitch(e.tenant, op.operationId)).status, 'needs_attention');
  e.controls.failRestore = false;
  const count = e.events.filter(event => event.startsWith('start:')).length;
  const stopped = await e.service.cancelSwitch(e.tenant, op.operationId, { restore: false });
  assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped));
  assert.equal(e.events.filter(event => event.startsWith('start:')).length, count);
});

test('HTTP switch runs real LLBot fixture, Docker runtime adapter, drivers and SQLite through commit', async (t) => {
  const { startManager, loginAdmin } = await import('./helpers.mjs');
  const { FakeDockerRunner } = await import('./fixtures/fake-docker-runner.mjs');
  const env = await startManager({ platformAuthToken: 'fixture-auth-token', napcatImage: `fixture/napcat@sha256:${'a'.repeat(64)}` });
  const runner = new FakeDockerRunner();
  env.manager.qq.docker.command = runner.command.bind(runner);
  t.after(async () => { await env.stop(); await runner.close(); });
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Execution', slug: 'execution', planId: 'starter' })).json.tenant.id;
  const tenant = env.manager.tenants.row(tenantId);
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { driver: 'llbot', uin: '12345' } })).status, 200);
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' })).status, 200);
  await env.manager.agent.stop(tenant);
  const previous = env.manager.qq.account(tenantId);
  const response = await admin.call(`/api/tenants/${tenantId}/qq/switch`, { method: 'POST', body: { driver: 'napcat', expectedRevision: previous.revision, idempotencyKey: 'real-http-switch' } });
  assert.equal(response.status, 202, response.text);
  const operation = response.json.operation;
  assert.equal(operation.phase, 'waiting_qr', response.text);
  assert.equal(env.manager.supervisor.status(tenantId, 'qq').state, 'stopped');
  assert.deepEqual(env.manager.qq.account(tenantId), previous);
  const qr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.equal(qr.json.qrcode.operationId, operation.operationId);
  runner.online = true;
  const result = await admin.call(`/api/tenants/${tenantId}/qq/operations/${operation.operationId}/advance`, { method: 'POST' });
  assert.equal(result.json.operation.status, 'succeeded', result.text);
  assert.equal(env.manager.qq.account(tenantId).revision, previous.revision + 1);
  assert.equal(env.manager.qq.account(tenantId).driver, 'napcat');
  assert.equal(runner.containers.size, 1);
  const cancel = await admin.call(`/api/tenants/${tenantId}/qq/operations/${operation.operationId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 409, cancel.text);
  assert.equal(cancel.json.code, 'CANCEL_TOO_LATE');
});

test('rollback restores a running Bili Agent when source QQ was stopped', async (t) => {
  const e = setup(t);
  await e.service.switches.stopRuntime(e.tenant, e.service.account(e.tenant.id));
  e.events.length = 0;
  let healthChecks = 0;
  e.service.agentRuntime.health = async () => { healthChecks++; return { ok: true, channels: { bili: { connected: true } } }; };
  const op = await e.start();
  const result = await e.service.cancelSwitch(e.tenant, op.operationId);
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.equal(result.rollback.status, 'stopped');
  assert.equal(e.events.filter(event => event === 'resume').length, 1);
  assert.equal(e.events.includes('start:llbot'), false);
  assert.equal(healthChecks, 1);
  assert.equal(e.running(), null);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_account_claims').get().n, 0);
});

for (const asyncAudit of [false, true]) test(`audit failure after completion cannot rollback (${asyncAudit ? 'async' : 'sync'})`, async (t) => {
  const e = setup(t); e.controls.online = true;
  const auditError = () => { throw new Error('audit unavailable'); };
  e.service.audit = { record: asyncAudit ? async () => auditError() : auditError };
  const logs = [];
  e.service.logger = { error: (...args) => logs.push(args) };
  const result = await e.start();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.rollback, null);
  assert.equal(e.running(), 'napcat');
  assert.equal(e.events.includes('stop:napcat'), false);
  assert.equal(e.events.includes('start:llbot'), false);
  assert.equal(e.service.account(e.tenant.id).revision, 1);
  assert.equal(logs.length, 1);
});

for (const phase of ['committed', 'resume_intent', 'verify_agent']) test(`user cancel rejects ${phase} but platform stop is safe`, async (t) => {
  const e = setup(t); e.controls.online = true; e.controls.health = false;
  const op = await e.start(); assert.equal(op.phase, 'verify_agent');
  e.db.prepare('UPDATE qq_operations SET phase=? WHERE id=?').run(phase, op.operationId);
  const before = [...e.events];
  await assert.rejects(e.service.cancelSwitch(e.tenant, op.operationId), { code: 'CANCEL_TOO_LATE' });
  assert.equal(e.service.publicOperation(e.service.switches.row(e.tenant, op.operationId)).canCancel, false);
  assert.deepEqual(e.events, before);
  const stopped = await e.service.cancelSwitch(e.tenant, op.operationId, { restore: false });
  assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped));
  assert.equal(e.running(), null);
  assert.equal(e.events.filter(event => event === 'resume').length, 1);
  assert.equal(e.events.includes('start:llbot'), false);
});

test('rollback generation rotates credentials while preserving profile session', async (t) => {
  const e = setup(t);
  const source = e.service.account(e.tenant.id);
  const profile = e.service.switches.profile(e.tenant, source, true);
  e.service.upsertAccount({ ...source, effective_profile_id: profile.id });
  fs.mkdirSync(profile.directory, { recursive: true });
  const session = path.join(profile.directory, 'session.fixture');
  fs.writeFileSync(session, 'preserved session');
  const before = e.service.tokens(e.tenant, source);
  const op = await e.start();
  const target = JSON.parse(e.service.switches.row(e.tenant, op.operationId).target_json).account;
  const targetTokens = e.service.tokens(e.tenant, target);
  const cancelled = await e.service.cancelSwitch(e.tenant, op.operationId);
  assert.equal(cancelled.rollback.status, 'restored');
  const restored = e.service.account(e.tenant.id);
  const tokens = e.service.tokens(e.tenant, restored);
  assert.ok(restored.runtime_generation > op.runtimeGeneration);
  assert.equal(restored.runtime_secret_namespace, `qq.llbot.runtime.${restored.runtime_generation}`);
  assert.notEqual(tokens.onebotToken, before.onebotToken);
  assert.notEqual(tokens.webuiPassword, before.webuiPassword);
  assert.notEqual(tokens.onebotToken, targetTokens.onebotToken);
  assert.equal(restored.effective_profile_id, profile.id);
  assert.equal(fs.readFileSync(session, 'utf8'), 'preserved session');
});

for (const kind of ['directory', 'syntax', 'incomplete-dist']) test(`LLBot ${kind} fails preflight before touching NapCat`, async (t) => {
  const e = setup(t, 'napcat');
  const entry = path.join(e.tenant.data_dir, kind === 'incomplete-dist' ? 'llbot.js' : 'broken.mjs');
  if (kind === 'directory') fs.mkdirSync(entry);
  else fs.writeFileSync(entry, kind === 'syntax' ? 'export const = broken;' : 'export const built = true;');
  e.service.config.llbotEntry = entry;
  const before = e.service.account(e.tenant.id);
  const result = await e.start();
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'LLBOT_NOT_BUILT');
  assert.deepEqual(e.events, []); assert.equal(e.secrets.size, 0);
  assert.deepEqual(e.service.account(e.tenant.id), before);
  assert.equal(e.running(), 'napcat');
});

test('unknown Docker creation intent blocks executor stop, Docker stop and Docker start', async (t) => {
  const e = setup(t); const op = await e.start();
  const { DockerRuntime } = await import('../src/qq/docker-runtime.js');
  const docker = new DockerRuntime({ db: e.db, config: e.service.config });
  let commands = 0;
  docker.command = async () => { commands++; throw new Error('must not run'); };
  const row = e.service.docker.row(e.tenant.id);
  docker.save({ ...row, container_id: null, network_id: null, state: 'network_create_intent', desired_state: 'running' });
  const before = docker.row(e.tenant.id);
  const claim = e.db.prepare('SELECT * FROM qq_account_claims').get();
  const leases = e.db.prepare('SELECT * FROM port_leases').all();
  await assert.rejects(docker.stop(e.tenant.id), { code: 'NAPCAT_RESOURCE_UNCONFIRMED' });
  await assert.rejects(docker.start(e.tenant, e.service.account(e.tenant.id), e.tenant.data_dir), { code: 'NAPCAT_RESOURCE_UNCONFIRMED' });
  assert.equal(commands, 0); assert.deepEqual(docker.row(e.tenant.id), before);
  const result = await e.service.cancelSwitch(e.tenant, op.operationId, { restore: false });
  assert.equal(result.status, 'needs_attention');
  assert.deepEqual(e.db.prepare('SELECT * FROM qq_account_claims').get(), claim);
  assert.deepEqual(e.db.prepare('SELECT * FROM port_leases').all(), leases);
  assert.equal(e.events.includes('start:llbot'), false);
});

test('Docker preflight failure and allocated-without-create evidence clean safely', async (t) => {
  const e = setup(t, 'napcat');
  const { DockerRuntime } = await import('../src/qq/docker-runtime.js');
  const docker = new DockerRuntime({ db: e.db, config: e.service.config });
  e.db.prepare('DELETE FROM qq_runtimes').run();
  docker.preflight = async () => { throw Object.assign(new Error('preflight'), { code: 'PREFLIGHT' }); };
  await assert.rejects(docker.start(e.tenant, e.service.account(e.tenant.id), e.tenant.data_dir), { code: 'PREFLIGHT' });
  assert.equal(docker.row(e.tenant.id), null);
  docker.save({ tenant_id: e.tenant.id, runtime_id: 'allocated-only', driver: 'napcat', generation: 2, container_id: null, network_id: null, image: 'fixture', desired_state: 'running', state: 'allocated', updated_at: Date.now() });
  await docker.stop(e.tenant.id);
  assert.equal(docker.row(e.tenant.id).state, 'stopped');
});

test('same tenant stale runtime or operation cannot overwrite or release a claim', async (t) => {
  const e = setup(t);
  const legacy = e.service.account(e.tenant.id);
  await e.service.switches.stopRuntime(e.tenant, legacy);
  assert.equal(e.service.switches.releaseClaim(e.tenant, legacy), 1);
  const old = { ...legacy, effective_runtime_id: 'old-runtime' };
  const next = { ...legacy, effective_runtime_id: 'new-runtime' };
  e.service.switches.claim(e.tenant, next, 'new-operation');
  assert.throws(() => e.service.switches.claim(e.tenant, old, 'old-operation'), { code: 'QQ_CLAIM_CONFLICT' });
  assert.throws(() => e.service.switches.claim(e.tenant, next, 'old-operation'), { code: 'QQ_CLAIM_CONFLICT' });
  assert.equal(e.service.switches.releaseClaim(e.tenant, old, 'old-operation'), 0);
  assert.equal(e.service.switches.releaseClaim(e.tenant, legacy), 0);
  assert.equal(e.service.switches.releaseClaim(e.tenant, next, 'old-operation'), 0);
  assert.equal(e.db.prepare('SELECT runtime_id FROM qq_account_claims').get().runtime_id, 'new-runtime');
  e.service.switches.claim(e.tenant, next, null, 'new-operation');
  assert.equal(e.service.switches.releaseClaim(e.tenant, next, 'new-operation'), 0);
  assert.equal(e.service.switches.releaseClaim(e.tenant, next), 1);
});

test('normal restart failure releases the new runtime claim only after confirmed stop', async (t) => {
  const e = setup(t); e.controls.agent = false; e.controls.online = true;
  await e.start(); e.service.agentRuntime.stop = async () => {};
  await e.service.stop(e.tenant);
  e.controls.failStart = true;
  await assert.rejects(e.service.start(e.tenant), { code: 'START_FAILED' });
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM qq_account_claims').get().n, 0);
});

test('restart recovery checks unresolved Agent before target identity can commit', async (t) => {
  const e = setup(t); const op = await e.start(); e.controls.online = true;
  const before = e.service.account(e.tenant.id);
  e.service.agentRuntime.assertNoUnconfirmedAgent = () => { throw Object.assign(new Error('unconfirmed Agent'), { code: 'AGENT_STOP_UNCONFIRMED' }); };
  await e.service.recoverSwitches();
  const result = await e.service.getOperation(e.tenant, op.operationId);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.error.code, 'AGENT_STOP_UNCONFIRMED');
  assert.deepEqual(e.service.account(e.tenant.id), before);
  assert.equal(e.events.includes('resume'), false);
});

for (const resource of ['network', 'container']) test(`lost Docker ${resource} create reply preserves intent and blocks retries`, async (t) => {
  const e = setup(t, 'napcat');
  const { DockerRuntime } = await import('../src/qq/docker-runtime.js');
  const docker = new DockerRuntime({ db: e.db, config: e.service.config });
  e.db.prepare('DELETE FROM qq_runtimes').run();
  docker.preflight = async () => ({ image: 'fixture', imageId: `sha256:${'a'.repeat(64)}` });
  const commands = [];
  docker.command = async (args) => {
    commands.push(args);
    if (args[0] === 'network' && args[1] === 'create' && resource === 'container') return 'created-network';
    throw Object.assign(new Error('create reply lost'), { code: 'DOCKER_COMMAND_FAILED' });
  };
  await assert.rejects(docker.start(e.tenant, e.service.account(e.tenant.id), e.tenant.data_dir), { code: 'NAPCAT_CLEANUP_UNCONFIRMED' });
  const row = docker.row(e.tenant.id);
  assert.equal(row.state, `${resource}_create_intent`);
  assert.equal(row.desired_state, 'stopped');
  assert.equal(row.container_id, null);
  assert.equal(row.network_id, resource === 'container' ? 'created-network' : null);
  assert.equal(commands.length, resource === 'container' ? 2 : 1);
  await assert.rejects(docker.stop(e.tenant.id), { code: 'NAPCAT_RESOURCE_UNCONFIRMED' });
  await assert.rejects(docker.start(e.tenant, e.service.account(e.tenant.id), e.tenant.data_dir), { code: 'NAPCAT_RESOURCE_UNCONFIRMED' });
  assert.deepEqual(docker.row(e.tenant.id), row);
  assert.equal(commands.length, resource === 'container' ? 2 : 1);
  assert.equal((await e.service.runtimeStatus(e.tenant)).state, 'degraded');
  const claim = e.db.prepare('SELECT * FROM qq_account_claims').get();
  const operation = await e.start();
  assert.equal(operation.status, 'needs_attention');
  assert.equal(operation.error.code, 'QQ_RUNTIME_UNCONFIRMED');
  assert.equal((await e.service.cancelSwitch(e.tenant, operation.operationId, { restore: false })).status, 'needs_attention');
  assert.deepEqual(e.db.prepare('SELECT * FROM qq_account_claims').get(), claim);
  assert.deepEqual(e.events, []);
});
