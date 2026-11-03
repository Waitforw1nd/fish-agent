import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExploreWatcher } from '../src/pollers/explore.js';
import { VideoService } from '../src/bili/video.js';
import { BiliApi } from '../src/bili/api.js';
import { CookieJar } from '../src/bili/cookie-jar.js';
import { WbiSigner } from '../src/bili/wbi.js';
import { BiliBridge } from '../src/bridge.js';
import { makeConfig } from './support/helpers.mjs';

test('completed video reads survive player failure and cancellation without duplicate billing or exceeding the browse limit', async t => {
  for (const cancel of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-player-failure-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const requests = [], deliveries = [];
    const api = new BiliApi({ jar: new CookieJar(), signer: { sign: async params => params },
      fetchImpl: async url => {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname === '/x/web-interface/view') return Response.json({ code: 0, data: { bvid: 'BV1234567890', aid: 1, pages: [{ cid: 2 }] } });
        if (pathname === '/x/player/wbi/v2') { entered(); await gate; return Response.json({ code: -404 }); }
        throw new Error('unexpected network request');
      } });
    const video = new VideoService({ api });
    const watcher = new ExploreWatcher({ dir, risk: { blocked: false }, video,
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }, { bvid: 'BV0987654321' }] } } }) },
      meter: async event => { deliveries.push(event.idempotencyKey); if (deliveries.length === 1) throw new Error('temporary failure'); } });
    await watcher.load();
    await watcher.configure({ enabled: true, maxVideosPerDay: 1 });
    const poll = watcher.poll(['123']);
    await ready;
    if (cancel) await watcher.configure({ enabled: false });
    release();
    if (cancel) await poll; else await assert.rejects(poll);
    const restarted = new ExploreWatcher({ dir, risk: { blocked: false }, video, api: watcher.api, meter: watcher.meter });
    await restarted.load();
    assert.equal(restarted.store.data.journal.length, 1);
    assert.equal(restarted.store.data.journal[0].subtitleAvailable, null);
    assert.equal(restarted.store.data.pendingMeters.length, 1);
    assert.equal(restarted.store.data.pendingMeters[0].meter, 'bili.video.browsed');
    await restarted.configure({ enabled: true });
    await restarted.poll(['123']);
    assert.deepEqual(requests, ['/x/web-interface/view', '/x/player/wbi/v2']);
    assert.equal(restarted.store.data.journal.length, 1);
    assert.equal(restarted.store.data.pendingMeters.length, 0);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0], deliveries[1]);
  }
});

test('a watcher disabled and re-enabled between requests revokes the old round', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-watch-revision-'));
  const lifecycle = path.join(dir, 'bili-watch', 'lifecycle.json');
  const previous = process.env.BILI_WATCH_LIFECYCLE_FILE, previousData = process.env.QQ_AGENT_DATA_DIR, previousCloud = process.env.QQ_AGENT_CLOUD;
  process.env.BILI_WATCH_LIFECYCLE_FILE = lifecycle;
  process.env.QQ_AGENT_DATA_DIR = dir;
  process.env.QQ_AGENT_CLOUD = '1';
  t.after(async () => { for (const [key, value] of [['BILI_WATCH_LIFECYCLE_FILE', previous], ['QQ_AGENT_DATA_DIR', previousData], ['QQ_AGENT_CLOUD', previousCloud]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(dir, { recursive: true, force: true }); });
  const plugin = await import('../../qq-agent-core/plugins/bili-watcher/index.js');
  plugin.setup({ log: () => {} });
  const originalNow = Date.now;
  Date.now = () => 1700000000000;
  try { plugin.activate(); } finally { Date.now = originalNow; }
  const first = JSON.parse(await readFile(lifecycle, 'utf8'));
  const bridge = new BiliBridge({ config: makeConfig({ dataDir: path.join(dir, 'bridge') }) });
  await bridge.init(); bridge.started = true;
  const revision = bridge.watcherRevision();
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ unrelated: true }));
  assert.equal(bridge.watcherRevision(), revision, 'unrelated config changes do not revoke a round');
  bridge.jar.set('SESSDATA', 'fake', { domain: 'bilibili.com' });
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  bridge.explore.api = { request: async () => { calls.push('feed'); entered(); await gate; return { data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }; } };
  bridge.explore.video = { context: async () => { calls.push('context'); return { subtitleText: '' }; } };
  await bridge.explore.configure({ enabled: true });
  const poll = bridge.explore.poll(['123']); await ready;
  Date.now = () => 1700000000000;
  try { plugin.deactivate(); plugin.activate(); } finally { Date.now = originalNow; }
  const last = JSON.parse(await readFile(lifecycle, 'utf8'));
  assert.equal(first.updatedAt, last.updatedAt);
  assert.notEqual(first.revision, last.revision);
  release(); await poll;
  assert.deepEqual(calls, ['feed']);
  await bridge.stop();
});

test('logout or disabling watchers cancels an exploration already in progress', async t => {
  for (const change of ['logout', 'watcher']) for (const stage of ['feed', 'context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-lifecycle-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bridge = new BiliBridge({ config: makeConfig({ dataDir: dir }) });
    await bridge.init();
    bridge.started = true;
    bridge.jar.set('SESSDATA', 'fake', { domain: 'bilibili.com' });
    let active = true;
    bridge.watcherActive = () => active;
    const watcher = bridge.explore;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const calls = [];
    const waitAt = async name => { calls.push(name); if (stage === name) { entered(); await gate; } };
    watcher.api = { request: async () => { await waitAt('feed'); return { data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }; } };
    watcher.video = { context: async () => { await waitAt('context'); return { subtitleText: 'evidence' }; } };
    watcher.generate = async ({ mode }) => { await waitAt(mode); return { text: 'generated' }; };
    await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(['123']);
    await ready;
    if (change === 'logout') await bridge.logout(); else active = false;
    release(); await poll;
    assert.deepEqual(calls, ['feed', 'context', 'summary', 'draft'].slice(0, ['feed', 'context', 'summary', 'draft'].indexOf(stage) + 1), `${change} ${stage}`);
    assert.equal(watcher.snapshot().drafts.length, 0);
    assert.equal(watcher.store.data.pendingMeters.length, stage === 'feed' ? 0 : 1);
    await bridge.stop();
  }
});

test('removing a watched UP or stopping the bridge revokes in-flight exploration', async t => {
  for (const change of ['remove', 'stop']) for (const stage of ['feed', 'context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-up-remove-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bridge = new BiliBridge({ config: makeConfig({ dataDir: dir }) });
    await bridge.init();
    await bridge.setWatches({ ups: ['123'] });
    const watcher = bridge.explore;
    watcher.canRun = () => true;
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const waitAt = async name => { calls.push(name); if (stage === name) { started(); await pending; } };
    watcher.api = { request: async () => { await waitAt('feed'); return { data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }; } };
    watcher.video = { context: async () => { await waitAt('context'); return { subtitleText: 'evidence' }; } };
    watcher.generate = async ({ mode }) => { await waitAt(mode); return { text: 'generated' }; };
    await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(bridge.getWatches().ups);
    await waiting;
    if (change === 'remove') {
      await bridge.setWatches({ ups: [] });
      await bridge.setWatches({ ups: ['123'] });
    } else {
      bridge.started = true;
      await bridge.stop();
    }
    release(); await poll;
    assert.deepEqual(calls, ['feed', 'context', 'summary', 'draft'].slice(0, ['feed', 'context', 'summary', 'draft'].indexOf(stage) + 1), stage);
    assert.equal(watcher.snapshot().drafts.length, 0, stage);
    assert.equal(watcher.snapshot().journal.length, stage === 'feed' ? 0 : 1, stage);
    if (stage !== 'feed' && stage !== 'draft') assert.equal(watcher.snapshot().journal[0].summary, '', stage);
    assert.equal(watcher.store.data.pendingMeters.length, stage === 'feed' ? 0 : 1, stage);
  }
});

test('cancellation while flushing historical meters cannot revive an old exploration round', { timeout: 15000 }, async t => {
  for (const change of ['resume', 'remove', 'stop']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-meter-cancel-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bridge = new BiliBridge({ config: makeConfig({ dataDir: dir }) });
    await bridge.init();
    await bridge.setWatches({ ups: ['123'] });
    const watcher = bridge.explore;
    watcher.canRun = () => true;
    await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    await watcher.store.update(data => { data.pendingMeters.push({ meter: 'bili.video.browsed',
      idempotencyKey: 'prior-visit', quantity: 1, unit: 'count', occurredAt: Date.now() }); });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const calls = [];
    watcher.meter = async () => { calls.push('meter'); entered(); await gate; };
    watcher.api = { request: async () => { calls.push('feed'); return { data: {} }; } };
    const poll = watcher.poll(bridge.getWatches().ups);
    try {
      await ready;
      if (change === 'resume') {
        await watcher.configure({ enabled: false });
        await watcher.configure({ enabled: true });
      } else if (change === 'remove') {
        await bridge.setWatches({ ups: [] });
        await bridge.setWatches({ ups: ['123'] });
      } else {
        bridge.started = true;
        await bridge.stop();
      }
    } finally { release(); await poll; }
    assert.deepEqual(calls, ['meter'], change);
    assert.equal(watcher.store.data.pendingMeters.length, 0, 'historical usage is still delivered');
    await watcher.poll(bridge.getWatches().ups);
    assert.deepEqual(calls, ['meter', 'feed'], 'a fresh round can still run');
  }
});

test('invalidating conditions between real video context stages stop later reads', async t => {
  for (const [stage, change] of [['view', 'resume'], ['player', 'pause'], ['view', 'keywords'], ['player', 'limit'], ['view', 'risk']]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-context-pause-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const waitAt = async name => { calls.push(name); if (stage === name) { started(); await pending; } };
    const video = new VideoService({ api: { endpoints: {} } });
    video.view = async () => { await waitAt('view'); return { bvid: 'BV1234567890', aid: '1', pages: [{ cid: '2' }] }; };
    video.player = async () => { await waitAt('player'); return { cid: '2', data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://a.hdslb.com/a' }] } } }; };
    video.downloadSubtitle = async () => { await waitAt('download'); return { ok: true, text: 'evidence' }; };
    const watcher = new ExploreWatcher({ dir, risk: { blocked: false }, video,
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }) },
      generate: async () => { calls.push('generate'); return { text: 'generated' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true, keywords: ['old'] });
    const poll = watcher.poll(['123']); await waiting;
    if (change === 'resume') { await watcher.configure({ enabled: false }); await watcher.configure({ enabled: true }); }
    else if (change === 'pause') await watcher.configure({ enabled: false });
    else if (change === 'keywords') await watcher.configure({ keywords: [] });
    else if (change === 'limit') await watcher.configure({ maxVideosPerDay: 0 });
    else watcher.risk.blocked = true;
    release(); await poll;
    assert.deepEqual(calls, stage === 'view' ? ['view'] : ['view', 'player']);
    assert.equal(watcher.snapshot().journal.length, 1);
    assert.equal(watcher.snapshot().journal[0].subtitleAvailable, null);
    assert.equal(watcher.snapshot().drafts.length, 0);
    assert.deepEqual(watcher.store.data.pendingMeters.map(x => x.meter), ['bili.video.browsed']);
  }
});

test('cancelled exploration does not retry a read or send a signed request after WBI preparation', async t => {
  for (const stage of ['view', 'nav', 'player', 'subtitle']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-http-cancel-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const host = 'http://127.0.0.1:12345';
    const api = new BiliApi({ endpoints: { api: host, subtitle: host }, jar: new CookieJar(), fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      const name = pathname.endsWith('/view') ? 'view' : pathname.endsWith('/nav') ? 'nav' : pathname.endsWith('/v2') ? 'player' : 'subtitle';
      calls.push(name);
      if (name === stage) { started(); await pending; if (stage !== 'nav') return new Response('', { status: 500 }); }
      const data = name === 'view' ? { bvid: 'BV1234567890', aid: 1, pages: [{ cid: 2 }] }
        : name === 'nav' ? { wbi_img: { img_url: host + '/abcdefghijklmnopqrstuvwxyz123456.png', sub_url: host + '/abcdefghijklmnopqrstuvwxyz123456.png' } }
          : name === 'player' ? { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: host + '/subtitle' }] } } : null;
      return new Response(JSON.stringify(name === 'subtitle' ? { body: [] } : { code: 0, data }), { status: 200 });
    } });
    api.setSigner(new WbiSigner({ request: args => api.request(args) }));
    const video = new VideoService({ api, forceHttps: false });
    const watcher = new ExploreWatcher({ dir, risk: { blocked: false }, video,
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }) } });
    await watcher.load(); await watcher.configure({ enabled: true });
    const poll = watcher.poll(['1']); await waiting; await watcher.configure({ enabled: false }); release();
    if (stage === 'view') await assert.rejects(poll, e => e.kind === 'CANCELLED'); else await poll;
    assert.deepEqual(calls, ['view', 'nav', 'player', 'subtitle'].slice(0, ['view', 'nav', 'player', 'subtitle'].indexOf(stage) + 1), stage);
    if (stage === 'nav') assert.equal(api.signer.keys, null, 'revoked WBI response must not cache keys');
    assert.equal(watcher.snapshot().journal.length, stage === 'view' ? 0 : 1, stage);
    if (stage !== 'view') assert.equal(watcher.snapshot().journal[0].subtitleAvailable, null, stage);
  }
});

test('pause and resume invalidates an in-flight generation', async t => {
  for (const stage of ['context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-resume-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const waitAt = async name => { if (stage === name) { started(); await pending; } };
    const calls = [];
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk: { blocked: false },
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }, { bvid: 'BV0987654321' }] } } }) },
      video: { context: async () => { calls.push('context'); await waitAt('context'); return { subtitleText: 'evidence' }; } },
      generate: async ({ mode }) => { calls.push(mode); await waitAt(mode); return { text: 'generated' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(['123']); await waiting;
    await watcher.configure({ enabled: false }); await watcher.configure({ enabled: true });
    release(); await poll;
    assert.deepEqual(calls, stage === 'context' ? ['context'] : stage === 'summary' ? ['context', 'summary'] : ['context', 'summary', 'draft']);
    assert.equal(watcher.snapshot().drafts.length, 0, stage);
    if (stage !== 'draft') assert.equal(watcher.snapshot().journal[0].summary, '', stage);
    assert.deepEqual(watcher.store.data.pendingMeters.map(x => x.meter), ['bili.video.browsed']);
  }
});

test('candidate discovery stops after an in-flight pause, risk, or window change', async t => {
  for (const change of ['disabled', 'resume', 'risk', 'window', 'keywords']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-feed-pause-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [], risk = { blocked: false };
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk,
      api: { request: async args => { calls.push(args); if (calls.length === 1) { started(); await pending; } return { data: {} }; } },
      video: { context: async () => { throw new Error('unexpected video'); } } });
    await watcher.load(); await watcher.configure({ enabled: true, keywords: ['old'] });
    const poll = watcher.poll(change === 'keywords' ? ['123'] : ['123', '456']); await waiting;
    if (change === 'disabled') await watcher.configure({ enabled: false });
    else if (change === 'resume') { await watcher.configure({ enabled: false }); await watcher.configure({ enabled: true }); }
    else if (change === 'risk') risk.blocked = true;
    else if (change === 'window') await watcher.configure({ activeWindows: [] });
    else await watcher.configure({ keywords: ['new'] });
    release(); await poll;
    assert.equal(calls.length, 1, change);
    if (change === 'risk') assert.equal(watcher.store.data.needsRiskClear, true);
  }
});

test('removing a keyword revokes candidates and generated results already in flight', async t => {
  for (const stage of ['feed', 'context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-keyword-revoke-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const waitAt = async name => { if (stage === name) { started(); await pending; } };
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk: { blocked: false },
      api: { request: async () => { calls.push('feed'); await waitAt('feed'); return { data: { result: [{ bvid: 'BV1234567890' }] } }; } },
      video: { context: async () => { calls.push('context'); await waitAt('context'); return { subtitleText: 'evidence' }; } },
      generate: async ({ mode }) => { calls.push(mode); await waitAt(mode); return { text: 'generated' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true, keywords: ['old'] });
    const poll = watcher.poll(); await waiting;
    await watcher.configure({ keywords: [] });
    release(); await poll;
    assert.deepEqual(calls, ['feed', 'context', 'summary', 'draft'].slice(0, ['feed', 'context', 'summary', 'draft'].indexOf(stage) + 1), stage);
    assert.equal(watcher.snapshot().drafts.length, 0, stage);
    assert.equal(watcher.snapshot().journal.length, stage === 'feed' ? 0 : 1, stage);
    if (stage === 'context' || stage === 'summary') assert.equal(watcher.snapshot().journal[0].summary, '', stage);
    assert.equal(watcher.store.data.pendingMeters.filter(x => x.meter === 'bili.video.browsed').length, stage === 'feed' ? 0 : 1, stage);
  }
});

test('a visit at the browse limit can generate, including when the limit is lowered in flight', async t => {
  for (const stage of ['before', 'context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-browse-boundary-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const waitAt = async name => { if (stage === name) { started(); await pending; } };
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk: { blocked: false },
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }, { bvid: 'BV0987654321' }] } } }) },
      video: { context: async () => { calls.push('context'); await waitAt('context'); return { subtitleText: 'evidence' }; } },
      generate: async ({ mode }) => { calls.push(mode); await waitAt(mode); return { text: 'generated' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true, maxVideosPerDay: stage === 'before' ? 1 : 2 });
    const poll = watcher.poll(['123']);
    if (stage !== 'before') { await waiting; await watcher.configure({ maxVideosPerDay: 1 }); release(); }
    await poll;
    assert.deepEqual(calls, ['context', 'summary', 'draft'], stage);
    assert.equal(watcher.snapshot().journal.length, 1, stage);
    assert.equal(watcher.snapshot().drafts.length, 1, stage);
  }
});

test('browse limit uses a rolling 24-hour window for later candidates', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-browse-day-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1700000000000;
  const calls = [];
  const watcher = new ExploreWatcher({ dir, now: () => now, risk: { blocked: false },
    api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }, { bvid: 'BV0987654321' }] } } }) },
    video: { context: async ({ bvid }) => { calls.push(bvid); return { subtitleText: '' }; } },
    meter: async () => { now += 86400000; } });
  await watcher.load(); await watcher.configure({ enabled: true, maxVideosPerDay: 1 });
  await watcher.poll(['123']);
  assert.deepEqual(calls, ['BV1234567890', 'BV0987654321']);
  assert.equal(watcher.snapshot().journal.length, 2);
});

test('lowering the browse limit during a visit stops later generation while accounting for the read', async t => {
  for (const stage of ['context', 'summary', 'draft']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-browse-limit-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    const calls = [];
    const waitAt = async name => { if (stage === name) { started(); await pending; } };
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk: { blocked: false },
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }) },
      video: { context: async () => { await waitAt('context'); return { subtitleText: 'evidence' }; } },
      generate: async ({ mode }) => { calls.push(mode); await waitAt(mode); return { text: 'generated' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(['123']); await waiting;
    await watcher.configure({ maxVideosPerDay: 0 }); release(); await poll;
    assert.deepEqual(calls, stage === 'context' ? [] : stage === 'summary' ? ['summary'] : ['summary', 'draft']);
    assert.equal(watcher.snapshot().drafts.length, 0, stage);
    assert.equal(watcher.snapshot().journal.length, 1, stage);
    if (stage !== 'draft') assert.equal(watcher.snapshot().journal[0].summary, '', stage);
    assert.deepEqual(watcher.store.data.pendingMeters.map(x => x.meter), ['bili.video.browsed'], stage);
  }
});

test('summary in flight does not trigger another model call after pause or outside the active window', async t => {
  for (const change of ['disabled', 'risk', 'window']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-summary-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const generating = new Promise(resolve => { started = resolve; });
    const calls = [], risk = { blocked: false };
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk,
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }, { bvid: 'BV0987654321' }] } } }) },
      video: { context: async () => ({ subtitleText: 'evidence' }) },
      generate: async ({ mode }) => { calls.push(mode); started(); await pending; return { text: 'text' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(['123']); await generating;
    if (change === 'disabled') await watcher.configure({ enabled: false });
    else if (change === 'risk') risk.blocked = true;
    else await watcher.configure({ activeWindows: [] });
    release(); await poll;
    assert.deepEqual(calls, ['summary'], change);
    assert.equal(watcher.snapshot().drafts.length, 0, change);
    assert.equal(watcher.store.data.pendingMeters.filter(x => x.meter === 'bili.comment.drafted').length, 0, change);
    if (change === 'risk') assert.equal(watcher.store.data.needsRiskClear, true);
  }
});

test('in-flight drafts respect a lowered limit or newly cleared risk cooldown', async t => {
  for (const change of ['limit', 'risk']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-inflight-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const generating = new Promise(resolve => { started = resolve; });
    const watcher = new ExploreWatcher({ dir, now: () => 1700000000000, risk: { blocked: false },
      api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890' }] } } }) },
      video: { context: async () => ({ subtitleText: 'evidence' }) },
      generate: async ({ mode }) => { if (mode === 'draft') { started(); await pending; } return { text: 'text' }; } });
    await watcher.load(); await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    const poll = watcher.poll(['123']); await generating;
    if (change === 'limit') await watcher.configure({ maxDraftsPerDay: 0 });
    else { await watcher.pauseRisk(); await watcher.clearRisk(); }
    release(); await poll;
    assert.equal(watcher.snapshot().drafts.length, 0, change);
    assert.equal(watcher.store.data.pendingMeters.filter(x => x.meter === 'bili.comment.drafted').length, 0, change);
  }
});

test('L1 drafts require acknowledgement, evidence, review and never publish', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-')); let now = 1700000000000;
  const calls = [], meters = [];
  const watcher = new ExploreWatcher({ dir, now: () => now, risk: { blocked: false }, api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV1234567890', aid: 1, title: 'Test' }] } } }) }, video: { context: async () => ({ subtitleText: 'evidence' }) }, generate: async (input) => { calls.push(input.mode); return { text: input.mode }; }, meter: async e => meters.push(e) });
  try {
    await watcher.load();
    for (const patch of [null, [], 'invalid', 1]) await assert.rejects(watcher.configure(patch), error => error.code === 400);
    await assert.rejects(watcher.configure({ enabled: true, level: 1 }));
    await assert.rejects(watcher.configure({ level: 2, acknowledged: true }));
    await Promise.all([watcher.configure({ keywords: ['fish'] }), watcher.configure({ maxVideosPerDay: 7 })]);
    assert.deepEqual(watcher.snapshot().config.keywords, ['fish']);
    assert.equal(watcher.snapshot().config.maxVideosPerDay, 7);
    await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    await watcher.poll(['123']); await watcher.poll(['123']);
    assert.deepEqual(calls, ['summary', 'draft']); assert.equal(meters.length, 2);
    const draft = watcher.snapshot().drafts[0]; assert.match(draft.text, /^【AI生成】/);
    await watcher.review(draft.id, 'edit', 'edited');
    await watcher.review(draft.id, 'approve');
    assert.equal(watcher.snapshot().drafts[0].status, 'approved');
    assert.match(watcher.snapshot().drafts[0].text, /^【AI生成】/);
    await assert.rejects(watcher.review(draft.id, 'approve'));
    await watcher.pauseRisk(); now += 2 * 86400000;
    assert.equal(watcher.snapshot().riskBlocked, true);
    await watcher.clearRisk(); assert.equal(watcher.snapshot().riskUntil, now + 86400000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('three consecutive rejections follow review order and survive restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { dir, now: () => 1700000000000, risk: { blocked: false } };
  let watcher = new ExploreWatcher(options); await watcher.load();
  const seed = async () => {
    await watcher.configure({ enabled: true, level: 1, acknowledged: true });
    await watcher.store.update(d => { delete d.recentReviews; d.drafts = Array.from({ length: 6 }, (_, i) => ({ id: String(i), status: 'pending', createdAt: options.now() - 1000 + i, expiresAt: options.now() + 1000 })); });
  };
  await seed();
  await watcher.review('0', 'approve'); await watcher.review('3', 'reject'); await watcher.review('4', 'reject');
  await watcher.review('1', 'approve'); await watcher.review('5', 'reject');
  assert.equal(watcher.snapshot().config.level, 1, 'creation-order tail must not downgrade after an intervening approval');
  await seed();
  await watcher.review('4', 'reject'); await watcher.review('3', 'reject'); await watcher.review('5', 'approve');
  await watcher.review('2', 'reject'); await watcher.review('1', 'reject');
  watcher = new ExploreWatcher(options); await watcher.load();
  assert.equal(watcher.snapshot().config.level, 1);
  await watcher.review('0', 'reject');
  assert.equal(watcher.snapshot().config.level, 0, 'three latest actual reviews reject, despite latest-created draft being approved');
});

test('browse retry keeps its identity while a later revisit is metered separately', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-meter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accepted = new Set(), attempts = [];
  let fail = true, now = 1700000000000;
  const options = { dir, now: () => now, risk: { blocked: false },
    api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV0987654321', title: 'Revisit' }] } } }) },
    video: { context: async () => ({ subtitleText: '' }) },
    meter: async event => { attempts.push(structuredClone(event)); accepted.add(event.idempotencyKey); if (fail) throw new Error('ACK lost'); } };
  let watcher = new ExploreWatcher(options); await watcher.load(); await watcher.configure({ enabled: true });
  await watcher.poll(['123']); assert.equal(watcher.store.data.pendingMeters.length, 1);
  watcher = new ExploreWatcher(options); await watcher.load(); fail = false;
  await watcher.poll(['123']); assert.deepEqual(attempts[1], attempts[0]); assert.equal(accepted.size, 1);
  assert.equal(watcher.store.data.pendingMeters.length, 0);
  await watcher.store.update(d => { d.seen = []; }); // A previously visited BV has aged out of the bounded seen cache.
  now += 86400001; await watcher.poll(['123']);
  assert.equal(accepted.size, 2); assert.equal(watcher.snapshot().journal.length, 2);
  assert.notEqual(attempts[2].idempotencyKey, attempts[0].idempotencyKey);
});

test('pending meters retry while exploration is disabled and concurrent flushes share one delivery', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-meter-disabled-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release, started;
  const wait = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const events = [];
  const watcher = new ExploreWatcher({ dir, risk: { blocked: false }, meter: async event => {
    events.push(event); started(); await wait;
  } });
  await watcher.load();
  await watcher.store.update(d => { d.pendingMeters.push({ idempotencyKey: 'persisted', meter: 'bili.video.browsed' }); });
  const first = watcher.poll(); await entered;
  const second = watcher.flushMeters(); release(); await Promise.all([first, second]);
  assert.equal(events.length, 1);
  assert.equal(events[0].idempotencyKey, 'persisted');
  assert.deepEqual(watcher.store.data.pendingMeters, []);
});

test('meter scheduler retries without a logged-in account or active watcher', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-meter-scheduler-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const delivered = [];
  const bridge = new BiliBridge({ config: makeConfig({ dataDir: dir }), exploreMeter: async event => delivered.push(event) });
  await bridge.init();
  assert.equal(bridge.auth.loggedIn, false);
  bridge.watcherActive = () => false;
  await bridge.explore.configure({ enabled: false });
  await bridge.explore.store.update(d => { d.pendingMeters.push({ idempotencyKey: 'queued', meter: 'bili.video.browsed' }); });
  bridge.started = true;
  try { await bridge.scheduler.trigger('explore-meter'); }
  finally { await bridge.stop(); }
  assert.equal(delivered.length, 1);
  assert.deepEqual(bridge.explore.store.data.pendingMeters, []);
  const task = bridge.scheduler.tasks.get('explore-meter');
  assert.equal(task.timer, null);
  await bridge.explore.store.update(d => { d.pendingMeters.push({ idempotencyKey: 'after-stop' }); });
  await task.run();
  assert.equal(delivered.length, 1);
  assert.equal(bridge.explore.store.data.pendingMeters.length, 1);
});

test('missing subtitles only records a diary and survives restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-empty-'));
  const opts = { dir, risk: { blocked: false }, api: { request: async () => ({ data: { list: { vlist: [{ bvid: 'BV0987654321', title: 'No captions' }] } } }) }, video: { context: async () => ({ subtitleText: '' }) }, generate: async () => { throw new Error('must not generate'); } };
  try {
    const watcher = new ExploreWatcher(opts); await watcher.load();
    await watcher.configure({ enabled: true, level: 1, acknowledged: true }); await watcher.poll(['123']);
    assert.equal(watcher.snapshot().journal[0].subtitleAvailable, false); assert.equal(watcher.snapshot().drafts.length, 0);
    const restarted = new ExploreWatcher(opts); await restarted.load(); await restarted.poll(['123']);
    assert.equal(restarted.snapshot().journal.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('late risk response from a disabled exploration cannot block the next run', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explore-late-risk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridge = new BiliBridge({ config: makeConfig({ dataDir: dir }) });
  await bridge.init(); bridge.started = true;
  t.after(() => bridge.stop());
  bridge.jar.set('SESSDATA', 'fake', { domain: 'bilibili.com' });
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  bridge.api.signer = { sign: async params => params, invalidate() {} };
  bridge.api.fetchImpl = async () => { entered(); await gate; return Response.json({ code: -352, data: { v_voucher: 'stale' } }); };
  await bridge.explore.configure({ enabled: true });
  const poll = bridge.explore.poll(['123']);
  await ready;
  await bridge.explore.configure({ enabled: false });
  release();
  const error = await poll.catch(error => error);
  assert.equal(bridge.risk.blocked, false);
  assert.equal(bridge.explore.snapshot().riskBlocked, false);
  assert.equal(error.kind, 'CANCELLED');
});
