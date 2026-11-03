import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { BiliBridge } from '../src/bridge.js';
import { BiliApi } from '../src/bili/api.js';
import { CookieJar } from '../src/bili/cookie-jar.js';
import { loadConfig } from '../src/config.js';
import { FakeBili } from './support/fake-bili.mjs';
import { tempDir, makeConfig, postAction, adminRequest } from './support/helpers.mjs';

test('cloud read-only policy cannot be overridden and standalone defaults are read-only', () => {
  assert.equal(loadConfig({ env: {} }).security.readOnly, true);
  assert.equal(loadConfig({ env: { BILI_READ_ONLY: 'false' }, overrides: { security: { readOnly: false } } }).security.readOnly, true);
  assert.equal(loadConfig({ env: { BILI_CLOUD_CONFIG_FILE: 'managed.json', BILI_READ_ONLY: 'false' }, overrides: { security: { readOnly: false } } }).security.readOnly, true);
});

test('transport defaults to read-only and explicit test writes cannot reach remote targets or follow redirects', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); };
  const standard = new BiliApi({ jar: new CookieJar(), fetchImpl });
  const fixture = new BiliApi({ jar: new CookieJar(), readOnly: false, endpoints: { api: 'http://127.0.0.1:7777' }, fetchImpl });
  for (const method of ['request', 'fetchText', 'fetchBuffer']) {
    await assert.rejects(standard[method]({ method: 'POST', service: 'api', path: '/x/v2/reply/add' }), e => e.kind === 'READ_ONLY');
    for (const target of ['https://api.bilibili.com/x/v2/reply/add', 'http://127.0.0.1.evil.test/x', 'http://user@127.0.0.1:7777/x']) {
      await assert.rejects(fixture[method]({ method: 'POST', service: 'api', path: target }), e => e.kind === 'READ_ONLY');
    }
  }
  assert.equal(calls.length, 0);
  await fixture.request({ method: 'POST', service: 'api', path: '/test', redirect: 'follow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('transport cancels response streams immediately after the byte limit', async () => {
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  const api = new BiliApi({ jar: new CookieJar(), maxResponseBytes: 10, fetchImpl: async () => new Response(body) });
  await assert.rejects(api.request({ path: '/test', retries: 0 }), e => e.kind === 'PROTOCOL' && /过大/.test(e.message));
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('a revoked exploration response cannot restore cookies after logout', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const jar = new CookieJar();
  jar.applySetCookie(['SESSDATA=old; Path=/'], 'https://api.bilibili.com/');
  let active = true;
  const api = new BiliApi({ jar, fetchImpl: async () => {
    entered(); await waiting;
    return new Response('{"code":0}', { headers: { 'set-cookie': 'SESSDATA=stale; Path=/' } });
  } });
  const request = api.request({ path: '/x/web-interface/view', retries: 0, shouldContinue: () => active });
  await started;
  active = false; jar.clear(); // Exploration cancellation and logout while the response is in flight.
  release(); await request;
  assert.equal(jar.get('SESSDATA'), null);
  active = true;
  await api.request({ path: '/x/web-interface/view', retries: 0, shouldContinue: () => active });
  assert.equal(jar.get('SESSDATA'), 'stale', 'an active request still accepts session cookies');
});

test('default bridge denies every publish action before contacting Bili; approving drafts only updates local state', async t => {
  const fake = await FakeBili.start(); const dataDir = await tempDir('bili-review-');
  const config = makeConfig({ fake, dataDir });
  config.security.readOnly = false; // Constructor must defend even against a hand-built configuration.
  const bridge = new BiliBridge({ config });
  t.after(async () => { await bridge.stop(); await fake.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await bridge.init(); fake.applyCookiesTo(bridge.jar); await bridge.start(); await bridge.scheduler.stop();
  assert.throws(() => { bridge.config.security.readOnly = false; }, TypeError);
  assert.throws(() => { bridge.api.readOnly = false; }, TypeError);
  bridge.config.security = { readOnly: false };
  await assert.rejects(bridge.sendGroupMessage({ groupId: 1, message: 'no' }), e => e.kind === 'READ_ONLY');
  bridge.config.security = Object.freeze({ ...bridge.config.security, readOnly: true });
  const before = fake.requests.length;
  const calls = [
    ['send_group_msg', { group_id: 4503599627370497, message: 'no' }],
    ['send_private_msg', { user_id: 4503599627370498, message: 'no' }],
    ['send_msg', { message_type: 'group', group_id: 4503599627370497, message: 'no' }],
    ['bili_reply_comment', { bvid: 'BV1xx411c7mD', message: 'no' }],
    ['bili_like', { bvid: 'BV1xx411c7mD', rpid: '1' }],
    ['bili_live_send_msg', { roomId: '9001', text: 'no' }]
  ];
  for (const [action, params] of calls) {
    const result = await postAction(bridge, action, params);
    assert.equal(result.json.status, 'failed', action);
    assert.equal(result.json.retcode, 1403, action);
  }
  // The HTTP layer also stops accidental future bypasses of bridge methods.
  await assert.rejects(bridge.api.request({ method: 'POST', service: 'api', path: '/x/v2/reply/add', form: { message: 'no' } }), e => e.kind === 'READ_ONLY');
  for (const method of ['fetchText', 'fetchBuffer']) {
    await assert.rejects(bridge.api[method]({ method: 'POST', service: 'api', path: '/x/v2/reply/add' }), e => e.kind === 'READ_ONLY');
  }
  await bridge.explore.store.update(d => { d.drafts.push({ id: 'draft-local', status: 'pending', text: '【AI生成】draft', createdAt: Date.now(), expiresAt: Date.now() + 60000 }); });
  await bridge.explore.review('draft-local', 'approve');
  assert.equal(bridge.explore.snapshot().drafts[0].status, 'approved');
  assert.equal(fake.requests.length, before, 'neither denied actions nor draft approval make a platform request');
  const status = await adminRequest(bridge, 'GET', '/admin/status');
  assert.equal(status.json.data.readOnly, true);
  fake.addDmSession('20002', { name: 'observer' });
  fake.addDmMessage('20002', { text: 'read only', seqno: '1780000000000000101', timestamp: 1700000600 });
  await bridge.dmWatcher.poll(); await bridge.dmWatcher.poll();
  assert.equal(fake.count('/session_svr/v1/session_svr/update_ack'), 0, 'read-only browsing must not change remote read markers');
});
