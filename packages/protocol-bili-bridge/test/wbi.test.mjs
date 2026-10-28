import test from 'node:test';
import assert from 'node:assert/strict';
import { getMixinKey, signWbi, WbiSigner, extractWbiKeys, MIXIN_KEY_ENC_TAB } from '../src/bili/wbi.js';
import { RiskGuard } from '../src/bili/risk.js';
import { BiliRiskError, BridgeError } from '../src/errors.js';

const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';

test('WBI mixin key 与官方黄金向量一致', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
  assert.equal(getMixinKey(IMG, SUB), 'ea1db124af3c7062474693fa704f4ff8');
  const signed = signWbi({ foo: '114', bar: '514', zab: 1919810 }, {
    imgKey: IMG,
    subKey: SUB,
    wts: 1702204169
  });
  assert.equal(signed.wts, '1702204169');
  assert.equal(signed.w_rid, '8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.equal(signed.foo, '114');
});

test('WBI 过滤禁用字符并跳过空值', () => {
  const signed = signWbi({ q: "a!'()*b", empty: null, undef: undefined, num: 0 }, {
    imgKey: IMG,
    subKey: SUB,
    wts: 1702204169
  });
  assert.equal(signed.q, 'ab');
  assert.equal(signed.num, '0');
  assert.equal(Object.hasOwn(signed, 'empty'), false);
  assert.equal(Object.hasOwn(signed, 'undef'), false);
});

test('extractWbiKeys 解析 nav 图片 URL', () => {
  const keys = extractWbiKeys({
    data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/abc.png', sub_url: '//i0.hdslb.com/bfs/wbi/def.webp?x=1' } }
  });
  assert.equal(keys.imgKey, 'abc');
  assert.equal(keys.subKey, 'def');
  assert.throws(() => extractWbiKeys({ data: {} }), /WBI/);
});

test('WbiSigner 缓存、失效与重新拉取', async () => {
  let calls = 0;
  const signer = new WbiSigner({
    now: () => 1_700_000_000_000,
    request: async () => {
      calls += 1;
      return { code: -101, data: { wbi_img: { img_url: `https://x/${IMG}.png`, sub_url: `https://x/${SUB}.png` } } };
    }
  });
  const keys = await signer.getKeys();
  assert.equal(keys.imgKey, IMG);
  assert.equal(calls, 1);
  await signer.getKeys();
  assert.equal(calls, 1);
  const signed = await signer.sign({ x: 1 }, { wts: 1702204169 });
  assert.equal(signed.w_rid, signWbi({ x: 1 }, { imgKey: IMG, subKey: SUB, wts: 1702204169 }).w_rid);
  signer.invalidate();
  await signer.getKeys();
  assert.equal(calls, 2);
  assert.equal(signer.snapshot().refreshes, 2);
});

test('RiskGuard 捕获 v_voucher 并明确标记需要人机验证', async () => {
  const calls = [];
  const guard = new RiskGuard({ now: () => 1000 });
  guard.setApi({
    request: async (args) => {
      calls.push(args);
      return { code: 0, data: { type: 'geetest', token: 'secret-challenge-token' } };
    }
  });
  const hit = guard.capture({ code: -352, data: { v_voucher: 'voucher-1' } }, { code: -352, url: '/x' });
  assert.equal(hit, true);
  assert.equal(guard.blocked, true);
  const challenge = await guard.exchange({ csrf: 'jct' });
  assert.equal(challenge.type, 'geetest');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/x/gaia-vgate/v1/register');
  assert.equal(calls[0].form.v_voucher, 'voucher-1');
  assert.throws(() => guard.assertNotBlocked(), (error) => error instanceof BridgeError && error.kind === 'RISK');
  const snapshot = guard.snapshot();
  assert.equal(snapshot.blocked, true);
  assert.equal(snapshot.type, 'geetest');
  assert.equal(JSON.stringify(snapshot).includes('secret-challenge-token'), false);
  guard.clear();
  assert.equal(guard.blocked, false);
  assert.doesNotThrow(() => guard.assertNotBlocked());
});

test('RiskGuard 在 -101 等非风控错误上不误触发', () => {
  const guard = new RiskGuard({ now: () => 1000 });
  assert.equal(guard.capture({ code: -101, data: {} }, { code: -101 }), false);
  assert.equal(guard.blocked, false);
});

test('WBI 签名 -403 时刷新密钥并安全重放一次', async () => {
  const { CookieJar } = await import('../src/bili/cookie-jar.js');
  const { BiliApi } = await import('../src/bili/api.js');
  let navCalls = 0;
  let targetCalls = 0;
  const response = (payload) => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  const api = new BiliApi({
    endpoints: { api: 'https://api.example.test' },
    jar: new CookieJar(),
    timeoutMs: 2000,
    fetchImpl: async (url) => {
      if (String(url).includes('/x/web-interface/nav')) {
        navCalls += 1;
        return response({
          code: -101,
          data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png` } }
        });
      }
      targetCalls += 1;
      return response(targetCalls === 1 ? { code: -403, message: 'wbi' } : { code: 0, data: { ok: 1 } });
    }
  });
  const signer = new WbiSigner({ request: (args) => api.request(args) });
  api.setSigner(signer);
  const data = await api.request({ method: 'GET', service: 'api', path: '/x/test', signed: true, retries: 0 });
  assert.deepEqual(data.data, { ok: 1 });
  assert.equal(targetCalls, 2);
  assert.equal(navCalls, 2);
});
