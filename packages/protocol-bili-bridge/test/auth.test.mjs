import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FakeBili } from './support/fake-bili.mjs';
import { tempDir, waitFor } from './support/helpers.mjs';
import { CookieJar } from '../src/bili/cookie-jar.js';
import { BiliApi } from '../src/bili/api.js';
import { WbiSigner } from '../src/bili/wbi.js';
import { RiskGuard } from '../src/bili/risk.js';
import { BiliAuth, QR_STATES } from '../src/bili/auth.js';
import { CookieRefresher, correspondPath, extractRefreshCsrf, COOKIE_REFRESH_PUBLIC_KEY } from '../src/bili/refresh.js';
import { ensureBuvid } from '../src/bili/buvid.js';
import { SecretStore } from '../src/store/secret-store.js';
import { FileLock, Mutex } from '../src/store/file-lock.js';

async function makeStack(fake, { dataDir = null } = {}) {
  const dir = dataDir || await tempDir();
  const now = () => Date.now();
  const jar = new CookieJar({ now });
  const secrets = await SecretStore.open({
    dir: path.join(dir, 'secrets'),
    aadPrefix: 'test-tenant',
    now
  });
  const api = new BiliApi({ endpoints: fake.endpoints(), jar, timeoutMs: 2000, now });
  const signer = new WbiSigner({ request: (args) => api.request(args), now });
  api.setSigner(signer);
  const risk = new RiskGuard({ now });
  api.setRisk(risk);
  const auth = new BiliAuth({ api, jar, secrets, now });
  return { dir, jar, secrets, api, signer, risk, auth, now };
}

async function login(stack, fake) {
  await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
  await stack.auth.generateQr();
  await stack.auth.pollQr(fake.qrKey);
  await stack.auth.pollQr(fake.qrKey);
  return stack.auth.pollQr(fake.qrKey);
}

test('CookieJar 域名/路径/Secure/过期与登录跳转 query', () => {
  let now = 1_000_000;
  const jar = new CookieJar({ now: () => now });
  jar.set('SESSDATA', 's1', { domain: 'bilibili.com', hostOnly: false, path: '/' });
  jar.set('hostonly', 'h1', { domain: 'api.bilibili.com', hostOnly: true, path: '/' });
  jar.set('secure', 'sec', { domain: 'bilibili.com', hostOnly: false, path: '/', secure: true });
  assert.equal(jar.get('SESSDATA', { url: 'https://api.bilibili.com/x' }), 's1');
  assert.equal(jar.get('hostonly', { url: 'https://api.bilibili.com/x' }), 'h1');
  assert.equal(jar.get('hostonly', { url: 'https://passport.bilibili.com/x' }), null);
  assert.equal(jar.get('secure', { url: 'http://api.bilibili.com/x' }), null);
  assert.match(jar.headerFor('https://api.bilibili.com/x'), /SESSDATA=s1/);
  assert.equal(jar.headerFor('https://evil.example/x'), '');

  jar.applySetCookie(['gone=1; Path=/; Max-Age=0'], 'https://api.bilibili.com/');
  assert.equal(jar.get('gone'), null);
  jar.set('expired', 'x', { domain: 'bilibili.com', expires: now - 1 });
  assert.equal(jar.get('expired'), null);
  now += 10_000;
  jar.set('short', 'x', { domain: 'bilibili.com', expires: now + 5 });
  assert.equal(jar.get('short'), 'x');
  now += 10;
  assert.equal(jar.get('short'), null);

  const applied = jar.setFromRedirectUrl('https://passport.biligame.com/crossDomain?SESSDATA=abc%2C123&bili_jct=j%2A&foo=bar');
  assert.deepEqual(applied, ['SESSDATA', 'bili_jct']);
  assert.equal(jar.get('SESSDATA'), 'abc%2C123');
  assert.equal(jar.get('bili_jct'), 'j%2A');
  assert.equal(jar.get('foo'), null);

  const publicSnapshot = jar.publicSnapshot();
  assert.ok(publicSnapshot.every((item) => item.present === true && !('value' in item)));
});

test('SecretStore AES-GCM 加密、篡改检测与错误密钥', async () => {
  const dir = await tempDir();
  const store = await SecretStore.open({ dir: path.join(dir, 'secrets'), now: () => Date.now() });
  await store.save('session', { cookies: { SESSDATA: 'super-secret-value' }, refreshToken: 'refresh-secret' });
  const loaded = await store.load('session');
  assert.equal(loaded.cookies.SESSDATA, 'super-secret-value');
  assert.deepEqual(await store.list(), ['session']);
  const file = path.join(dir, 'secrets', 'session.enc.json');
  const ciphertext = await fs.readFile(file, 'utf8');
  assert.equal(ciphertext.includes('super-secret-value'), false);
  assert.equal(ciphertext.includes('refresh-secret'), false);

  const tampered = JSON.parse(ciphertext);
  const raw = Buffer.from(tampered.data, 'base64');
  raw[0] ^= 0xff;
  tampered.data = raw.toString('base64');
  await fs.writeFile(file, JSON.stringify(tampered));
  await assert.rejects(() => store.load('session'), (error) => error.kind === 'SECRETS');

  const dir2 = await tempDir();
  const store2 = await SecretStore.open({
    dir: path.join(dir2, 'secrets'),
    key: crypto.randomBytes(32),
    now: () => Date.now()
  });
  await store2.save('session', { hello: 'world' });
  const store3 = await SecretStore.open({
    dir: path.join(dir2, 'secrets'),
    key: crypto.randomBytes(32),
    now: () => Date.now()
  });
  await assert.rejects(() => store3.load('session'), (error) => error.kind === 'SECRETS');
});

test('FileLock 跨实例互斥、超时与过期锁抢占', async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, 'account.lock');
  const first = new FileLock({ path: lockPath, timeoutMs: 300, staleMs: 60_000 });
  await first.acquire();
  const second = new FileLock({ path: lockPath, timeoutMs: 120, staleMs: 60_000 });
  await assert.rejects(() => second.acquire(), (error) => error.kind === 'LOCK');
  await first.release();
  await second.acquire();
  await second.release();

  const stalePath = path.join(dir, 'stale.lock');
  await fs.writeFile(stalePath, JSON.stringify({ token: 'old', pid: 1, createdAt: 1 }));
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(stalePath, old, old);
  const third = new FileLock({ path: stalePath, timeoutMs: 500, staleMs: 1000 });
  await third.acquire();
  assert.equal(third.held, true);
  await third.release();

  let ran = 0;
  const mutex = new Mutex();
  await Promise.all([mutex.run(async () => { await new Promise((r) => setTimeout(r, 20)); ran += 1; }), mutex.run(async () => { ran += 1; })]);
  assert.equal(ran, 2);
});

test('refresh_csrf 解析兼容官方 div 与旧赋值形态', () => {
  assert.equal(extractRefreshCsrf('<div id="1-name">b0cc8411ded2f9db2cff2edb3123acac</div>'), 'b0cc8411ded2f9db2cff2edb3123acac');
  assert.equal(extractRefreshCsrf(`<div class="x" id='1-name'>abc123</div>`), 'abc123');
  assert.equal(extractRefreshCsrf('<script>window.refresh_csrf = "xyz789";</script>'), 'xyz789');
  assert.equal(extractRefreshCsrf('<html></html>'), '');
});

test('cookie 保活公钥与官方 JWK 黄金值一致', () => {
  const jwk = crypto.createPublicKey(COOKIE_REFRESH_PUBLIC_KEY).export({ format: 'jwk' });
  assert.equal(
    jwk.n,
    'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE'
  );
  assert.equal(jwk.e, 'AQAB');
});

test('correspondPath 使用固定 RSA 公钥生成可解密 token', async () => {
  const fake = await FakeBili.start();
  try {
    const hex = correspondPath(1_700_000_000_000, fake.publicKey);
    assert.match(hex, /^[0-9a-f]+$/);
    const plain = crypto.privateDecrypt(
      { key: fake.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(hex, 'hex')
    ).toString('utf8');
    assert.equal(plain, 'refresh_1700000000000');
  } finally {
    await fake.close();
  }
});

test('扫码四状态、持久化与凭据不外泄', async () => {
  const fake = await FakeBili.start();
  try {
    const stack = await makeStack(fake);
    await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
    const first = await stack.auth.generateQr();
    assert.equal(first.state, QR_STATES.PENDING);
    assert.equal(first.qrcodeKey, fake.qrKey);
    assert.equal((await stack.auth.pollQr(fake.qrKey)).state, QR_STATES.PENDING);
    assert.equal((await stack.auth.pollQr(fake.qrKey)).state, QR_STATES.SCANNED);
    const success = await stack.auth.pollQr(fake.qrKey);
    assert.equal(success.state, QR_STATES.SUCCESS);
    assert.equal(stack.auth.loggedIn, true);
    assert.equal(stack.auth.account().mid, '10086');
    assert.equal(stack.auth.account().name, '测试UP主');
    assert.equal(stack.auth.session.refreshToken, 'refresh-initial');
    assert.equal(fake.loggedIn, true);

    const statusText = JSON.stringify(stack.auth.status());
    assert.equal(Object.hasOwn(stack.auth.status().qr || {}, 'qrcodeKey'), false);
    assert.equal(statusText.includes('sess-initial'), false);
    assert.equal(statusText.includes('jct-initial'), false);
    assert.equal(statusText.includes('refresh-initial'), false);

    const restarted = await makeStack(fake, { dataDir: stack.dir });
    await restarted.auth.load();
    assert.equal(restarted.auth.loggedIn, true);
    assert.equal(restarted.auth.account().mid, '10086');
    assert.equal(restarted.auth.status().qr.state, QR_STATES.SUCCESS);
  } finally {
    await fake.close();
  }
});

test('二维码过期不产生登录态', async () => {
  const fake = await FakeBili.start();
  fake.qrStatuses = ['expired'];
  try {
    const stack = await makeStack(fake);
    await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
    await stack.auth.generateQr();
    const expired = await stack.auth.pollQr(fake.qrKey);
    assert.equal(expired.state, QR_STATES.EXPIRED);
    assert.equal(stack.auth.loggedIn, false);
  } finally {
    await fake.close();
  }
});

test('四步 cookie 保活：顺序、轮换、持久化与 not_needed', async () => {
  const fake = await FakeBili.start();
  try {
    const stack = await makeStack(fake);
    await login(stack, fake);
    const refresher = new CookieRefresher({
      api: stack.api,
      auth: stack.auth,
      jar: stack.jar,
      lock: new FileLock({ path: path.join(stack.dir, 'account.lock'), timeoutMs: 2000 }),
      now: stack.now,
      publicKey: fake.publicKey
    });
    const oldSess = stack.jar.get('SESSDATA');
    const oldJct = stack.jar.get('bili_jct');
    fake.clearRequests();
    const result = await refresher.refresh();
    assert.equal(result.refreshed, true);
    assert.equal(fake.refreshCalls, 1);
    assert.equal(fake.confirmCount, 1);
    assert.notEqual(stack.jar.get('SESSDATA'), oldSess);
    assert.notEqual(stack.jar.get('bili_jct'), oldJct);
    assert.equal(stack.jar.get('SESSDATA'), 'sess-refreshed-1');
    assert.equal(stack.auth.loggedIn, true);
    assert.equal(stack.auth.session.refreshToken, 'refresh-rotated-1');
    assert.ok(stack.auth.session.refreshedAt > 0);
    assert.equal(refresher.snapshot().refreshCount, 1);

    const order = fake.requests.map((item) => item.path).filter((item) => (
      item.includes('/cookie/info') || item.startsWith('/correspond/1/') || item.includes('/cookie/refresh') || item.includes('/confirm/refresh')
    ));
    assert.equal(order.length, 4);
    assert.match(order[0], /cookie\/info/);
    assert.match(order[1], /^\/correspond\/1\//);
    assert.match(order[2], /cookie\/refresh/);
    assert.match(order[3], /confirm\/refresh/);

    const persisted = await stack.secrets.load('session');
    assert.equal(persisted.refreshToken, 'refresh-rotated-1');
    const encryptedFile = await fs.readFile(path.join(stack.dir, 'secrets', 'session.enc.json'), 'utf8');
    assert.equal(encryptedFile.includes('sess-refreshed-1'), false);
    assert.equal(encryptedFile.includes('refresh-rotated-1'), false);

    fake.refreshNeeded = false;
    fake.clearRequests();
    const skipped = await refresher.refresh();
    assert.equal(skipped.refreshed, false);
    assert.equal(skipped.reason, 'not_needed');
    assert.equal(fake.requests.filter((item) => item.path.startsWith('/correspond/1/')).length, 0);
  } finally {
    await fake.close();
  }
});

test('并发保活被 Mutex/FileLock 串行化', async () => {
  const fake = await FakeBili.start();
  try {
    const stack = await makeStack(fake);
    await login(stack, fake);
    const refresher = new CookieRefresher({
      api: stack.api,
      auth: stack.auth,
      jar: stack.jar,
      lock: new FileLock({ path: path.join(stack.dir, 'account.lock'), timeoutMs: 3000 }),
      now: stack.now,
      publicKey: fake.publicKey
    });
    const before = fake.refreshCalls;
    const results = await Promise.all([refresher.refresh(), refresher.refresh()]);
    assert.equal(results.every((item) => item.refreshed), true);
    assert.equal(fake.refreshCalls, before + 2);
    assert.equal(fake.confirmCount >= 2, true);
    assert.equal(stack.auth.loggedIn, true);
  } finally {
    await fake.close();
  }
});

test('保活失败时给出明确错误且不破坏旧凭据', async () => {
  const fake = await FakeBili.start();
  try {
    const stack = await makeStack(fake);
    await login(stack, fake);
    const oldSess = stack.jar.get('SESSDATA');
    const refresher = new CookieRefresher({
      api: stack.api,
      auth: stack.auth,
      jar: stack.jar,
      lock: new FileLock({ path: path.join(stack.dir, 'account.lock'), timeoutMs: 2000 }),
      now: stack.now,
      publicKey: fake.publicKey
    });
    fake.failNext('/x/passport-login/web/cookie/refresh', { code: -111, message: 'csrf 校验失败' });
    await assert.rejects(
      () => refresher.refresh(),
      (error) => String(error.wording || error.message).length > 0
    );
    assert.equal(stack.jar.get('SESSDATA'), oldSess);
    assert.equal(stack.auth.loggedIn, true);
  } finally {
    await fake.close();
  }
});


test('buvid 接口失败时本地回退，成功后复用 cookie', async () => {
  const fake = await FakeBili.start();
  try {
    fake.failNext('/x/frontend/finger/spi', { code: -500, status: 500, message: 'spi unavailable' });
    const stack = await makeStack(fake);
    const fallback = await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
    assert.equal(fallback.source, 'fallback');
    assert.match(fallback.buvid3, /infoc$/);
    assert.equal(stack.jar.get('buvid3'), fallback.buvid3);
    const reused = await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
    assert.equal(reused.source, 'cookie');
    assert.equal(reused.buvid3, fallback.buvid3);
  } finally {
    await fake.close();
  }
});

test('二维码在本地 TTL 到期时不再请求轮询接口', async () => {
  const fake = await FakeBili.start();
  try {
    const stack = await makeStack(fake);
    await ensureBuvid({ api: stack.api, jar: stack.jar, now: stack.now });
    await stack.auth.generateQr();
    stack.auth.qr.expiresAt = Date.now() - 1;
    const state = await stack.auth.pollQr(fake.qrKey);
    assert.equal(state.state, QR_STATES.EXPIRED);
    assert.equal(fake.count('/x/passport-login/web/qrcode/poll'), 0);
  } finally {
    await fake.close();
  }
});
