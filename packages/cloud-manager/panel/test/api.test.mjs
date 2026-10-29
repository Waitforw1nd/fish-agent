import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, createApi, unwrapPayload } from '../lib/api.js';

function jsonResponse(status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => body
  };
}

function textResponse(status, text, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => text
  };
}

function recorder(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (path, init) => {
      calls.push({ path, init });
      return handler(path, init);
    }
  };
}

test('login 使用 POST JSON 且 401 不触发会话过期回调', async () => {
  let authCalls = 0;
  const { fetchImpl, calls } = recorder(() => jsonResponse(401, { message: 'bad credentials' }));
  const api = createApi({ fetchImpl, onUnauthorized: () => { authCalls += 1; } });
  await assert.rejects(api.login('alice', 'secret'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'bad credentials');
    return true;
  });
  assert.equal(authCalls, 0);
  assert.equal(calls[0].path, '/api/auth/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'alice', password: 'secret' });
});

test('me 401 触发唯一一次未授权回调，并标记 auth expired', async () => {
  let authCalls = 0;
  const api = createApi({
    fetchImpl: async () => jsonResponse(401, { message: 'expired' }),
    onUnauthorized: () => { authCalls += 1; }
  });
  await assert.rejects(api.me(), (error) => {
    assert.equal(error.isAuthExpired, true);
    assert.equal(error.isSubscriptionExpired, false);
    return true;
  });
  assert.equal(authCalls, 1);
});

test('unwrapPayload 只解开明确的 envelope，不破坏 OpenAI 模型列表', () => {
  assert.deepEqual(unwrapPayload({ ok: true, data: { tenants: [] } }), { tenants: [] });
  assert.deepEqual(unwrapPayload({ success: true, data: 1, message: 'ok' }), 1);
  assert.deepEqual(unwrapPayload({ data: [1, 2], meta: { page: 1 } }), [1, 2]);
  const openai = { object: 'list', data: [{ id: 'm' }] };
  assert.equal(unwrapPayload(openai), openai);
  assert.deepEqual(unwrapPayload([1]), [1]);
});

test('所有面板端点使用约定方法与同源路径', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { ok: true, data: {} }));
  const api = createApi({ fetchImpl });
  await api.logout();
  await api.listTenants();
  await api.createTenant({ name: 'A', slug: 'a' });
  await api.getTenant('t 1/2');
  await api.startTenant('t 1/2');
  await api.stopTenant('t 1/2');
  await api.prepareQQ('t 1/2', { kernel: 'llbot', authToken: ' token-abc ', uin: ' 10001 ' });
  await api.startQQ('t 1/2', { kernel: 'napcat', uin: '10002' });
  await api.getQQQrcode('t 1/2');
  await api.getQQStatus('t 1/2');
  await api.biliLoginQr('t 1/2');
  await api.getBiliLoginStatus('t 1/2');
  await api.getBiliStatus('t 1/2');
  await api.getBiliConfig('t 1/2');
  await api.updateBiliConfig('t 1/2', { mentions: true, upVideos: false, privateMessages: 1, liveRooms: true });
  await api.getRelayOverview('t 1/2');
  await api.getRelayModels('t 1/2');
  await api.updateRelayKey('t 1/2', { key: ' sk-test ', model: ' m1 ' });

  const id = encodeURIComponent('t 1/2');
  const expected = [
    ['/api/auth/logout', 'POST'],
    ['/api/tenants', 'GET'],
    ['/api/tenants', 'POST'],
    [`/api/tenants/${id}`, 'GET'],
    [`/api/tenants/${id}/start`, 'POST'],
    [`/api/tenants/${id}/stop`, 'POST'],
    [`/api/tenants/${id}/qq/prepare`, 'POST'],
    [`/api/tenants/${id}/qq/start`, 'POST'],
    [`/api/tenants/${id}/qq/qrcode`, 'GET'],
    [`/api/tenants/${id}/qq/status`, 'GET'],
    [`/api/tenants/${id}/bili/login/qr`, 'POST'],
    [`/api/tenants/${id}/bili/login/status`, 'GET'],
    [`/api/tenants/${id}/bili/status`, 'GET'],
    [`/api/tenants/${id}/bili/config`, 'GET'],
    [`/api/tenants/${id}/bili/config`, 'PUT'],
    [`/api/tenants/${id}/relay/overview`, 'GET'],
    [`/api/tenants/${id}/relay/models`, 'GET'],
    [`/api/tenants/${id}/relay/key`, 'PUT']
  ];
  assert.equal(calls.length, expected.length);
  expected.forEach(([path, method], index) => {
    assert.equal(calls[index].path, path);
    assert.equal(calls[index].init.method, method);
  });

  assert.deepEqual(JSON.parse(calls[2].init.body), { name: 'A', slug: 'a' });
  assert.deepEqual(JSON.parse(calls[6].init.body), { kernel: 'llbot', uin: '10001' });
  assert.deepEqual(JSON.parse(calls[7].init.body), { kernel: 'napcat', uin: '10002' });
  assert.deepEqual(JSON.parse(calls[14].init.body), {
    subscriptions: { mentions: true, upVideos: false, privateMessages: true, liveRoom: true }
  });
  assert.deepEqual(JSON.parse(calls[17].init.body), { key: 'sk-test', model: 'm1' });
});

test('QQ prepare/start 未提供 uin 时保持原有请求体，不注入空字段', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { ok: true }));
  const api = createApi({ fetchImpl });
  await api.prepareQQ('t', { kernel: 'llbot', authToken: 'abc' });
  await api.startQQ('t', { kernel: 'llbot' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { kernel: 'llbot' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { kernel: 'llbot' });
});

test('QQ 驱动清单与刷新二维码的路径及 CSRF', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { ok: true }));
  const api = createApi({ fetchImpl }); api.setCsrfToken('csrf');
  await api.getQQDrivers(); await api.refreshQQQrcode('t/1', 7);
  assert.equal(calls[0].path, '/api/qq/drivers'); assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].path, '/api/tenants/t%2F1/qq/qrcode/refresh'); assert.equal(calls[1].init.method, 'POST'); assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(calls[1].init.body), { runtimeGeneration: 7 });
  await api.refreshQQQrcode('t/1');
  assert.deepEqual(JSON.parse(calls[2].init.body), { runtimeGeneration: null });
});

test('QQ 请求不透传运行参数或密钥', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { ok: true }));
  const api = createApi({ fetchImpl });
  await api.prepareQQ('t', { kernel: 'llbot', uin: '12345', mode: 'desktop', pmhqPort: '32001' });
  await api.startQQ('t', { kernel: 'llbot', mode: 'desktop', pmhqPort: '32001' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { kernel: 'llbot', uin: '12345' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { kernel: 'llbot' });
});

test('createTenant 省略空 slug；updateRelayKey 省略空字段', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse(200, { ok: true, data: {} }));
  const api = createApi({ fetchImpl });
  await api.createTenant({ name: 'Only Name', slug: '' });
  await api.updateRelayKey('t', { key: '', model: 'm' });
  await api.updateRelayKey('t', { key: 'k', model: '' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Only Name' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: 'm' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { key: 'k' });
});

test('402 标记订阅/额度过期并保留 Retry-After', async () => {
  const api = createApi({
    fetchImpl: async () => jsonResponse(402, {
      error: { code: 'subscription_expired', message: 'tenant expired' }
    }, { 'Retry-After': '12' })
  });
  await assert.rejects(api.startTenant('t'), (error) => {
    assert.equal(error.isSubscriptionExpired, true);
    assert.equal(error.code, 'subscription_expired');
    assert.equal(error.retryAfterMs, 12000);
    return true;
  });
});

test('HTTP 200 但 ok=false 也作为错误处理', async () => {
  const api = createApi({
    fetchImpl: async () => jsonResponse(200, { ok: false, code: 'conflict', message: 'slug already exists' })
  });
  await assert.rejects(api.createTenant({ name: 'A' }), (error) => {
    assert.equal(error.status, 200);
    assert.equal(error.code, 'conflict');
    assert.equal(error.message, 'slug already exists');
    return true;
  });
});

test('网络错误包装为 ApiError，AbortError 原样抛出', async () => {
  const network = createApi({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(network.me(), (error) => {
    assert.equal(error.isNetwork, true);
    assert.equal(error.status, 0);
    assert.match(error.message, /无法连接/);
    return true;
  });
  const original = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const aborted = createApi({ fetchImpl: async () => { throw original; } });
  await assert.rejects(aborted.me(), (error) => error === original);
});

test('错误消息脱敏，非 JSON 错误使用状态文案', async () => {
  const secretApi = createApi({
    fetchImpl: async () => jsonResponse(400, { message: 'bad token=supersecret123 for key sk-1234567890abcdef' })
  });
  await assert.rejects(secretApi.me(), (error) => {
    assert.ok(!error.message.includes('supersecret123'));
    assert.ok(!error.message.includes('sk-1234567890abcdef'));
    assert.match(error.message, /token=••••/);
    return true;
  });
  const textApi = createApi({ fetchImpl: async () => textResponse(502, 'Bad Gateway') });
  await assert.rejects(textApi.me(), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /暂时不可用/);
    return true;
  });
});

test('缺少租户 ID 与非法路径被拒绝', async () => {
  const api = createApi({ fetchImpl: async () => jsonResponse(200, {}) });
  assert.throws(() => api.getTenant(''), TypeError);
  await assert.rejects(api.request('https://evil.example/api/me'), TypeError);
});

test('登录/me 捕获 CSRF token 并在写操作发送，登出清除', async () => {
  const calls = [];
  const handler = (path) => {
    if (path === '/api/auth/login') return jsonResponse(200, { ok: true, user: { username: 'a' }, csrfToken: 'csrf-login' });
    if (path === '/api/me') return jsonResponse(200, { ok: true, user: { username: 'a' }, csrfToken: 'csrf-me' });
    if (path === '/api/auth/logout') return jsonResponse(200, { ok: true });
    return jsonResponse(200, { ok: true });
  };
  const api = createApi({
    fetchImpl: async (path, init) => {
      calls.push({ path, headers: init.headers });
      return handler(path);
    }
  });
  assert.equal(api.getCsrfToken(), '');
  await api.login('a', 'b');
  assert.equal(api.getCsrfToken(), 'csrf-login');
  await api.createTenant({ name: 'T' });
  assert.equal(calls[1].headers['X-CSRF-Token'], 'csrf-login');
  await api.me();
  assert.equal(api.getCsrfToken(), 'csrf-me');
  await api.startTenant('t');
  assert.equal(calls[3].headers['X-CSRF-Token'], 'csrf-me');
  await api.getTenant('t');
  assert.equal(calls[4].headers['X-CSRF-Token'], undefined);
  await api.logout();
  assert.equal(api.getCsrfToken(), '');
});
