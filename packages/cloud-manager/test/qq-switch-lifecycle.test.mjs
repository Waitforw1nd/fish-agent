import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startManager, loginAdmin } from './helpers.mjs';
import { isolateQqSwitchTasks } from '../../qq-agent-core/src/qq-switch-isolation.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { HostingService } from '../src/hosting.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'messages'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  return dir;
}
function put(dir, name, value) { fs.writeFileSync(path.join(dir, name), JSON.stringify(value)); }
function get(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }

test('switch isolation persists QQ interruptions while preserving Bili messages and sessions', t => {
  const dir = fixture(t);
  put(dir, 'config.json', { channels: { qq: { idRange: [1, 100] }, bili: { idRange: [101, 200] } } });
  put(dir, 'messages/group_1.json', { chatKey: 'group:1', messages: [{ id: 1, read: false }, { id: 2, self: true, read: true }] });
  put(dir, 'messages/group_101.json', { chatKey: 'group:101', messages: [{ id: 1, read: false }] });
  put(dir, 'sessions/qq.json', { id: 'qq', chatKey: 'group:1', status: 'running' });
  put(dir, 'sessions/bili.json', { id: 'bili', chatKey: 'group:101', status: 'running' });
  assert.deepEqual(isolateQqSwitchTasks(dir, { operationId: 'op' }), { messages: 1, sessions: 1 });
  assert.equal(get(dir, 'messages/group_1.json').messages[0].interruptedByQqSwitch, 'op');
  assert.equal(get(dir, 'messages/group_101.json').messages[0].read, false);
  assert.equal(get(dir, 'sessions/qq.json').status, 'aborted');
  assert.equal(get(dir, 'sessions/qq.json').sendResult, 'unknown');
  assert.equal(get(dir, 'sessions/bili.json').status, 'running');
  assert.deepEqual(isolateQqSwitchTasks(dir, { operationId: 'op', stoppedAt: Date.now() + 1000 }), { messages: 0, sessions: 0 });
});

test('quiesce waits for confirmed agent stop before isolation and resume respects tenant status', async t => {
  const dir = fixture(t);
  const tenant = { id: 'a', data_dir: dir, status: 'active', expires_at: Date.now() + 10000 };
  fs.renameSync(path.join(dir, 'messages'), path.join(dir, 'messages-unused'));
  fs.renameSync(path.join(dir, 'sessions'), path.join(dir, 'sessions-unused'));
  fs.mkdirSync(path.join(dir, 'data', 'messages'), { recursive: true });
  put(dir, 'data/messages/group_1.json', { chatKey: 'group:1', messages: [{ read: false }] });
  let fail = true, starts = 0;
  const agent = new AgentRuntime({ db: { prepare: () => ({ get: () => null }) }, supervisor: { status: () => ({ state: 'running' }), stop: async () => { if (fail) throw new Error('unconfirmed'); } }, allocator: { release() {} } });
  agent.start = async () => { starts++; };
  assert.deepEqual(agent.switchSnapshot(tenant), { agentWasRunning: true });
  await assert.rejects(agent.switchQuiesce(tenant, { id: 'op' }), /unconfirmed/);
  assert.equal(get(dir, 'data/messages/group_1.json').messages[0].read, false);
  fail = false;
  agent.supervisor.status = () => ({ state: 'stopped' });
  await agent.switchQuiesce(tenant, { id: 'op' });
  assert.equal(get(dir, 'data/messages/group_1.json').messages[0].read, true);
  await agent.switchResume(tenant, { agentWasRunning: false });
  await agent.switchResume({ ...tenant, status: 'expired' }, { agentWasRunning: true });
  await agent.switchResume(tenant, { agentWasRunning: true });
  assert.equal(starts, 1);
});

test('persisted switch isolation controls actual backlog recovery without altering Bili memory', t => {
  const dir = fixture(t);
  const bili = 2 ** 52;
  put(dir, 'messages/group_1.json', { chatKey: 'group:1', nextLocalId: 2, messages: [{ id: 1, read: false, self: false, ts: Date.now() }] });
  put(dir, `messages/group_${bili}.json`, { chatKey: `group:${bili}`, nextLocalId: 2, messages: [{ id: 1, read: false, self: false, ts: Date.now() }] });
  put(dir, 'sessions/pending.json', { id: 'pending', chatKey: 'group:1', status: 'waiting' });
  put(dir, 'sessions/inflight.json', { id: 'inflight', chatKey: 'group:1', status: 'running' });
  fs.mkdirSync(path.join(dir, 'memory'));
  put(dir, 'memory/bili.json', { content: '保留的记忆' });
  isolateQqSwitchTasks(dir, { operationId: 'op' });
  const root = new URL('../../qq-agent-core/src/', import.meta.url);
  const script = `
    import { ChatStore } from ${JSON.stringify(new URL('store.js', root).href)};
    import { SessionRegistry } from ${JSON.stringify(new URL('sessions.js', root).href)};
    import { Orchestrator } from ${JSON.stringify(new URL('orchestrator.js', root).href)};
    const store = new ChatStore(); const sessions = new SessionRegistry();
    const orchestrator = new Orchestrator({store, sessions, onebot: {}, memory: {}, sender: {}, stickers: {}});
    const wakes = []; orchestrator.scheduleWake = key => wakes.push(key);
    orchestrator.drainBacklogAfterResume();
    console.log(JSON.stringify({wakes, pending: sessions.get('pending'), inflight: sessions.get('inflight')}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(recovered.wakes, [`group:${bili}`]);
  assert.equal(recovered.pending.status, 'aborted');
  assert.equal(recovered.inflight.sendResult, 'unknown');
  assert.equal(get(dir, 'memory/bili.json').content, '保留的记忆');
});

test('manager restart refuses stale agent records without changing files or port lease', async t => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Interrupted Agent', slug: 'interrupted-agent', planId: 'starter' })).json.tenant.id;
  const tenant = env.manager.tenants.row(tenantId);
  const dir = env.manager.agent.dataDir(tenant);
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  put(dir, 'messages/group_1.json', { chatKey: 'group:1', messages: [{ read: false }] });
  const lease = await env.manager.agent.allocator.allocate(tenantId, 'agent.http', { host: '127.0.0.1' });
  env.manager.db.prepare("INSERT INTO process_runs (id, tenant_id, kind, pid, status, started_at) VALUES (?, ?, 'agent', ?, 'running', ?)").run('orphan', tenantId, 1234, Date.now());
  assert.throws(() => env.manager.qq.switchLifecycle.snapshot(tenant), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.qq.switchLifecycle.quiesce(tenant, { id: 'op' }), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.qq.switchLifecycle.resume(tenant, { agentWasRunning: true }), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.qq.switchLifecycle.resume(tenant, { agentWasRunning: false }), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.agent.stop(tenant), { code: 'PROCESS_STOP_UNCONFIRMED' });
  assert.equal(get(dir, 'messages/group_1.json').messages[0].read, false);
  assert.equal(env.manager.agent.allocator.find(tenantId, 'agent.http').port, lease.port);
  env.manager.db.prepare("UPDATE process_runs SET status='interrupted', stopped_at=? WHERE id='orphan'").run(Date.now());
  assert.throws(() => env.manager.qq.switchLifecycle.snapshot(tenant), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.qq.switchLifecycle.quiesce(tenant, { id: 'op' }), { code: 'PROCESS_STOP_UNCONFIRMED' });
  await assert.rejects(env.manager.supervisor.shutdown(), AggregateError);
  env.manager.db.prepare("DELETE FROM process_runs WHERE id='orphan'").run();
});

test('lifecycle hooks stop and restart a real supervised fake agent with committed QQ config', async t => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Agent lifecycle', slug: 'switch-agent-config', planId: 'starter' })).json.tenant.id;
  const tenant = env.manager.tenants.row(tenantId);
  let generation = 1;
  env.manager.agent.setLinksResolver(async () => ({ qq: { enabled: true, driver: 'napcat', generation, uin: '12345', wsUrl: 'ws://127.0.0.1:3333', httpUrl: 'http://127.0.0.1:3334' }, bili: { enabled: true, wsUrl: 'ws://127.0.0.1:4444' } }));
  await env.manager.agent.start(tenant);
  const snapshot = env.manager.qq.switchLifecycle.snapshot(tenant);
  assert.deepEqual(snapshot, { agentWasRunning: true });
  await env.manager.qq.switchLifecycle.quiesce(tenant, { id: 'op', ...snapshot, createdAt: Date.now() });
  assert.equal(env.manager.supervisor.status(tenantId, 'agent').state, 'stopped');
  const exit = env.manager.db.prepare("SELECT * FROM process_runs WHERE tenant_id=? AND kind='agent'").get(tenantId);
  assert.equal(exit.status, 'stopped');
  assert.ok(exit.stopped_at);
  generation = 2;
  await Promise.all([
    env.manager.qq.switchLifecycle.resume(tenant, { id: 'op', ...snapshot }),
    env.manager.qq.switchLifecycle.resume(tenant, { id: 'op', ...snapshot })
  ]);
  assert.equal(env.manager.db.prepare("SELECT COUNT(*) AS n FROM process_runs WHERE tenant_id=? AND kind='agent'").get(tenantId).n, 2);
  assert.equal(env.manager.supervisor.status(tenantId, 'agent').state, 'running');
  const config = get(env.manager.agent.dataDir(tenant), 'config.json');
  assert.equal(config.channels.qq.generation, 2);
  assert.equal(config.channels.bili.wsUrl, 'ws://127.0.0.1:4444');
});

test('expired tenant cancellation is scoped and cannot restart either tenant', async t => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const a = (await admin.createTenant({ name: 'A', slug: 'switch-stop-a', planId: 'starter' })).json.tenant.id;
  const b = (await admin.createTenant({ name: 'B', slug: 'switch-stop-b', planId: 'starter' })).json.tenant.id;
  const now = Date.now();
  const insert = env.manager.db.prepare("INSERT INTO qq_operations (id,tenant_id,idempotency_key,request_hash,status,phase,target_driver,expected_uin,expected_revision,created_at,updated_at) VALUES (?, ?, ?, 'hash', 'needs_attention', 'stopping', 'napcat', '12345', 0, ?, ?)");
  insert.run('op-a', a, 'a', now, now);
  insert.run('op-b', b, 'b', now, now);
  env.manager.db.prepare("UPDATE tenants SET status='expired', expires_at=? WHERE id=?").run(now - 1, a);
  const calls = [];
  env.manager.gateway.closeTenant = id => { calls.push(['close-gateway', id]); };
  env.manager.qq.cancelSwitch = async (tenant, id, options) => { calls.push([tenant.id, id, options]); };
  env.manager.agent.stop = async tenant => { calls.push(['stop-agent', tenant.id]); };
  env.manager.qq.stop = async () => { throw new Error('must not stop unresolved QQ'); };
  env.manager.bili.stop = async () => { throw new Error('must not stop unresolved Bili'); };
  await assert.rejects(env.manager.hosting.stop(env.manager.tenants.row(a), { reason: 'expired' }), { code: 'QQ_SWITCH_UNCONFIRMED' });
  assert.deepEqual(calls, [['close-gateway', a], [a, 'op-a', { restore: false }], ['stop-agent', a]]);
  assert.equal(env.manager.qq.hasActiveSwitch(b), true);
  env.manager.db.prepare("UPDATE qq_operations SET status='cancelled' WHERE tenant_id IN (?, ?)").run(a, b);
});

test('resume coalesces concurrent starts and rejects cancelled, suspended, expired or deleted tenants', async () => {
  const tenant = { id: 'a', status: 'active', expires_at: Date.now() + 10000 };
  const agent = new AgentRuntime({ db: { prepare: () => ({ get: () => null }) }, supervisor: { status: () => ({ state: 'stopped' }) } });
  let starts = 0, finish;
  agent.start = async () => { starts++; await new Promise(resolve => { finish = resolve; }); };
  const operation = { agentWasRunning: true };
  await agent.switchResume(tenant, operation, { restore: false });
  await agent.switchResume({ ...tenant, status: 'suspended' }, operation);
  await agent.switchResume({ ...tenant, expires_at: Date.now() - 1 }, operation);
  await agent.switchResume(null, operation);
  assert.equal(starts, 0);
  const first = agent.switchResume(tenant, operation);
  const second = agent.switchResume(tenant, operation);
  await Promise.resolve();
  assert.equal(starts, 1);
  finish();
  await Promise.all([first, second]);
});

test('manager stop propagates unconfirmed exits and retains database for a safe retry', async t => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Shutdown proof', slug: 'shutdown-proof', planId: 'starter' })).json.tenant.id;
  env.manager.db.prepare("INSERT INTO process_runs (id,tenant_id,kind,status,started_at) VALUES ('orphan',?,'agent','interrupted',?)").run(tenantId, Date.now());
  await assert.rejects(env.manager.stop(), AggregateError);
  assert.equal(env.manager.db.prepare("SELECT status FROM process_runs WHERE id='orphan'").get().status, 'interrupted');
  env.manager.db.prepare("DELETE FROM process_runs WHERE id='orphan'").run();
  await env.manager.stop();
});

test('active switch suppresses link updates and blocks tenant start and restart', async () => {
  const hosting = new HostingService({ qq: { hasActiveSwitch: () => true }, tenants: { assertActive() {} }, agent: {}, supervisor: {} });
  await hosting.handleLinksChanged({ id: 'a' });
  await assert.rejects(hosting.start({ id: 'a' }), { code: 'QQ_SWITCH_ACTIVE' });
  await assert.rejects(hosting.restart({ id: 'a' }), { code: 'QQ_SWITCH_ACTIVE' });
});
