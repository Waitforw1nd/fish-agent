import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, REPO_ROOT } from '../src/config.js';
import { Client, loginAdmin, makeConfig, request, startManager, tenantHost } from './helpers.mjs';

const entry = path.join(REPO_ROOT, 'packages', 'qq-agent-core', 'modules', 'headless', 'server.js');

test('default agent entry points to Linux headless', async () => {
  const { dataDir, releasePorts } = await makeConfig();
  try {
    const config = loadConfig({ CLOUD_DATA_DIR: dataDir });
    assert.equal(config.agentEntry, entry);
    assert.equal(loadConfig({ CLOUD_DATA_DIR: dataDir, CLOUD_AGENT_ENTRY: 'custom-agent.js' }).agentEntry, path.resolve('custom-agent.js'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    await releasePorts();
  }
});

test('tenant starts real headless and gateway authenticates', async (t) => {
  assert.ok(fs.existsSync(entry), `headless entry missing: ${entry}`);
  const env = await startManager({ agentEntry: entry });
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Headless', slug: 'headless', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  const started = await admin.startTenant(tenantId);
  assert.equal(started.status, 200, `${started.text}\n${manager.supervisor.logs(tenantId, 'agent').join('\n')}`);
  assert.equal(started.json.runtime.agent.state, 'running');
  const tenant = manager.tenants.row(tenantId);
  const service = manager.supervisor.get(tenantId, 'agent');
  assert.equal(service.env.QQ_AGENT_CLOUD, '1');
  assert.equal(service.env.QQ_AGENT_READY_IPC, '1');
  assert.equal(service.env.QQ_AGENT_DATA_DIR, path.join(tenant.data_dir, 'data'));
  for (const key of ['QQ_AGENT_PLUGINS_DIR', 'QQ_AGENT_SKILLS_DIR']) {
    assert.ok(service.env[key].startsWith(tenant.data_dir));
    assert.equal(fs.statSync(service.env[key]).isDirectory(), true);
  }
  const port = manager.agent.port(tenant);
  assert.equal((await manager.agent.health(tenant)).ok, true);
  const direct = await request(`http://127.0.0.1:${port}`, { path: '/api/status' });
  assert.equal(direct.status, 401);
  const host = tenantHost(config, 'headless');
  const client = new Client(`http://127.0.0.1:${config.panelPort}`, { host, cookie: admin.cookie });
  const proxied = await client.call('/api/status', { headers: { origin: `http://${host}`, 'x-console-token': 'incorrect' } });
  assert.equal(proxied.status, 200, proxied.text);
  assert.equal(proxied.json.runtime.name, 'headless');
  const rejected = await client.call('/api/status', { headers: { origin: 'http://untrusted.example' } });
  assert.equal(rejected.status, 403);
});


test('written NapCat generation and actual login identity reach health; changed config invalidates cache', async t => {
  const http = await import('node:http');
  const { WebSocketServer } = await import('../../qq-agent-core/node_modules/ws/wrapper.mjs');
  const protocol = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? { user_id: 888, nickname: 'actual' } : {} }));
  });
  const port = await new Promise(resolve => protocol.listen(0, '127.0.0.1', () => resolve(protocol.address().port)));
  const ws = new WebSocketServer({ server: protocol });
  t.after(() => { for (const client of ws.clients) client.terminate(); ws.close(); protocol.closeAllConnections(); protocol.close(); });
  const env = await startManager({ agentEntry: entry });
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Health', slug: 'healthcheck', planId: 'starter' });
  const tenant = manager.tenants.row(created.json.tenant.id);
  let generation = 10;
  manager.agent.setLinksResolver(async () => ({ qq: { enabled: true, driver: 'napcat', generation, media: { mode: 'inline-base64', maxImageBytes: 5242880, incomingLocalPaths: 'deny' }, apiTransport: 'http', uin: '999', wsUrl: `ws://127.0.0.1:${port}`, httpUrl: `http://127.0.0.1:${port}` }, bili: null }));
  await manager.agent.start(tenant);
  let health;
  for (let i = 0; i < 100; i++) {
    manager.agent.healthCache.delete(tenant.id);
    health = await manager.agent.health(tenant);
    if (health.channels?.qq?.selfId === '888') break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(health.channels.qq.selfId, '888');
  assert.equal(health.channels.qq.generation, 10);
  assert.equal(health.channels.qq.connected, true);
  generation = 11;
  await manager.agent.writeConfig(tenant);
  assert.equal(manager.agent.healthCache.has(tenant.id), false);
  await manager.agent.restart(tenant);
  for (let i = 0; i < 100; i++) {
    manager.agent.healthCache.delete(tenant.id);
    health = await manager.agent.health(tenant);
    if (health.channels?.qq?.selfId === '888' && health.channels.qq.generation === 11) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(health.channels.qq.selfId, '888');
  assert.equal(health.channels.qq.generation, 11);
});
