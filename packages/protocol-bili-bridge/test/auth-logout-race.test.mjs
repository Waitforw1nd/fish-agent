import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBili } from './support/fake-bili.mjs';
import { CookieJar } from '../src/bili/cookie-jar.js';
import { BiliApi } from '../src/bili/api.js';
import { BiliAuth } from '../src/bili/auth.js';
import { CookieRefresher } from '../src/bili/refresh.js';
import { BiliBridge } from '../src/bridge.js';

test('session validation cannot report stale login or overwrite state after logout', async () => {
  const jar = new CookieJar();
  jar.set('SESSDATA', 'old');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const api = new BiliApi({ jar, fetchImpl: async () => {
    entered(); await gate;
    return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1 } }));
  } });
  const auth = new BiliAuth({ api, jar });
  const old = auth.ensureSession().then(value => ({ value }), error => ({ error }));
  await started;
  await auth.logout();
  release();
  const result = await old;
  assert.equal(auth.status().lastError, null);
  assert.equal(result.error?.kind, 'CANCELLED');
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.lastError, '');
});

test('logout revokes in-flight ordinary, QR and refresh responses without preventing a new login', async t => {
  for (const stage of ['ordinary', 'qr', 'refresh-write', 'refresh-confirm']) for (const reloginBeforeResponse of [false, true]) {
    const fake = await FakeBili.start();
    t.after(() => fake.close());
    const jar = new CookieJar(), saved = new Map();
    const secrets = { load: async key => saved.get(key), save: async (key, value) => saved.set(key, structuredClone(value)), delete: async key => saved.delete(key) };
    let target = '', release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const api = new BiliApi({ endpoints: fake.endpoints(), jar, fetchImpl: async (url, options) => {
      let response = await fetch(url, options);
      if (target && new URL(url).pathname === target) {
        if (stage === 'ordinary') {
          const headers = new Headers(response.headers);
          headers.append('set-cookie', 'SESSDATA=stale-ordinary; Path=/');
          response = new Response(response.body, { status: response.status, headers });
        }
        target = ''; entered(); await gate;
      }
      return response;
    } });
    const auth = new BiliAuth({ api, jar, secrets });
    const login = async () => { fake.qrIndex = 0; await auth.generateQr(); await auth.pollQr(fake.qrKey); await auth.pollQr(fake.qrKey); await auth.pollQr(fake.qrKey); };
    let operation;
    if (stage === 'qr') {
      await auth.generateQr(); await auth.pollQr(fake.qrKey); await auth.pollQr(fake.qrKey);
      target = '/x/passport-login/web/qrcode/poll';
      operation = auth.pollQr(fake.qrKey);
    } else {
      await login();
      if (stage === 'ordinary') {
        target = '/x/web-interface/nav';
        operation = auth.getSelfInfo({ refresh: true });
      } else {
        target = stage === 'refresh-write' ? '/x/passport-login/web/cookie/refresh' : '/x/passport-login/web/confirm/refresh';
        operation = new CookieRefresher({ api, auth, jar, publicKey: fake.publicKey }).refresh();
      }
    }
    const finished = operation.then(value => ({ value }), error => ({ error }));
    await started; await auth.logout();
    if (reloginBeforeResponse) await login();
    release();
    const result = await finished;
    assert.equal(result.error?.kind, 'CANCELLED', stage);
    if (!reloginBeforeResponse) {
      assert.equal(auth.loggedIn, false, stage);
      assert.equal(jar.get('SESSDATA'), null, stage);
      assert.equal(auth.session, null, stage);
      assert.equal(saved.has('session'), false, stage);
      assert.equal(saved.has('qr'), false, stage);
      await login();
    }
    assert.equal(auth.loggedIn, true, stage + ' new login');
    assert.equal(saved.has('session'), true, stage + ' new login');
    assert.equal(jar.get('SESSDATA'), fake.session.sessdata, stage + ' new login cookie');
  }
});

test('replacing a QR invalidates cookies from its old in-flight poll', async t => {
  const fake = await FakeBili.start();
  t.after(() => fake.close());
  const jar = new CookieJar();
  let release, entered, hold = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const api = new BiliApi({ endpoints: fake.endpoints(), jar, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (hold && new URL(url).pathname.endsWith('/qrcode/poll')) { hold = false; entered(); await gate; }
    return response;
  } });
  const auth = new BiliAuth({ api, jar });
  await auth.generateQr(); await auth.pollQr(fake.qrKey); await auth.pollQr(fake.qrKey);
  hold = true;
  const old = auth.pollQr(fake.qrKey).then(() => null, error => error);
  await started; await auth.generateQr(); release();
  assert.equal((await old)?.kind, 'CANCELLED');
  assert.equal(jar.get('SESSDATA'), null);
  assert.equal(auth.qr.state, 'pending');
});

test('a late QR generation cannot replace a newer request or its persisted state', async () => {
  const jar = new CookieJar();
  const saved = new Map();
  const secrets = { save: async (key, value) => saved.set(key, structuredClone(value)) };
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const api = new BiliApi({ jar, fetchImpl: async () => {
    const call = ++calls;
    if (call === 1) { entered(); await gate; }
    return new Response(JSON.stringify({ code: 0, data: { url: `https://example.test/${call}`, qrcode_key: `key${call}` } }), { headers: { 'content-type': 'application/json' } });
  } });
  const auth = new BiliAuth({ api, jar, secrets });
  const old = auth.generateQr().then(() => null, error => error);
  await started;
  assert.equal((await auth.generateQr()).qrcodeKey, 'key2');
  release();
  assert.equal((await old)?.kind, 'CANCELLED');
  assert.equal(auth.qrState().qrcodeKey, 'key2');
  assert.equal(saved.get('qr').qrcodeKey, 'key2');
});

test('logout while initializing buvid cannot start a late QR or restore device cookies', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const jar = new CookieJar();
  let generated = 0;
  const bridge = { jar, now: Date.now, logger: { warn() {} },
    api: { request: async () => { entered(); await gate; return { data: { b_3: 'a'.repeat(32), b_4: 'b'.repeat(32) } }; } },
    auth: { generateQr: async () => { generated++; } } };
  const old = BiliBridge.prototype.createQr.call(bridge).then(() => null, error => error);
  await started;
  jar.clear();
  release();
  assert.equal((await old)?.kind, 'CANCELLED');
  assert.equal(generated, 0);
  assert.equal(jar.get('buvid3'), null);
});

test('bridge logout revokes old requests before waiting for live clients to stop', async () => {
  const jar = new CookieJar();
  jar.set('SESSDATA', 'old');
  let releaseFetch, fetchEntered, releaseStop, stopEntered;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const fetchStarted = new Promise(resolve => { fetchEntered = resolve; });
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const stopStarted = new Promise(resolve => { stopEntered = resolve; });
  const api = new BiliApi({ jar, fetchImpl: async () => {
    fetchEntered(); await fetchGate;
    return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1 } }), {
      headers: { 'set-cookie': 'SESSDATA=stale; Path=/' }
    });
  } });
  const auth = new BiliAuth({ api, jar });
  const bridge = { auth, jar, liveClients: new Map(), stopAllLiveClients: async () => { stopEntered(); await stopGate; } };
  const old = auth.getSelfInfo({ refresh: true }).then(() => null, error => error);
  await fetchStarted;
  const logout = BiliBridge.prototype.logout.call(bridge);
  await stopStarted;
  releaseFetch();
  try {
    assert.equal((await old)?.kind, 'CANCELLED');
    assert.equal(auth.loggedIn, false);
    assert.equal(jar.get('SESSDATA'), null);
  } finally { releaseStop(); await logout; }
});

test('logout prevents an in-flight live sync from starting an old-session client', async () => {
  const { Mutex } = await import('../src/store/file-lock.js');
  const jar = new CookieJar(); jar.set('SESSDATA', 'old');
  const auth = new BiliAuth({ api: {}, jar });
  let release, entered, creates = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const bridge = { jar, auth, started: true, liveSyncMutex: new Mutex(), liveClients: new Map(), liveInfos: new Map(), liveStats: new Map(),
    getSubscriptions: () => ({ live: true }), getWatches: () => ({ liveRooms: ['1'] }),
    liveService: { info: async () => { entered(); await gate; return { roomId: '1' }; }, createClient: () => { creates++; throw new Error('must not create'); } },
    mapping: { groupForLive: async () => ({}) }, logger: { warn() {} }, config: { live: {} },
    stopAllLiveClients: BiliBridge.prototype.stopAllLiveClients };
  const sync = BiliBridge.prototype.syncLiveRooms.call(bridge);
  await started;
  const logout = BiliBridge.prototype.logout.call(bridge);
  release(); await Promise.all([sync, logout]);
  assert.equal(creates, 0);
  assert.equal(bridge.liveClients.size, 0);
  assert.equal(auth.loggedIn, false);
});

test('logout cleanup cannot erase a newer login or its live client and tolerates stop errors', async () => {
  const jar = new CookieJar(); jar.set('SESSDATA', 'old');
  const auth = new BiliAuth({ api: {}, jar });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const old = { client: { stop: async () => { entered(); await gate; throw new Error('stop failed'); } } };
  const bridge = { auth, jar, liveClients: new Map([['1', old]]), liveInfos: new Map([['1', {}]]), liveStats: new Map([['1', {}]]),
    stopAllLiveClients: BiliBridge.prototype.stopAllLiveClients, selfId: 1, selfMid: '1', selfName: 'old' };
  const logout = BiliBridge.prototype.logout.call(bridge);
  await started;
  assert.equal(jar.get('SESSDATA'), null);
  jar.set('SESSDATA', 'new');
  bridge.selfId = 2; bridge.selfMid = '2'; bridge.selfName = 'new';
  const next = { client: {} }; bridge.liveClients.set('1', next); bridge.liveInfos.set('1', { fresh: true }); bridge.liveStats.set('1', { fresh: true });
  release(); const status = await logout;
  assert.equal(status.loggedIn, true);
  assert.equal(jar.get('SESSDATA'), 'new');
  assert.equal(bridge.selfId, 2);
  assert.equal(bridge.liveClients.get('1'), next);
  assert.equal(bridge.liveStats.get('1').fresh, true);
});

test('logout reports sanitized persistence failure after cleaning clients and supports retry', async () => {
  const jar = new CookieJar(); jar.set('SESSDATA', 'old');
  const calls = [], saved = new Set(['session', 'qr']);
  let fail = true, stopped = false;
  let releaseStop;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const secrets = { delete: async name => { calls.push(name); if (fail && name === 'session') throw new Error('secret-cookie C:/private/path'); saved.delete(name); } };
  const auth = new BiliAuth({ api: {}, jar, secrets });
  const bridge = { auth, jar, liveClients: new Map([['1', { client: { stop: async () => { await stopGate; stopped = true; throw new Error('stop failed'); } } }]]),
    liveInfos: new Map(), liveStats: new Map(), stopAllLiveClients: BiliBridge.prototype.stopAllLiveClients };
  let settled = false;
  const result = BiliBridge.prototype.logout.call(bridge).then(() => null, error => error).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'logout must await live cleanup even when persistence failed');
  releaseStop();
  const error = await result;
  assert.equal(error?.kind, 'SECRETS');
  assert.doesNotMatch(String(error?.stack), /secret-cookie|C:\/private\/path/);
  assert.deepEqual(calls, ['session', 'qr']);
  assert.equal(stopped, true);
  assert.equal(jar.get('SESSDATA'), null);
  assert.equal(auth.loggedIn, false);
  assert.equal(saved.has('session'), true);
  assert.equal(saved.has('qr'), false);
  fail = false;
  const status = await BiliBridge.prototype.logout.call(bridge);
  assert.equal(status.loggedIn, false);
  assert.deepEqual(calls, ['session', 'qr', 'session', 'qr']);
  assert.equal(saved.size, 0);
});
