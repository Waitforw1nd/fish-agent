import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startManager, loginAdmin } from './helpers.mjs';
import { startFakeUpstream, UPSTREAM_KEY } from './fixtures/fake-upstream.mjs';
import { BiliBridge } from '../../protocol-bili-bridge/src/bridge.js';
import { FakeBili } from '../../protocol-bili-bridge/test/support/fake-bili.mjs';
import { makeConfig, postAction } from '../../protocol-bili-bridge/test/support/helpers.mjs';
import { createExploreServices } from '../../protocol-bili-bridge/src/explore-services.js';
import { isApiAllowed } from '../src/config-guard.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-explore-agent-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.QQ_AGENT_CLOUD = '1';
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../../qq-agent-core/src/config.js');
const { createHeadlessApp } = await import('../../qq-agent-core/modules/headless/index.js');
const { CONNECTION_DEFAULTS } = await import('../../qq-agent-core/modules/headless/connection.js');

test('local explore to authenticated agent and Relay meters L0 and L1 without sending', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { if (new URL(url).hostname !== '127.0.0.1') throw new Error('External network disabled'); return originalFetch(url, options); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  assert.equal((await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } })).status, 200);
  const created = await admin.createTenant({ name: 'Bili explore', slug: 'bili-explore-test', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const relay = `http://127.0.0.1:${manager.config.relayPort}`;
  const agentEnv = { QQ_AGENT_HOST: '127.0.0.1', QQ_AGENT_PORT: '0', QQ_AGENT_TOKEN: 'fixture-console-token', QQ_AGENT_ALLOWED_HOSTS: '' };
  setRuntimeConfig(deepMerge(DEFAULT_CONFIG, { extensions: { hotReload: false }, proactive: { enabled: false }, connection: structuredClone(CONNECTION_DEFAULTS), api: { baseUrl: `${relay}/v1`, apiKey: key, model: 'deepseek-chat' }, persona: { botName: 'FixtureFish', roleText: 'A curious fish.' } }));
  const agent = createHeadlessApp({ env: agentEnv, log: () => {} });
  t.after(async () => { await agent.stop(); agent.server.closeAllConnections(); });
  const port = await agent.start(), url = `http://127.0.0.1:${port}/api/internal/bili-explore`;
  const { exploreGenerate, exploreMeter } = createExploreServices({ BILI_EXPLORE_AGENT_URL: url,
    BILI_EXPLORE_AGENT_TOKEN: agentEnv.QQ_AGENT_TOKEN, BILI_EXPLORE_METER_URL: `${relay}/v1/fish/meter-events`, BILI_EXPLORE_RELAY_KEY: key });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'wrong' }, body: '{}' })).status, 401);
  assert.equal(isApiAllowed('POST', '/api/internal/bili-explore'), false);
  const fake = await FakeBili.start();
  const bridge = new BiliBridge({ config: makeConfig({ fake, dataDir: path.join(dir, 'bridge') }), exploreGenerate, exploreMeter });
  t.after(async () => { await bridge.stop(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); assert.equal(fs.existsSync(dir), false); });
  for (const [bvid, aid] of [['BV1234567890', 101], ['BV0987654321', 102]]) {
    fake.addVideo({ bvid, aid, title: 'Fixture video' });
    fake.addSubtitle(aid, { id: 'fixture-' + aid });
  }
  fake.addUpVideo('42', { bvid: 'BV1234567890', aid: 101, title: 'Fixture video' });
  await bridge.init(); fake.applyCookiesTo(bridge.jar); await bridge.start(); await bridge.scheduler.stop();
  const watcher = bridge.explore;
  await watcher.configure({ enabled: true }); await watcher.poll(['42']);
  assert.equal(watcher.snapshot().journal.length, 1); assert.equal(watcher.snapshot().drafts.length, 0);
  await watcher.configure({ level: 1, acknowledged: true });
  fake.addUpVideo('42', { bvid: 'BV0987654321', aid: 102, title: 'Fixture video' });
  await watcher.poll(['42']);
  const draft = watcher.snapshot().drafts[0]; assert.ok(draft); assert.match(draft.text, /^\u3010AI\u751f\u6210\u3011/);
  const before = upstream.stats.requests.length, platformBefore = fake.requests.length;
  await watcher.review(draft.id, 'approve');
  assert.equal(watcher.snapshot().drafts[0].status, 'approved');
  assert.equal(fake.requests.length, platformBefore); assert.equal(upstream.stats.requests.length, before);
  const denied = await postAction(bridge, 'bili_reply_comment', { bvid: 'BV0987654321', message: 'must not publish' });
  assert.equal(denied.json.retcode, 1403); assert.equal(fake.requests.length, platformBefore);
  assert.equal(fake.requests.some(r => r.method !== 'GET'), false);
  fake.addVideo({ bvid: 'BV1111111111', aid: 103, title: 'Blocked candidate' });
  fake.addSubtitle(103); fake.addUpVideo('42', { bvid: 'BV1111111111', aid: 103, title: 'Blocked candidate' });
  await watcher.configure({ enabled: false });
  await watcher.poll(['42']); assert.equal(upstream.stats.requests.length, before); assert.equal(fake.requests.length, platformBefore);
  await watcher.configure({ enabled: true }); await watcher.pauseRisk();
  await watcher.poll(['42']); assert.equal(upstream.stats.requests.length, before); assert.equal(fake.requests.length, platformBefore);
  const ledger = manager.db.prepare('SELECT * FROM ledger WHERE tenant_id=?').all(tenantId);
  assert.equal(ledger.length, 3); assert.ok(ledger.every(x => x.platform === 'bili' && x.entry === 'bili' && (x.prompt_tokens + x.completion_tokens) > 0));
  const meters = manager.db.prepare('SELECT meter, SUM(quantity) AS quantity FROM meter_events WHERE tenant_id=? GROUP BY meter').all(tenantId);
  const counts = Object.fromEntries(meters.map(x => [x.meter, x.quantity]));
  assert.equal(counts['bili.comment.drafted'], 1); assert.equal(counts['bili.video.browsed'], 2); assert.ok(counts['bili.llm.tokens'] > 0);
  assert.equal(counts['bili.comment.posted'], undefined);
  assert.equal(counts['bili.llm.tokens'], ledger.reduce((n, row) => n + row.prompt_tokens + row.completion_tokens, 0));
  const usage = await admin.call('/api/tenants/' + tenantId + '/billing/entries/bili/usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.json.usage.find(row => row.meter === 'bili.comment.drafted').quantity, 1);
  assert.equal(upstream.stats.requests.length, 3);
  for (const { body } of upstream.stats.requests) {
    assert.equal(body.tools, undefined); assert.match(body.messages[0].content, /不可信/);
    assert.match(body.messages[0].content, /FixtureFish/); assert.match(body.messages[1].content, /subtitles/);
  }
});


