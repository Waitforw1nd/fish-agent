import test from 'node:test';
import assert from 'node:assert/strict';
import { startManager, loginAdmin } from '../../test/helpers.mjs';
import { createApi } from '../lib/api.js';
import { normalizeTenant } from '../lib/normalize.js';

test('面板客户端与真实后端离线保存名单、人设、角色卡和 B 站监控目标', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const client = await loginAdmin(env.manager);
  const created = await client.createTenant({ name: '工作台联调' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.tenant.id;
  const api = createApi({ fetchImpl: async (path, init) => {
    const result = await client.call(path, { method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, text: async () => result.text, headers: { get: () => null } };
  } });
  api.setCsrfToken(client.csrf);
  const summary = normalizeTenant(await api.getTenant(id));
  assert.equal(summary.readiness.steps[3].id, 'whitelistReady');
  assert.equal(summary.readiness.steps[3].ready, false);
  await api.updateAgentConfig(id, {
    allow: { groups: ['12345'], private: ['56789'] },
    blocklist: { __replace__: { '12345': ['11111'] } },
    personaByChat: { __replace__: { '12345': { roleText: '群专用人设' } } },
    store: { contextTier: 3, randomPercent: 35, groupSliderPos: { __replace__: { '12345': 55 } } }
  });
  const saved = await api.getAgentConfig(id);
  assert.deepEqual(saved.config.allow.groups, ['12345']);
  assert.deepEqual(saved.config.blocklist['12345'], ['11111']);
  assert.equal(saved.config.personaByChat['12345'].roleText, '群专用人设');
  assert.equal(saved.config.store.contextTier, 3);
  assert.equal((await api.getTenant(id)).tenant.readiness.whitelistReady, true);
  await api.updateAgentConfig(id, { blocklist: { __replace__: {} }, personaByChat: { __replace__: {} }, store: { groupSliderPos: { __replace__: {} } } });
  const cleared = await api.getAgentConfig(id);
  assert.deepEqual(cleared.config.blocklist, {});
  assert.deepEqual(cleared.config.personaByChat, {});
  assert.deepEqual(cleared.config.store.groupSliderPos, {});
  const card = { spec: 'chara_card_v2', data: { name: 'Fish', description: 'friendly fish', system_prompt: 'DO-NOT-IMPORT' } };
  const body = { name: 'fish.json', base64: Buffer.from(JSON.stringify(card)).toString('base64') };
  const preview = await api.previewAgentPersonaCard(id, body);
  assert.equal(preview.card.name, 'Fish');
  assert.doesNotMatch(JSON.stringify(preview), /DO-NOT-IMPORT/);
  await api.importAgentPersonaCard(id, { ...body, applyNow: true });
  assert.match((await api.getAgentConfig(id)).config.persona.roleText, /friendly fish/);
  await api.updateBiliConfig(id, { subscriptions: { mentions: true, upVideos: false, privateMessages: true, liveRooms: true }, upMids: ['42'], videos: ['BV1234567890'], liveRoomIds: ['123'] });
  const bili = await api.getBiliConfig(id);
  assert.deepEqual(bili.config.upMids, ['42']);
  assert.deepEqual(bili.config.liveRoomIds.map(String), ['123']);
  assert.equal(bili.config.subscriptions.liveRoom, true);
});
