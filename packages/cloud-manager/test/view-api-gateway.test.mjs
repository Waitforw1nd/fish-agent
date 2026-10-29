import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Gateway } from '../src/gateway.js';
import { AgentSettingsService } from '../src/agent-settings.js';
import { REPO_ROOT } from '../src/config.js';
import { Client, loginAdmin, startManager, tenantHost } from './helpers.mjs';

function send(port, pathname, { method = 'GET', role = 'operator', body } = {}) {
  const raw = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname,
      headers: { host: 'a.example.test', origin: 'http://a.example.test', authorization: role,
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) }
    }, (res) => {
      const chunks = []; res.on('data', (data) => chunks.push(data));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: JSON.parse(text), headers: res.headers }); });
    });
    req.on('error', reject); req.end(raw || undefined);
  });
}

test('legacy gateway applies the same skill authorization and secret filtering', async (t) => {
  const item = { id: 'demo', configSchema: { rate: { type: 'number', min: 0, max: 5 }, privateValue: { type: 'string', secret: true } }, settings: { rate: 2 } };
  const unsafeConfig = { skills: { demo: { rate: 2, privateValue: 'sensitive-value' }, orphan: { unknownSecret: 'orphan-secret' } } };
  const unsafeSkill = { id: 'demo', loadError: 'thrown-secret', lastError: 'thrown-secret', reason: 'thrown-secret',
    settings: { rate: 2, privateValue: 'sensitive-value' }, configSchema: { privateValue: { type: 'string', secret: true, default: 'secret-default' } } };
  const extensions = {
    withLock: async (_key, fn) => fn(),
    list: async () => ({ items: [item] }),
    find: async (_tenant, id) => {
      if (id === 'blocked') throw Object.assign(new Error('blocked'), { status: 403, code: 'EXTENSION_BLOCKED_BY_ADMIN' });
      if (id !== 'demo') throw Object.assign(new Error('missing'), { status: 404, code: 'EXTENSION_NOT_FOUND' });
      return item;
    }
  };
  const agent = {
    port: () => 12345, isRunning: () => true,
    supervisor: { status: () => ({ state: 'running' }) },
    request: async (_tenant, method, route, body) => {
      if (route === '/api/config' && method === 'GET') return structuredClone(unsafeConfig);
      if (route === '/api/config' && method === 'POST') {
        assert.equal(body.server, undefined); assert.equal(body.skills, undefined);
        return { ok: true, config: structuredClone(unsafeConfig) };
      }
      if (route === '/api/skills' && method === 'GET') return { skills: [unsafeSkill], uninstalled: [] };
      if (route === '/api/tools/availability') return { categories: { system: {} }, tools: [
        { id: 'allowed-tool', category: 'system', skillId: 'demo', enabled: false, code: 'skill-unavailable', reason: 'availability-secret' },
        { id: 'blocked-tool', category: 'system', skillId: 'blocked', enabled: false, code: 'skill-unavailable', reason: 'blocked-secret' },
        { id: 'builtin-tool', category: 'system', skillId: null, enabled: false, code: 'capability-missing', reason: 'capability-secret' }
      ] };
      if (route === '/api/tools') return { tools: [] };
      if (route === '/api/skills/capabilities') return { capabilities: [
        { name: 'demo-capability', available: true, reason: 'capability-secret', providers: [
          { skillId: 'demo', active: false, code: 'skill-unavailable', reason: 'availability-secret', implemented: true, usable: false, detail: 'detail-secret' },
          { skillId: 'blocked', active: true, code: null, reason: 'blocked-secret', implemented: true, usable: true }
        ] },
        { name: 'blocked-capability', available: true, reason: '', providers: [
          { skillId: 'blocked', active: true, code: null, reason: '', implemented: true, usable: true }
        ] }
      ] };
      if (route === '/api/skills/reload') return { ok: true, skills: [unsafeSkill], loaded: ['demo'],
        failed: [{ id: 'demo', error: 'thrown-secret' }], extra: 'thrown-secret' };
      if (route === '/api/skills/cleanup') return { ok: true, config: structuredClone(unsafeConfig) };
      if (route === '/api/skills/demo' && method === 'POST') return { ok: true, skill: unsafeSkill, settings: unsafeSkill.settings, config: structuredClone(unsafeConfig) };
      throw new Error(`unexpected request ${method} ${route}`);
    }
  };
  const settings = new AgentSettingsService({ agent, supervisor: agent.supervisor, extensionService: extensions });
  const gateway = new Gateway({ config: { baseDomain: 'example.test', publicScheme: 'http', cookieSecure: false, apiMaxBodyBytes: 4096 },
    tenants: { bySlug: () => ({ id: 'a' }), roleFor: (user) => user.role, assertActive() {} },
    auth: { resolve: (req) => ({ user: { id: 'u', role: req.headers.authorization } }) }, agentRuntime: agent });
  gateway.agentSettings = settings;
  const server = http.createServer(async (req, res) => { await gateway.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  for (const route of ['/api/config', '/api/skills']) {
    const result = await send(port, route);
    assert.equal(result.status, 200, result.text);
    assert.doesNotMatch(result.text, /sensitive-value|secret-default|orphan-secret|thrown-secret/);
  }
  const availability = await send(port, '/api/tools/availability');
  assert.equal(availability.status, 200, availability.text);
  assert.doesNotMatch(availability.text, /availability-secret|blocked-secret|capability-secret/);
  assert.deepEqual(availability.json.tools.map((tool) => tool.id), ['allowed-tool', 'builtin-tool']);
  const capabilities = await send(port, '/api/skills/capabilities');
  assert.equal(capabilities.status, 200, capabilities.text);
  assert.doesNotMatch(capabilities.text, /availability-secret|blocked-secret|capability-secret|detail-secret/);
  assert.equal(capabilities.json.capabilities.length, 1);
  assert.equal(capabilities.json.capabilities[0].name, 'demo-capability');
  assert.equal(capabilities.json.capabilities[0].available, false);
  assert.deepEqual(capabilities.json.capabilities[0].providers.map((item) => item.skillId), ['demo']);
  const config = await send(port, '/api/config', { method: 'POST', body: { server: { token: 'attack' }, skills: { demo: { privateValue: 'attack' } } } });
  assert.equal(config.status, 200, config.text); assert.ok(config.headers['x-cloud-guard']);
  assert.doesNotMatch(config.text, /sensitive-value|orphan-secret/);
  assert.equal((await send(port, '/api/skills/demo', { method: 'POST', body: { settings: { privateValue: 'attack' } } })).status, 403);
  assert.equal((await send(port, '/api/skills/demo', { method: 'POST', body: { settings: { rate: 999 } } })).status, 400);
  assert.equal((await send(port, '/api/skills/blocked', { method: 'POST', body: { enabled: true } })).status, 403);
  assert.equal((await send(port, '/api/skills/demo', { method: 'POST', role: 'viewer', body: { enabled: true } })).status, 403);
  for (const [route, body] of [['/api/skills/demo', { settings: { rate: 3 } }], ['/api/skills/reload', {}], ['/api/skills/cleanup', { ids: ['orphan'] }]]) {
    const result = await send(port, route, { method: 'POST', body });
    assert.equal(result.status, 200, result.text);
    assert.doesNotMatch(result.text, /sensitive-value|secret-default|orphan-secret|thrown-secret/);
  }
});

test('gateway reload never returns an actual plugin exception containing a secret', async (t) => {
  const entry = path.join(REPO_ROOT, 'packages', 'qq-agent-core', 'modules', 'headless', 'server.js');
  const env = await startManager({ agentEntry: entry });
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Gateway', slug: 'gateway-error', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenant = manager.tenants.row(created.json.tenant.id);
  const plugin = path.join(tenant.data_dir, 'admin-extensions', 'plugins', 'error-demo');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ id: 'error-demo', name: 'Error Demo', version: '1.0.0', apiVersion: 1 }));
  fs.writeFileSync(path.join(plugin, 'index.js'), 'export function setup() { throw new Error(\"actual-plugin-secret\"); }');
  await manager.agent.start(tenant);
  const direct = await manager.agent.request(tenant, 'POST', '/api/skills/reload', {});
  assert.ok(direct.failed.some((item) => String(item.error).includes('actual-plugin-secret')), JSON.stringify(direct.failed));
  const host = tenantHost(config, tenant.slug);
  const client = new Client(`http://127.0.0.1:${config.panelPort}`, { host, cookie: admin.cookie });
  for (const [pathname, method] of [['/api/skills', 'GET'], ['/api/skills/reload', 'POST']]) {
    const result = await client.call(pathname, { method, headers: { origin: `http://${host}` } });
    assert.equal(result.status, 200, result.text);
    assert.doesNotMatch(result.text, /actual-plugin-secret/);
    if (method === 'POST') {
      assert.ok(result.json.failed.some((item) => item.id === 'error-demo'));
      assert.match(result.json.failed.find((item) => item.id === 'error-demo').error, /扩展加载失败/);
    }
  }
});
