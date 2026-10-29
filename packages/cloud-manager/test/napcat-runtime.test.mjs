import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { Client, loginAdmin, startManager } from './helpers.mjs';
import { FakeDockerRunner } from './fixtures/fake-docker-runner.mjs';

test('NapCat preflight, account profiles and API default', async (t) => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const drivers = await admin.call('/api/qq/drivers');
  assert.equal(drivers.json.defaultDriver, 'napcat');
  assert.equal(drivers.json.drivers.find((d) => d.id === 'napcat').reasonCode, 'NAPCAT_IMAGE_NOT_CONFIGURED');
  const tenant = (await admin.createTenant({ name: 'NapCat', slug: 'napcat-test', planId: 'starter' })).json.tenant;
  const prepared = await admin.call(`/api/tenants/${tenant.id}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  assert.equal(prepared.json.qq.driver, 'napcat');
  const start = await admin.call(`/api/tenants/${tenant.id}/qq/start`, { method: 'POST' });
  assert.equal(start.json.code, 'NAPCAT_IMAGE_NOT_CONFIGURED');
  const refresh = await admin.call(`/api/tenants/${tenant.id}/qq/qrcode/refresh`, { method: 'POST' });
  assert.equal(refresh.json.code, 'QQ_NOT_RUNNING');
});

test('allocator skips occupied ports and merges concurrent identical lease requests', async (t) => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenant = (await admin.createTenant({ name: 'Ports', slug: 'port-check', planId: 'starter' })).json.tenant;
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(env.config.portRangeStart, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const [a, b] = await Promise.all([
    env.manager.allocator.allocate(tenant.id, 'test.concurrent', { preferredPort: env.config.portRangeStart }),
    env.manager.allocator.allocate(tenant.id, 'test.concurrent', { preferredPort: env.config.portRangeStart })
  ]);
  assert.equal(a.id, b.id);
  assert.notEqual(a.port, env.config.portRangeStart);
});

test('container identity is checked before stop and stopped state is persisted', async (t) => {
  const env = await startManager(); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Runtime', slug: 'runtime-check', planId: 'starter' })).json.tenant.id;
  await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  const tenant = env.manager.tenants.row(tenantId);
  const docker = env.manager.qq.docker;
  const profile = path.join(tenant.data_dir, 'qq', 'napcat', 'accounts', '12345');
  const spec = { dir: profile, ports: { 6099: 41000, 3001: 41001, 3000: 41002 }, memoryMb: 2048, cpuMillis: 2000, pids: 512, shmMb: 512, logMb: 10, logFiles: 3 };
  const row = { tenant_id: tenantId, runtime_id: 'runtime-test', driver: 'napcat', generation: 1, container_id: 'container-test', network_id: 'network-test', image: 'image@sha256:' + 'a'.repeat(64), image_id: 'sha256:' + 'b'.repeat(64), spec_json: JSON.stringify(spec), desired_state: 'running', state: 'running', updated_at: Date.now() };
  docker.save(row);
  const labels = docker.labels(row);
  let running = true;
  let badIdentity = true;
  const calls = [];
  docker.command = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify([{ Image: row.image_id, Config: { Labels: badIdentity ? {} : labels, Image: row.image }, HostConfig: { Privileged: false, NetworkMode: row.network_id, Memory: 2048 * 1048576, NanoCpus: 2e9, PidsLimit: 512, ShmSize: 512 * 1048576, LogConfig: { Config: { 'max-size': '10m', 'max-file': '3' } }, RestartPolicy: { Name: 'no' }, PortBindings: Object.fromEntries(Object.entries(spec.ports).map(([port, value]) => [`${port}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(value) }]])) }, Mounts: [{ Type: 'bind', RW: true, Source: path.join(profile, 'qq'), Destination: '/app/.config/QQ' }, { Type: 'bind', RW: true, Source: path.join(profile, 'config'), Destination: '/app/napcat/config' }], NetworkSettings: { Networks: { fish: { NetworkID: row.network_id } } }, State: { Running: running } }]);
    if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([{ Labels: labels }]);
    if (args[0] === 'stop') running = false;
    return '';
  };
  await assert.rejects(docker.stop(tenantId), { code: 'NAPCAT_IDENTITY_MISMATCH' });
  assert.equal(docker.row(tenantId).desired_state, 'stopped');
  assert.equal(calls.some((args) => args[0] === 'stop'), false);
  badIdentity = false;
  await docker.stop(tenantId);
  assert.equal(docker.row(tenantId).state, 'stopped');
  assert.equal(docker.row(tenantId).container_id, null);
});

async function fixture(t, extra = {}) {
  const image = `example/napcat@sha256:${'a'.repeat(64)}`;
  const env = await startManager({ napcatImage: image, ...extra });
  const runner = new FakeDockerRunner();
  env.manager.qq.docker.command = runner.command.bind(runner);
  const admin = await loginAdmin(env.manager);
  const tenantId = (await admin.createTenant({ name: 'Docker fixture', slug: 'docker-fixture', planId: 'starter' })).json.tenant.id;
  t.after(async () => { await runner.close(); await env.stop(); });
  return { ...env, runner, admin, tenantId, image };
}

test('NapCat fixture exercises authenticated readiness, binding retry, health, logs and reconcile', async (t) => {
  const { manager, runner, admin, tenantId, image } = await fixture(t);
  runner.failBind = 1;
  const drivers = await admin.call('/api/qq/drivers');
  const napcat = drivers.json.drivers.find(driver => driver.id === 'napcat');
  assert.equal(napcat.allowed, true); assert.equal(napcat.installed, true); assert.equal(napcat.available, true);
  manager.config.qqDrivers = ['llbot'];
  const denied = (await admin.call('/api/qq/drivers')).json.drivers.find(driver => driver.id === 'napcat');
  assert.equal(denied.allowed, false); assert.equal(denied.available, false); assert.equal(denied.reasonCode, 'DRIVER_NOT_ALLOWED');
  manager.config.qqDrivers = ['llbot', 'napcat', 'snowluma'];
  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  assert.equal(prepared.status, 200, prepared.text);
  const oldPorts = Object.values(prepared.json.qq.ports).filter(Number.isInteger);
  const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.qq.runtimeState, 'ready');
  assert.equal(runner.calls.filter(c => c[0] === 'create').length, 2);
  const create = runner.calls.filter(c => c[0] === 'create').at(-1);
  assert.equal(create.at(-1), image);
  assert.ok(create.includes('--pull=never'));
  assert.ok(create.includes('--restart=no'));
  assert.ok(create.includes('--memory') && create.includes('--cpus') && create.includes('--pids-limit') && create.includes('--shm-size'));
  assert.equal(runner.values(create, '-p').length, 3);
  assert.ok(runner.values(create, '-p').every(p => p.startsWith('127.0.0.1:')));
  assert.equal(runner.values(create, '--mount').length, 2);
  assert.ok(runner.values(create, '--label').some(label => label.startsWith('fish.generation=')));
  assert.ok(Object.values(started.json.qq.ports).filter(Number.isInteger).every(port => !oldPorts.includes(port)));
  const row = manager.qq.docker.row(tenantId);
  await manager.hosting.reconcile();
  assert.equal(manager.qq.docker.row(tenantId).container_id, row.container_id);
  const logs = await admin.call(`/api/tenants/${tenantId}/qq/logs`);
  assert.deepEqual(logs.json.logs, ['fake runtime log']);
  runner.online = true;
  let channel = { connected: true, generation: row.generation, selfId: '99999' };
  manager.qq.agentRuntime.health = async () => ({ ok: true, channels: { qq: channel } });
  let status = (await admin.call(`/api/tenants/${tenantId}/qq/status`)).json.qq;
  assert.equal(status.online, true); assert.equal(status.canChat, false);
  channel = { connected: true, generation: row.generation + 1, selfId: '12345' };
  status = (await admin.call(`/api/tenants/${tenantId}/qq/status`)).json.qq;
  assert.equal(status.canChat, false);
  channel = { connected: true, generation: row.generation, selfId: '12345' };
  status = (await admin.call(`/api/tenants/${tenantId}/qq/status`)).json.qq;
  assert.equal(status.canChat, true);
  runner.available = false;
  status = (await admin.call(`/api/tenants/${tenantId}/qq/status`)).json.qq;
  assert.equal(status.runtimeState, 'degraded'); assert.equal(status.canChat, false);
  const failedStop = await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
  assert.equal(failedStop.json.code, 'NAPCAT_INSPECT_FAILED');
  assert.equal(manager.qq.docker.row(tenantId).desired_state, 'stopped');
  assert.ok(manager.qq.docker.row(tenantId).container_id);
  runner.available = true;
  const stop = await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
  assert.equal(stop.status, 200, stop.text);
  assert.equal(manager.qq.docker.row(tenantId).desired_state, 'stopped');
  assert.equal(runner.containers.size, 0); assert.equal(runner.networks.size, 0);
});

test('NapCat fixture cleans up when authenticated WebUI is not ready', async (t) => {
  const { runner, admin, tenantId, manager } = await fixture(t, { processStartTimeoutMs: 120 });
  runner.ready = false;
  await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  const start = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(start.json.code, 'NAPCAT_READY_TIMEOUT');
  assert.equal(runner.containers.size, 0); assert.equal(runner.networks.size, 0);
  assert.equal(manager.qq.docker.row(tenantId).desired_state, 'stopped');
});

test('wrong UIN observed over HTTP disables agent and stops container', async (t) => {
  const { runner, admin, tenantId, manager } = await fixture(t);
  await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  const start = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(start.status, 200, start.text);
  runner.online = true; runner.uin = '98765';
  const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(status.json.qq.state, 'uin_mismatch');
  assert.equal(status.json.qq.canChat, false);
  assert.equal(await manager.qq.describeChannels(manager.tenants.row(tenantId)), null);
  assert.equal(runner.containers.size, 0);
});

test('concurrent prepare and start do not change the account being launched', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  const [start, prepare] = await Promise.all([
    admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } }),
    admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '54321' } })
  ]);
  assert.equal(start.status, 200, start.text);
  assert.equal(prepare.json.code, 'QQ_ALREADY_RUNNING');
  assert.equal(manager.qq.account(tenantId).expected_uin, '12345');
  assert.equal(runner.calls.filter(c => c[0] === 'create').length, 1);
  await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
});

test('binding retries are bounded and leave other tenants leases untouched', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  const other = (await admin.createTenant({ name: 'Other', slug: 'other-docker', planId: 'starter' })).json.tenant.id;
  const otherLease = await manager.allocator.allocate(other, 'qq.http');
  await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '12345' } });
  runner.failBind = 5;
  const start = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(start.json.code, 'NAPCAT_PORT_CONFLICT');
  assert.equal(runner.calls.filter(c => c[0] === 'create').length, 3);
  assert.equal(manager.allocator.find(other, 'qq.http').id, otherLease.id);
  assert.equal(runner.containers.size, 0); assert.equal(runner.networks.size, 0);
});

test('tampered container boundaries and image identity cannot be adopted', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } });
  assert.equal(started.status, 200, started.text);
  const row = manager.qq.docker.row(tenantId);
  const container = runner.containers.get(row.container_id);
  const mutations = [
    c => c.Mounts.push({ Type: 'bind', RW: true, Source: '/secret', Destination: '/secret' }),
    c => { c.HostConfig.Privileged = true; },
    c => { c.HostConfig.PidMode = 'host'; },
    c => { c.NetworkSettings.Networks.other = { NetworkID: 'other' }; },
    c => { c.HostConfig.PortBindings['6099/tcp'][0].HostIp = '0.0.0.0'; },
    c => { c.Image = `sha256:${'c'.repeat(64)}`; },
    c => { c.HostConfig.Memory = 1; }
  ];
  for (const mutate of mutations) {
    const before = structuredClone({ Image: container.Image, Config: container.Config, HostConfig: container.HostConfig, Mounts: container.Mounts, NetworkSettings: container.NetworkSettings });
    mutate(container);
    await assert.rejects(manager.qq.docker.inspect(row), { code: 'NAPCAT_IDENTITY_MISMATCH' });
    Object.assign(container, before);
  }
  await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
});

test('shutdown stops and confirms all managed containers; failure propagates', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } })).status, 200);
  runner.available = false;
  await assert.rejects(manager.hosting.shutdown(), AggregateError);
  assert.ok(manager.qq.docker.row(tenantId).container_id);
  runner.available = true;
  await manager.hosting.shutdown();
  assert.equal(runner.containers.size, 0);
  assert.equal(manager.qq.docker.row(tenantId).desired_state, 'stopped');
});

test('missing network after confirmed container removal is accepted, unreachable daemon is not', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } })).status, 200);
  const row = manager.qq.docker.row(tenantId);
  const original = runner.command.bind(runner);
  manager.qq.docker.command = async (args, timeout) => {
    if (args[0] === 'rm') { const result = await original(args, timeout); runner.networks.delete(row.network_id); return result; }
    return original(args, timeout);
  };
  await manager.qq.docker.stop(tenantId);
  assert.equal(manager.qq.docker.row(tenantId).state, 'stopped');
  assert.equal(manager.qq.docker.row(tenantId).network_id, null);
});

test('stopped old account is removed before changing profile', async (t) => {
  const { admin, tenantId, manager, runner } = await fixture(t);
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } })).status, 200);
  const row = manager.qq.docker.row(tenantId);
  const container = runner.containers.get(row.container_id);
  for (const server of container.servers) await new Promise(resolve => server.close(resolve));
  container.servers = []; container.State.Running = false;
  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, { method: 'POST', body: { uin: '54321' } });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(manager.qq.account(tenantId).expected_uin, '54321');
  assert.equal(runner.containers.size, 0);
});

test('configured container limits are applied and checked', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t, { napcatMemoryMb: 1024, napcatCpuMillis: 1500, napcatPids: 256, napcatShmMb: 128, napcatLogMb: 5, napcatLogFiles: 2 });
  assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } })).status, 200);
  const container = runner.containers.get(manager.qq.docker.row(tenantId).container_id);
  assert.equal(container.HostConfig.Memory, 1024 * 1048576);
  assert.equal(container.HostConfig.NanoCpus, 1500000000);
  assert.equal(container.HostConfig.PidsLimit, 256);
  await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
});

test('unattached networks require a stopped container and a verified owned bridge', async (t) => {
  const { admin, tenantId, runner, manager } = await fixture(t);
  const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST', body: { uin: '12345' } });
  assert.equal(started.status, 200, started.text);
  const row = manager.qq.docker.row(tenantId);
  const firstStart = runner.calls.findIndex(args => args[0] === 'start');
  assert.ok(runner.calls.slice(0, firstStart).some(args => args[0] === 'network' && args[1] === 'inspect'));
  await runner.command(['stop', row.container_id]);
  const container = runner.containers.get(row.container_id);
  const network = runner.networks.get(row.network_id);
  assert.equal(Object.values(container.NetworkSettings.Networks)[0].NetworkID, '');
  await manager.qq.docker.inspect(row);
  for (const mutate of [
    () => { network.Labels['fish.tenant'] = 'another-tenant'; },
    () => { network.Labels['fish.generation'] = '999'; },
    () => { network.Id = 'another-network'; },
    () => { network.Name = 'another-bridge'; },
    () => { network.Driver = 'host'; },
    () => { container.HostConfig.NetworkMode = 'another-network'; },
    () => { container.State.Running = true; },
    () => { container.State.Status = 'unknown'; },
    () => { container.NetworkSettings.Networks.other = { NetworkID: '' }; },
    () => { Object.values(container.NetworkSettings.Networks)[0].NetworkID = 'wrong-network'; }
  ]) {
    const originalNetwork = structuredClone(network);
    const originalState = structuredClone(container.State);
    const originalSettings = structuredClone(container.NetworkSettings);
    const originalMode = container.HostConfig.NetworkMode;
    mutate();
    await assert.rejects(manager.qq.docker.inspect(row), { code: 'NAPCAT_IDENTITY_MISMATCH' });
    Object.assign(network, originalNetwork);
    container.State = originalState;
    container.NetworkSettings = originalSettings;
    container.HostConfig.NetworkMode = originalMode;
  }
  await manager.qq.docker.stop(tenantId);
  assert.equal(runner.containers.size, 0);
  assert.equal(runner.networks.size, 0);
});

test('QR renewal replaces the code once, resumes the agent and rejects stale requests', async (t) => {
  const { manager, runner, admin, tenantId } = await fixture(t);
  const base = `/api/tenants/${tenantId}/qq`;
  assert.equal((await admin.call(base + '/start', { method: 'POST', body: { uin: '12345' } })).status, 200);
  const tenant = manager.tenants.row(tenantId);
  await manager.agent.start(tenant);
  let starts = 0;
  const start = manager.agent.start.bind(manager.agent);
  manager.agent.start = async (...args) => { starts++; return start(...args); };
  const old = (await admin.call(base + '/qrcode')).json.qrcode;
  const creates = runner.calls.filter(args => args[0] === 'create').length;
  runner.qrPendingReads = 4;
  const results = await Promise.all([0, 1].map(() => admin.call(base + '/qrcode/refresh', {
    method: 'POST', body: { runtimeGeneration: old.runtimeGeneration }
  })));
  for (const result of results) {
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.qrcode.runtimeGeneration, old.runtimeGeneration + 1);
    assert.notEqual(result.json.qrcode.qrcodeUrl, old.qrcodeUrl);
    assert.match(result.json.qrcode.imageDataUrl, /^data:image\/png;base64,/);
  }
  assert.equal(runner.calls.filter(args => args[0] === 'create').length, creates + 1);
  assert.equal(manager.supervisor.status(tenantId, 'agent').state, 'running');
  assert.equal(starts, 1);
  const stale = await admin.call(base + '/qrcode/refresh', { method: 'POST', body: { runtimeGeneration: old.runtimeGeneration } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'QRCODE_STALE');
  assert.equal((await admin.call(base + '/qrcode/refresh', { method: 'POST', body: { runtimeGeneration: 'bad' } })).status, 400);
  assert.equal(runner.calls.filter(args => args[0] === 'create').length, creates + 1);
  const drivers = (await admin.call('/api/qq/drivers')).json.drivers;
  assert.equal(drivers.find(driver => driver.id === 'napcat').capabilities.qrcodeRefresh, true);
});

test('QR renewal preserves online and confirming sessions and enforces operator access', async (t) => {
  const { manager, runner, admin, tenantId, config } = await fixture(t);
  const base = `/api/tenants/${tenantId}/qq`;
  await admin.call(base + '/start', { method: 'POST', body: { uin: '12345' } });
  const generation = manager.qq.docker.row(tenantId).generation;
  const callsBefore = runner.calls.filter(args => ['stop', 'create', 'rm'].includes(args[0])).length;
  runner.online = true;
  const online = await admin.call(base + '/qrcode/refresh', { method: 'POST', body: { runtimeGeneration: generation } });
  assert.equal(online.status, 200, online.text);
  assert.equal(online.json.qrcode.state, 'success');
  runner.online = false;
  for (const phase of ['qrcode_scanned', 'initializing']) {
    runner.loginPhase = phase;
    const confirming = await admin.call(base + '/qrcode/refresh', { method: 'POST' });
    assert.equal(confirming.status, 409);
    assert.equal(confirming.json.code, 'QQ_LOGIN_IN_PROGRESS');
  }
  const user = (await admin.call('/api/admin/users', { method: 'POST', body: { username: 'qr-viewer', password: 'qr-viewer-password-123', role: 'user' } })).json.user;
  manager.db.prepare('INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)').run(user.id, tenantId, 'viewer', Date.now());
  const viewer = new Client(`http://127.0.0.1:${config.panelPort}`);
  await viewer.login('qr-viewer', 'qr-viewer-password-123');
  assert.equal((await viewer.call(base + '/qrcode/refresh', { method: 'POST' })).status, 403);
  assert.equal((await admin.call(base + '/qrcode/refresh', { method: 'POST', csrf: false })).status, 403);
  assert.equal(runner.calls.filter(args => ['stop', 'create', 'rm'].includes(args[0])).length, callsBefore);
});

async function generationFixture(t) {
  const env = await fixture(t);
  const { manager, tenantId, runner } = env;
  const tenant = manager.tenants.row(tenantId);
  await manager.qq.prepareAndStart(tenant, { driver: 'napcat', uin: '12345' });
  const operation = await manager.qq.startSwitch(tenant, { driver: 'napcat', expectedRevision: manager.qq.account(tenantId).revision, idempotencyKey: 'refresh-generation' });
  assert.equal(operation.phase, 'waiting_qr');
  return { ...env, tenant, operation, async commit() {
    runner.online = true;
    assert.equal((await manager.qq.getOperation(tenant, operation.operationId)).status, 'succeeded');
    runner.online = false;
  } };
}

test('QR refresh cannot mutate an active switch or its target resources', async (t) => {
  const { manager, tenantId, runner, tenant, operation } = await generationFixture(t);
  for (const status of ['running', 'needs_attention']) {
    manager.db.prepare('UPDATE qq_operations SET status=? WHERE id=?').run(status, operation.operationId);
    const snapshot = () => ['qq_accounts', 'qq_runtimes', 'qq_profiles', 'qq_operations', 'qq_account_claims', 'port_leases'].map(table => manager.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    const calls = runner.calls.length;
    await assert.rejects(manager.qq.refreshQrcode(tenant, { runtimeGeneration: operation.runtimeGeneration }), { code: 'QQ_SWITCH_ACTIVE' });
    assert.deepEqual(snapshot(), before);
    assert.equal(runner.calls.length, calls);
    assert.equal(manager.qq.hasActiveSwitch(tenantId), true);
  }
});

test('P2 QR refresh rotates generation credentials and claim while retaining profile and serializing QR reads', { timeout: 15000 }, async (t) => {
  const env = await generationFixture(t);
  await env.commit();
  const { manager, tenantId, tenant, runner } = env;
  const before = manager.qq.account(tenantId);
  const tokens = manager.qq.tokens(tenant, before);
  const original = await manager.qq.qrcode(tenant);
  const creates = runner.calls.filter(args => args[0] === 'create').length;
  runner.qrPendingReads = 3;
  const refresh = manager.qq.refreshQrcode(tenant, { runtimeGeneration: before.runtime_generation });
  const read = manager.qq.qrcode(tenant);
  const duplicate = manager.qq.refreshQrcode(tenant, { runtimeGeneration: before.runtime_generation });
  await assert.rejects(manager.qq.refreshQrcode(tenant, { runtimeGeneration: before.runtime_generation + 1 }), { code: 'QRCODE_STALE' });
  const [renewed, observed, merged] = await Promise.all([refresh, read, duplicate]);
  const after = manager.qq.account(tenantId);
  assert.deepEqual(renewed, merged);
  assert.equal(observed.runtimeGeneration, renewed.runtimeGeneration);
  assert.equal(renewed.runtimeGeneration, before.runtime_generation + 1);
  assert.notEqual(renewed.qrcodeUrl, original.qrcodeUrl);
  assert.equal(after.effective_profile_id, before.effective_profile_id);
  assert.notEqual(after.effective_runtime_id, before.effective_runtime_id);
  assert.equal(after.runtime_secret_namespace, `qq.napcat.runtime.${after.runtime_generation}`);
  assert.notEqual(manager.qq.tokens(tenant, after).onebotToken, tokens.onebotToken);
  assert.notEqual(manager.qq.tokens(tenant, after).webuiPassword, tokens.webuiPassword);
  assert.equal(manager.db.prepare('SELECT runtime_id FROM qq_account_claims WHERE tenant_id=?').get(tenantId).runtime_id, after.effective_runtime_id);
  assert.equal(manager.qq.switches.releaseClaim(tenant, before), 0);
  assert.ok(manager.db.prepare("SELECT purpose FROM port_leases WHERE tenant_id=? AND released_at IS NULL AND purpose LIKE 'qq.%'").all(tenantId).every(row => row.purpose.startsWith(`qq.g${after.runtime_generation}.`)));
  assert.equal(runner.calls.filter(args => args[0] === 'create').length, creates + 1);
  assert.equal(manager.supervisor.status(tenantId, 'agent').state, 'stopped');
});

for (const failure of ['stop', 'start', 'qrcode', 'resume', 'inactive']) test(`P2 QR refresh ${failure} failure never falsely resumes the agent`, async (t) => {
  const env = await generationFixture(t);
  await env.commit();
  const { manager, tenantId, tenant, runner } = env;
  await manager.agent.start(tenant);
  const before = manager.qq.account(tenantId);
  const claim = manager.db.prepare('SELECT * FROM qq_account_claims WHERE tenant_id=?').get(tenantId);
  const leases = manager.db.prepare('SELECT * FROM port_leases WHERE tenant_id=?').all(tenantId);
  let resumes = 0;
  manager.agent.start = async () => { resumes++; throw Object.assign(new Error('resume failed'), { code: 'AGENT_START_FAILED' }); };
  const command = runner.command.bind(runner);
  manager.qq.docker.command = async (args) => {
    if (failure === 'stop' && ['stop', 'kill'].includes(args[0])) throw Object.assign(new Error('stop failed'), { code: 'STOP_FAILED' });
    if (failure === 'start' && args[0] === 'start') throw Object.assign(new Error('start failed'), { code: 'START_FAILED' });
    const result = await command(args);
    if (failure === 'qrcode' && args[0] === 'start') runner.qrPendingReads = 100;
    if (failure === 'inactive' && args[0] === 'rm') manager.db.prepare("UPDATE tenants SET status='expired' WHERE id=?").run(tenantId);
    return result;
  };
  if (failure === 'qrcode') manager.config.processStartTimeoutMs = 100;
  const codes = { stop: 'STOP_FAILED', start: 'START_FAILED', qrcode: 'QRCODE_GENERATION_TIMEOUT', resume: 'AGENT_START_FAILED', inactive: 'TENANT_INACTIVE' };
  await assert.rejects(manager.qq.refreshQrcode(tenant, { runtimeGeneration: before.runtime_generation }), { code: codes[failure] });
  assert.equal(resumes, failure === 'resume' ? 1 : 0);
  assert.equal(manager.supervisor.status(tenantId, 'agent').state, 'stopped');
  assert.equal(manager.qq.qrRefreshRequests.size, 0);
  if (failure === 'stop') {
    assert.deepEqual(manager.db.prepare('SELECT * FROM qq_account_claims WHERE tenant_id=?').get(tenantId), claim);
    assert.deepEqual(manager.db.prepare('SELECT * FROM port_leases WHERE tenant_id=?').all(tenantId).filter(row => row.purpose.startsWith('qq.')), leases.filter(row => row.purpose.startsWith('qq.')));
    assert.equal(runner.containers.size, 1);
  } else if (['start', 'inactive'].includes(failure)) {
    assert.equal(manager.db.prepare('SELECT * FROM qq_account_claims WHERE tenant_id=?').get(tenantId), undefined);
    assert.equal(runner.containers.size, 0);
    assert.equal(runner.networks.size, 0);
  } else {
    const after = manager.qq.account(tenantId);
    assert.equal(manager.db.prepare('SELECT runtime_id FROM qq_account_claims WHERE tenant_id=?').get(tenantId).runtime_id, after.effective_runtime_id);
    assert.equal(runner.containers.size, 1);
  }
  manager.qq.docker.command = command;
});

for (const phase of ['qrcode_scanned', 'initializing']) test(`QR refresh preserves ${phase} observed after the first status probe`, async (t) => {
  const { manager, tenantId, runner } = await fixture(t);
  const tenant = manager.tenants.row(tenantId);
  await manager.qq.prepareAndStart(tenant, { driver: 'napcat', uin: '12345' });
  const driver = manager.qq.driver('napcat');
  manager.qq.driver = () => ({ ...driver, async status(ctx) {
    const status = await driver.status(ctx);
    runner.loginPhase = phase;
    runner.qrPendingReads = 100;
    return status;
  } });
  const before = manager.qq.docker.row(tenantId);
  const calls = runner.calls.filter(args => ['stop', 'create', 'rm'].includes(args[0])).length;
  await assert.rejects(manager.qq.refreshQrcode(tenant, { runtimeGeneration: before.generation }), { code: 'QQ_LOGIN_IN_PROGRESS' });
  assert.deepEqual(manager.qq.docker.row(tenantId), before);
  assert.equal(runner.calls.filter(args => ['stop', 'create', 'rm'].includes(args[0])).length, calls);
});

test('QR refresh checks current tenant again before restoring a previously running agent', async (t) => {
  const { manager, tenantId, runner } = await fixture(t);
  const tenant = manager.tenants.row(tenantId);
  await manager.qq.prepareAndStart(tenant, { driver: 'napcat', uin: '12345' });
  await manager.agent.start(tenant);
  let resumes = 0;
  manager.agent.start = async () => { resumes++; };
  const command = runner.command.bind(runner);
  manager.qq.docker.command = async args => {
    const result = await command(args);
    if (args[0] === 'start') manager.db.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(tenantId);
    return result;
  };
  await assert.rejects(manager.qq.refreshQrcode(tenant), { code: 'TENANT_INACTIVE' });
  assert.equal(resumes, 0);
  assert.equal(manager.supervisor.status(tenantId, 'agent').state, 'stopped');
});
