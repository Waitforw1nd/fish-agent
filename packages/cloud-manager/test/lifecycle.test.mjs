import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  Client, fixture, loginAdmin, startManager, tenantHost, waitFor
} from './helpers.mjs';

test('backup encryption, restore port rewrite and rollback-safe state', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Backup Demo', slug: 'backup-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  const started = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const tenant = manager.tenants.row(tenantId);
  const marker = path.join(tenant.data_dir, 'data', 'marker.txt');
  fs.writeFileSync(marker, 'before-backup');
  fs.mkdirSync(path.join(tenant.data_dir, 'data', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tenant.data_dir, 'data', 'logs', 'ignored.log'), 'should not be backed up');

  const backupResponse = await admin.call(`/api/tenants/${tenantId}/backup`, { method: 'POST' });
  assert.equal(backupResponse.status, 201, backupResponse.text);
  const backup = backupResponse.json.backup;
  assert.ok(backup.id);
  assert.ok(backup.sizeBytes > 0);
  assert.ok(backup.fileCount >= 1);

  const archive = manager.backup.readArchive(tenantId, backup.id);
  assert.equal(archive.files.some((file) => file.path === 'data/logs/ignored.log'), false);
  assert.equal(archive.files.some((file) => file.path === 'data/marker.txt'), true);
  assert.equal(archive.header.state.tenant.id, tenantId);

  fs.writeFileSync(marker, 'after-backup');
  const oldAgentPort = manager.agent.port(tenant);
  const restore = await admin.call(`/api/tenants/${tenantId}/restore`, {
    method: 'POST', body: { backupId: backup.id, restart: true }
  });
  assert.equal(restore.status, 200, restore.text);
  assert.equal(restore.json.restarted, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'before-backup');
  const restoredTenant = manager.tenants.row(tenantId);
  const newAgentPort = manager.agent.port(restoredTenant);
  assert.ok(newAgentPort > 0);
  assert.notEqual(newAgentPort, null);
  const agentConfig = JSON.parse(fs.readFileSync(path.join(restoredTenant.data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(agentConfig.server.port, newAgentPort);
  assert.ok(agentConfig.api.apiKey.startsWith('sk-fish-'));
  const health = await manager.agent.health(restoredTenant);
  assert.equal(health.ok, true);
  const list = await admin.call(`/api/tenants/${tenantId}/backups`);
  assert.equal(list.json.backups.length, 1);

  const backupFile = manager.db.prepare('SELECT file_path FROM backups WHERE id = ?').get(backup.id).file_path;
  fs.appendFileSync(backupFile, 'tamper');
  assert.throws(() => manager.backup.readArchive(tenantId, backup.id), /哈希校验失败|hash/i);
});

test('restore failure rolls back files and runtime state', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Rollback Demo', slug: 'rollback-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  assert.equal((await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' })).status, 200);
  const tenant = manager.tenants.row(tenantId);
  const marker = path.join(tenant.data_dir, 'data', 'rollback-marker.txt');
  fs.writeFileSync(marker, 'before');
  const backup = (await admin.call(`/api/tenants/${tenantId}/backup`, { method: 'POST' })).json.backup;
  fs.writeFileSync(marker, 'after');
  const oldAgentPort = manager.agent.port(tenant);
  const goodEntry = manager.config.agentEntry;
  manager.config.agentEntry = path.join(tenant.data_dir, 'missing-agent-entry.mjs');
  const failed = await admin.call(`/api/tenants/${tenantId}/restore`, {
    method: 'POST', body: { backupId: backup.id, restart: true }
  });
  assert.ok(failed.status >= 500, failed.text);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'after');
  assert.equal(manager.agent.supervisor.status(tenantId, 'agent').state, 'stopped');
  manager.config.agentEntry = goodEntry;
  const restarted = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(restarted.status, 200, restarted.text);
  assert.equal(restarted.json.runtime.agent.state, 'running');
  const config = JSON.parse(fs.readFileSync(path.join(tenant.data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(config.server.port, manager.agent.port(manager.tenants.row(tenantId)));
  assert.equal(oldAgentPort > 0, true);
});

test('expiry fuse closes tenant, blocks gateway and relay, renew restores', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Expiry Demo', slug: 'expiry-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  const started = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const key = manager.relayKeys.plaintext(tenantId);
  manager.db.prepare('UPDATE tenants SET expires_at = ?, status = ? WHERE id = ?')
    .run(Date.now() - 1000, 'active', tenantId);

  const detail = await admin.call(`/api/tenants/${tenantId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.tenant.status, 'expired');
  await waitFor(() => manager.agent.supervisor.status(tenantId, 'agent').state === 'stopped', { label: 'expired agent stopped' });

  const startAgain = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(startAgain.status, 402);
  assert.equal(startAgain.json.code, 'TENANT_EXPIRED');

  const host = tenantHost(config, 'expiry-demo');
  const tenantClient = new Client(`http://127.0.0.1:${config.panelPort}`, { host, cookie: admin.cookie, csrf: admin.csrf });
  const gatewayResponse = await tenantClient.call('/api/status');
  assert.equal(gatewayResponse.status, 402);

  const relayResponse = await fetch(`http://127.0.0.1:${manager.config.relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], max_tokens: 4 })
  });
  assert.equal(relayResponse.status, 402);

  const renewed = await admin.call(`/api/tenants/${tenantId}/renew`, { method: 'POST', body: { days: 7 } });
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.json.tenant.subscriptionStatus, 'active');
  assert.equal(renewed.json.tenant.status, 'stopped');
  const restarted = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(restarted.status, 200, restarted.text);
  assert.equal(restarted.json.runtime.agent.state, 'running');

  const suspended = await admin.call(`/api/tenants/${tenantId}/suspend`, { method: 'POST' });
  assert.equal(suspended.status, 200, suspended.text);
  const blockedGateway = await tenantClient.call('/api/status');
  assert.equal(blockedGateway.status, 403);
});

test('stopping one tenant does not disturb another tenant process', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const first = await admin.createTenant({ name: 'Iso One', slug: 'iso-one', planId: 'starter' });
  const second = await admin.createTenant({ name: 'Iso Two', slug: 'iso-two', planId: 'starter' });
  const firstId = first.json.tenant.id;
  const secondId = second.json.tenant.id;
  assert.equal((await admin.call(`/api/tenants/${firstId}/start`, { method: 'POST' })).status, 200);
  assert.equal((await admin.call(`/api/tenants/${secondId}/start`, { method: 'POST' })).status, 200);
  const firstPort = manager.agent.port(manager.tenants.row(firstId));
  const secondPort = manager.agent.port(manager.tenants.row(secondId));
  assert.notEqual(firstPort, secondPort);
  const stopped = await admin.call(`/api/tenants/${firstId}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(manager.agent.supervisor.status(firstId, 'agent').state, 'stopped');
  assert.equal(manager.agent.supervisor.status(secondId, 'agent').state, 'running');
  assert.equal((await manager.agent.health(manager.tenants.row(secondId))).ok, true);
  const host = tenantHost(config, 'iso-two');
  const client = new Client(`http://127.0.0.1:${config.panelPort}`, { host, cookie: admin.cookie, csrf: admin.csrf });
  assert.equal((await client.call('/api/status')).status, 200);
});

test('transactional port leases are unique under concurrency', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Ports Demo', slug: 'ports-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  const purposes = Array.from({ length: 24 }, (_, index) => `test.port.${index}`);
  const leases = await Promise.all(purposes.map((purpose) => manager.allocator.allocate(tenantId, purpose, { host: '127.0.0.1' })));
  const ports = leases.map((lease) => lease.port);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(manager.allocator.find(tenantId, 'test.port.0').port, ports[0]);
  const same = await Promise.all(purposes.map((purpose) => manager.allocator.allocate(tenantId, purpose, { host: '127.0.0.1' })));
  assert.deepEqual(same.map((lease) => lease.port), ports);
  manager.allocator.releaseAll(tenantId);
  assert.equal(manager.allocator.activeSet().size, 0);
});

test('supervisor backs off and stops restarting after repeated crashes', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Crash Demo', slug: 'crash-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  const tenant = manager.tenants.row(tenantId);
  await manager.supervisor.start({
    tenantId,
    kind: 'crash-test',
    command: process.execPath,
    args: [fixture('fake-crash.mjs')],
    cwd: tenant.data_dir,
    restart: true,
    maxRestarts: 1
  });
  await waitFor(() => manager.supervisor.status(tenantId, 'crash-test').state === 'crashed', { label: 'crash backoff exhausted', timeoutMs: 10000 });
  const status = manager.supervisor.status(tenantId, 'crash-test');
  assert.equal(status.state, 'crashed');
  assert.ok(status.restarts >= 1);
  const rows = manager.db.prepare('SELECT * FROM process_runs WHERE tenant_id = ? AND kind = ?').all(tenantId, 'crash-test');
  assert.ok(rows.length >= 1);
  await manager.supervisor.stop(tenantId, 'crash-test', { force: true });
});
