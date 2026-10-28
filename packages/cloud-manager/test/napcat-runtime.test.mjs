import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { loginAdmin, startManager } from './helpers.mjs';
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
  assert.equal(refresh.json.code, 'QRCODE_REFRESH_UNSUPPORTED');
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
