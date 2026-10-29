import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { CloudManager } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Client, loginAdmin } from './helpers.mjs';

const root = path.resolve(process.cwd());
const temp = fs.mkdtempSync(path.join(root, '.view-api-test-'));
let table;
function crc32(data) {
  table ||= Array.from({ length: 256 }, (_, index) => {
    let c = index;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let c = 0xffffffff;
  for (const byte of data) c = table[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), packed = deflateRawSync(data), nameBytes = Buffer.from(name);
    const a = Buffer.alloc(30), b = Buffer.alloc(46), crc = crc32(data);
    a.writeUInt32LE(0x04034b50, 0); a.writeUInt16LE(20, 4); a.writeUInt16LE(8, 8);
    a.writeUInt32LE(crc, 14); a.writeUInt32LE(packed.length, 18); a.writeUInt32LE(data.length, 22); a.writeUInt16LE(nameBytes.length, 26);
    b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6); b.writeUInt16LE(8, 10);
    b.writeUInt32LE(crc, 16); b.writeUInt32LE(packed.length, 20); b.writeUInt32LE(data.length, 24);
    b.writeUInt16LE(nameBytes.length, 28); b.writeUInt32LE(offset, 42);
    local.push(a, nameBytes, packed); central.push(b, nameBytes);
    offset += a.length + nameBytes.length + packed.length;
  }
  const end = Buffer.alloc(22), size = central.reduce((n, item) => n + item.length, 0);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]).toString('base64');
}
function pngChunk(type, data) {
  const buf = Buffer.alloc(data.length + 12), typeBytes = Buffer.from(type);
  buf.writeUInt32BE(data.length, 0); typeBytes.copy(buf, 4); data.copy(buf, 8);
  buf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return buf;
}
function characterPng(card) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  const text = Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString('base64')}`, 'latin1');
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('tEXt', text), pngChunk('IEND', Buffer.alloc(0))]);
}

test('same-origin settings, personas, extension permissions and catalogue', async (t) => {
  const basePort = 44000 + Math.floor(Math.random() * 2000);
  const config = loadConfig({
    CLOUD_DATA_DIR: temp, CLOUD_HOST: '127.0.0.1', CLOUD_PORT: '0', CLOUD_RELAY_HOST: '127.0.0.1',
    CLOUD_RELAY_PORT: '0', CLOUD_BASE_DOMAIN: 'test.local', CLOUD_COOKIE_SECURE: 'false',
    CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'admin-password-123',
    CLOUD_PORT_RANGE_START: String(basePort), CLOUD_PORT_RANGE_END: String(basePort + 500),
    CLOUD_LOG_LEVEL: 'error'
  });
  const manager = new CloudManager({ config });
  await manager.start();
  t.after(async () => {
    await manager.stop();
    const rel = path.relative(root, temp);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe test cleanup path');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const admin = await loginAdmin(manager);
  for (const username of ['owner', 'viewer', 'operator']) {
    const result = await admin.call('/api/admin/users', { method: 'POST', body: { username, password: `${username}-password-123`, role: 'user' } });
    assert.equal(result.status, 201, result.text);
  }
  const created = await admin.createTenant({ name: 'Test Fish', slug: 'test-fish', ownerUsername: 'owner', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.tenant.id;
  const row = manager.tenants.row(id);
  for (const [username, role] of [['viewer', 'viewer'], ['operator', 'operator']]) {
    const result = await admin.call(`/api/tenants/${id}/members`, { method: 'POST', body: { username, role } });
    assert.equal(result.status, 200, result.text);
  }
  const client = async (name) => {
    const user = new Client(`http://127.0.0.1:${config.panelPort}`);
    assert.equal((await user.login(name, `${name}-password-123`)).status, 200);
    return user;
  };
  const owner = await client('owner'), viewer = await client('viewer'), operator = await client('operator');
  const base = `/api/tenants/${id}`;
  const configPath = manager.agent.configPath(row);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    api: { baseUrl: 'http://locked.example/v1', apiKey: 'api-secret' },
    server: { token: 'console-secret' }, channels: { qq: { authToken: 'channel-secret' } },
    allow: { groups: ['1'] }, personaByChat: { '1': { roleText: 'old' } }
  }));
  const initial = await viewer.call(`${base}/agent/config`);
  assert.equal(initial.status, 200, initial.text);
  assert.doesNotMatch(initial.text, /api-secret|console-secret|channel-secret/);
  const denied = await viewer.call(`${base}/agent/config`, { method: 'PATCH', body: { allow: { groups: ['2'] } } });
  assert.equal(denied.status, 403);
  assert.equal((await owner.call(`${base}/agent/config`, { method: 'PATCH', csrf: false, body: {} })).status, 403);
  const updated = await operator.call(`${base}/agent/config`, {
    method: 'PATCH', body: {
      api: { baseUrl: 'http://evil', apiKey: 'evil' }, channels: { qq: { authToken: 'evil' } },
      allowAllWhenEmpty: true, tools: { crossChatSend: true }, security: { allowPrivateImageHosts: true },
      allow: { groups: ['123'] }, personaByChat: { __replace__: {} },
      store: { groupSliderPos: { __replace__: {} }, groupPeakPos: { __replace__: {} } },
      blocklist: { __replace__: {} }
    }
  });
  assert.equal(updated.status, 200, updated.text);
  const saved = JSON.parse(fs.readFileSync(configPath));
  assert.equal(saved.api.apiKey, 'api-secret');
  assert.equal(saved.api.baseUrl, 'http://locked.example/v1');
  assert.equal(saved.channels.qq.authToken, 'channel-secret');
  assert.equal(saved.allowAllWhenEmpty, false);
  assert.equal(saved.tools.crossChatSend, false);
  assert.equal(saved.security.allowPrivateImageHosts, false);
  assert.deepEqual(saved.personaByChat, {});
  assert.deepEqual(saved.allow.groups, ['123']);
  const exploit = await operator.call(`${base}/agent/config`, { method: 'PATCH', body: { api: { __replace__: { apiKey: 'attack' } } } });
  assert.equal(exploit.status, 400, exploit.text);
  assert.equal((await operator.call(`${base}/agent/config`, { method: 'PATCH', body: { skills: { 'trpg-dice-hook': { enabled: true } } } })).status, 400);

  const card = { spec: 'chara_card_v2', data: { name: 'Fish', description: 'friendly fish', system_prompt: 'NEVER-IMPORT', character_book: { entries: [{}] } } };
  for (const bytes of [Buffer.from(JSON.stringify(card)), characterPng(card)]) {
    const body = { filename: 'card.png', base64: bytes.toString('base64'), applyNow: true };
    const preview = await operator.call(`${base}/agent/persona-cards/preview`, { method: 'POST', body });
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.json.card.name, 'Fish');
    assert.doesNotMatch(preview.text, /NEVER-IMPORT/);
    const imported = await operator.call(`${base}/agent/persona-cards/import`, { method: 'POST', body });
    assert.equal(imported.status, 201, imported.text);
    assert.doesNotMatch(imported.text, /NEVER-IMPORT/);
  }
  assert.equal((await owner.call(`${base}/extensions/install-zip`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await admin.call(`${base}/extensions/trpg-dice-hook`, { method: 'DELETE' })).status, 200);
  const blocked = await operator.call(`${base}/agent/skills/trpg-dice-hook`, { method: 'PATCH', body: { enabled: true } });
  assert.equal(blocked.status, 403, blocked.text);
  assert.equal(blocked.json.code, 'EXTENSION_BLOCKED_BY_ADMIN');
  const filtered = await viewer.call(`${base}/extensions`);
  assert.equal(filtered.json.items.some((item) => item.id === 'trpg-dice-hook'), false);
  assert.equal((await admin.call(`${base}/extensions/trpg-dice-hook/restore`, { method: 'POST' })).status, 200);

  const archive = zip({
    'demo/plugin.json': JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, configSchema: { rate: { type: 'number', min: 0, max: 5 }, privateValue: { type: 'string', secret: true, default: 'hidden-secret' } } }),
    'demo/index.js': 'export function setup() {}'
  });
  const uploaded = await admin.call('/api/admin/extensions/catalog', { method: 'POST', body: { filename: 'demo.zip', base64: archive } });
  assert.equal(uploaded.status, 201, uploaded.text);
  const catalog = await admin.call('/api/admin/extensions/catalog');
  assert.ok(catalog.json.items.some((item) => item.id === 'demo'));
  assert.doesNotMatch(catalog.text, /hidden-secret/);
  const deployed = await admin.call('/api/admin/extensions/catalog/demo/deploy', { method: 'POST', body: { tenantIds: [id] } });
  assert.equal(deployed.status, 200, deployed.text);
  assert.equal(deployed.json.results[0].ok, true);
  const distributed = await admin.call('/api/admin/extensions/catalog');
  const catalogItem = distributed.json.items.find((item) => item.id === 'demo');
  assert.equal(catalogItem.tenantCount, 1);
  assert.deepEqual(catalogItem.installedTenants, [id]);
  assert.equal((await operator.call(`${base}/agent/skills/demo`, { method: 'PATCH', body: { enabled: true, settings: { rate: 4 } } })).status, 200);
  assert.equal((await operator.call(`${base}/agent/skills/demo`, { method: 'PATCH', body: { settings: { privateValue: 'attack' } } })).status, 403);
  assert.equal((await operator.call(`${base}/agent/skills/demo`, { method: 'PATCH', body: { settings: { rate: 200 } } })).status, 400);
  const removed = await admin.call('/api/admin/extensions/catalog/demo/undeploy', { method: 'POST', body: { tenantIds: [id] } });
  assert.equal(removed.json.results[0].ok, true);

  const diskBeforeStart = JSON.parse(fs.readFileSync(configPath));
  diskBeforeStart.skills.demo.privateValue = 'opaque-sensitive';
  diskBeforeStart.memberNotes = { '42': 'preserved note' };
  fs.writeFileSync(configPath, JSON.stringify(diskBeforeStart));
  await manager.agent.start(row);
  const running = manager.supervisor.status(id, 'agent');
  assert.equal(running.state, 'running');
  const serviceEnv = manager.supervisor.get(id, 'agent').env;
  assert.equal(serviceEnv.QQ_AGENT_ADMIN_PLUGINS_DIR, path.join(row.data_dir, 'admin-extensions', 'plugins'));
  const livePatch = await operator.call(`${base}/agent/config`, {
    method: 'PATCH', body: { allow: { groups: ['123'] }, store: { contextTier: 2 }, personaByChat: { __replace__: {} } }
  });
  assert.equal(livePatch.status, 200, livePatch.text);
  assert.equal(livePatch.json.agentRunning, true);
  const live = await viewer.call(`${base}/agent/config`);
  assert.equal(live.status, 200, live.text);
  assert.equal(live.json.config.store.contextTier, 2);
  assert.doesNotMatch(live.text, /api-secret|channel-secret|console-secret|opaque-sensitive/);
  const memoryWrite = await operator.call(`${base}/agent/memories/group%3A123/members/42`, {
    method: 'PUT', body: { name: 'friend', impressions: [{ content: 'likes fish' }] }
  });
  assert.equal(memoryWrite.status, 200, memoryWrite.text);
  assert.equal(memoryWrite.json.member.note, 'preserved note');
  const memoryRead = await viewer.call(`${base}/agent/memories/group%3A123`);
  assert.equal(memoryRead.status, 200, memoryRead.text);
  assert.equal(memoryRead.json.members[0].note, 'preserved note');
  assert.equal(memoryRead.json.members[0].impressions[0].content, 'likes fish');
  const deniedSend = await operator.call(`${base}/agent/chats/group%3A999/actions`, {
    method: 'POST', body: { action: 'test-send', text: 'hello' }
  });
  assert.equal(deniedSend.status, 403, deniedSend.text);
  const installed = await admin.call(`${base}/extensions/install-zip`, { method: 'POST', body: { base64: archive } });
  assert.equal(installed.status, 201, installed.text);
  const liveSkills = await viewer.call(`${base}/agent/skills`);
  assert.equal(liveSkills.status, 200, liveSkills.text);
  assert.equal(Object.keys(liveSkills.json.categories).length, 8);
  assert.ok(liveSkills.json.tools.length > 0);
  assert.doesNotMatch(liveSkills.text, /opaque-sensitive|hidden-secret/);
  const liveSkillUpdate = await operator.call(`${base}/agent/skills/demo`, { method: 'PATCH', body: { settings: { rate: 3 } } });
  assert.equal(liveSkillUpdate.status, 200, liveSkillUpdate.text);
  assert.doesNotMatch(liveSkillUpdate.text, /opaque-sensitive|hidden-secret/);
  const broken = zip({
    'demo/plugin.json': JSON.stringify({ id: 'demo', name: 'Demo', version: '2.0.0', apiVersion: 1 }),
    'demo/index.js': "export function setup() { throw new Error('runtime-private-secret'); }"
  });
  const rejected = await admin.call(`${base}/extensions/install-zip`, { method: 'POST', body: { base64: broken } });
  assert.equal(rejected.status, 422, rejected.text);
  assert.equal(rejected.json.code, 'EXTENSION_LOAD_FAILED');
  assert.doesNotMatch(rejected.text, /runtime-private-secret/);
  const restored = JSON.parse(fs.readFileSync(path.join(row.data_dir, 'admin-extensions', 'plugins', 'demo', 'plugin.json')));
  assert.equal(restored.version, '1.0.0');
  const liveExtensions = await viewer.call(`${base}/extensions`);
  assert.equal(liveExtensions.json.items.find((item) => item.id === 'demo').version, '1.0.0');
});
