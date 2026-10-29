import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(process.cwd());
const temp = fs.mkdtempSync(path.join(workspace, '.config-extension-test-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'a', 'data');
process.env.QQ_AGENT_CLOUD = '1';
process.env.QQ_AGENT_PLUGINS_DIR = path.join(temp, 'a', 'tenant', 'plugins');
process.env.QQ_AGENT_SKILLS_DIR = path.join(temp, 'a', 'tenant', 'skills');
process.env.QQ_AGENT_ADMIN_PLUGINS_DIR = path.join(temp, 'a', 'admin', 'plugins');
process.env.QQ_AGENT_ADMIN_SKILLS_DIR = path.join(temp, 'a', 'admin', 'skills');
process.env.QQ_AGENT_EXTENSIONS_ALLOW = 'trpg-dice-hook,tenant-unsafe';
delete process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED;
fs.mkdirSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true });

const codec = await import('../src/config-codec.js');
const config = await import('../src/config.js');
const loader = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const { getTool } = await import('../src/tool-registry.js');

function writeExtension(root, id, version, code) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version, apiVersion: 1 }));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}

test('pure codec preserves array secrets and agrees with online update', () => {
  const current = codec.normalizeStoredAgentConfig({
    api: { apiKey: 'api-private' },
    channels: { qq: { authToken: 'qq-private' } },
    skills: { sample: { accounts: [{ id: 'x', key: 'account-private' }] } },
    webSearch: { providers: [{ id: 'x', apiKey: 'search-private' }] },
    store: { contextTier: 2 }
  });
  const before = structuredClone(current);
  const visible = codec.sanitizeConfig(current);
  assert.doesNotMatch(JSON.stringify(visible), /api-private|qq-private|account-private|search-private/);
  const provider = codec.sanitizeProvider({ api: 'openai', id: 'manual', apiKey: 'provider-private' });
  assert.equal(provider.api, 'openai');
  assert.equal(provider.apiKey, '');
  assert.equal(provider.hasKey, true);
  assert.doesNotMatch(JSON.stringify(provider), /provider-private/);
  const patch = { webSearch: { providers: [{ id: 'x', name: 'changed' }] }, store: { contextTier: 3, randomPercent: 50 } };
  const patchBefore = structuredClone(patch);
  const offline = codec.mergeAgentConfigPatch(current, patch);
  assert.deepEqual(current, before);
  assert.deepEqual(patch, patchBefore);
  assert.equal(offline.webSearch.providers[0].apiKey, 'search-private');
  assert.equal(offline.store.contextTier, 3);
  assert.equal(offline.store.randomPercent, 50);
  config.setRuntimeConfig(current);
  assert.deepEqual(config.updateConfig(patch), offline);
  assert.equal(codec.mergeAgentConfigPatch(offline, { webSearch: { providers: [{ id: 'x', apiKey: '' }] } }).webSearch.providers[0].apiKey, '');
});

test('trusted override, blocking, lifecycle cleanup and tenant isolation', async () => {
  const log = () => {};
  let result = await loader.loadPlugins({ log });
  assert.ok(result.loaded.some((entry) => entry.id === 'trpg-dice-hook'));
  const tenantRoot = process.env.QQ_AGENT_PLUGINS_DIR;
  writeExtension(tenantRoot, 'tenant-unsafe', '1.0.0', 'globalThis.__tenantExecuted = true; export function setup() {}');
  const adminRoot = process.env.QQ_AGENT_ADMIN_PLUGINS_DIR;
  writeExtension(adminRoot, 'trpg-dice-hook', '9.0.0', `
    export function setup(api) { api.registerTool({ id: 'custom', name: 'custom', execute: () => ({}) }); }
    export function deactivate() { globalThis.__adminDeactivated = true; }
    export function dispose() { globalThis.__adminDisposed = true; }
  `);
  result = await loader.loadPlugins({ log });
  assert.equal(skillManager.registry.get('trpg-dice-hook').manifest.version, '9.0.0');
  assert.equal(globalThis.__tenantExecuted, undefined);
  assert.ok(getTool('trpg-dice-hook__custom'));
  const adminDir = path.join(adminRoot, 'trpg-dice-hook');
  assert.ok(path.relative(temp, adminDir) && !path.relative(temp, adminDir).startsWith('..'));
  fs.rmSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'blocked-extensions.json'), JSON.stringify(['trpg-dice-hook']));
  result = await loader.loadPlugins({ log });
  assert.ok(result.pruned.includes('trpg-dice-hook'));
  assert.equal(getTool('trpg-dice-hook__custom'), null);
  assert.equal(globalThis.__adminDeactivated, true);
  assert.equal(globalThis.__adminDisposed, true);
  const tenantB = path.join(temp, 'b', 'data');
  fs.mkdirSync(tenantB, { recursive: true });
  process.env.QQ_AGENT_DATA_DIR = tenantB;
  result = await loader.loadPlugins({ log });
  assert.ok(result.loaded.some((entry) => entry.id === 'trpg-dice-hook'));
});

test.after(() => {
  for (const item of skillManager.registry.list()) skillManager.unregister(item.manifest.id);
  const rel = path.relative(workspace, temp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe test cleanup path');
  fs.rmSync(temp, { recursive: true, force: true });
});
