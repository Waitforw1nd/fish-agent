import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoot, findByText, fire, flush, installDom, StubEvent } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';
import { mountLogin } from '../views/login.js';
import { mountTenants } from '../views/tenants.js';
import { mountHosting } from '../views/hosting.js';
import { mountRelay } from '../views/relay.js';
import { openQrFlow } from '../views/qr.js';
import { ApiError } from '../lib/api.js';

const METHODS = [
  'login', 'logout', 'me', 'listTenants', 'createTenant', 'getTenant',
  'startTenant', 'stopTenant', 'prepareQQ', 'startQQ', 'getQQQrcode', 'getQQStatus', 'getQQDrivers', 'refreshQQQrcode',
  'biliLoginQr', 'getBiliLoginStatus', 'getBiliStatus', 'getBiliConfig',
  'updateBiliConfig', 'getRelayOverview', 'getRelayModels', 'updateRelayKey'
];

function makeApi(handlers = {}) {
  const calls = [];
  const api = {};
  for (const method of METHODS) {
    api[method] = (...args) => {
      calls.push({ name: method, args });
      return Promise.resolve().then(() => (handlers[method] ? handlers[method](...args) : method === 'getQQDrivers' ? { defaultDriver: 'napcat', drivers: [{ id: 'llbot', label: 'LLBot', allowed: true, installed: true, available: true }, { id: 'napcat', label: 'NapCat', allowed: true, installed: true, available: true }] } : {}));
    };
  }
  return {
    api,
    calls,
    callsOf: (name) => calls.filter((call) => call.name === name),
    last: (name) => [...calls].reverse().find((call) => call.name === name)
  };
}

function makeToast() {
  const messages = [];
  return { show: (message, options) => messages.push({ message, options }), messages };
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await flush();
}

function setup() {
  const document = installDom();
  const { root, modalRoot } = appendRoot(document);
  return { document, root, modalRoot };
}

test('登录页校验、提交、密码显隐与 401 文案', async () => {
  const { root } = setup();
  let success = null;
  const toast = makeToast();
  const { api, calls } = makeApi({ login: async () => ({ user: { username: 'alice', role: 'admin' } }) });
  const view = mountLogin({ root, api, toast, onSuccess: (user) => { success = user; } });

  const form = root.querySelector('form');
  const username = root.querySelector('#login-username');
  const password = root.querySelector('#login-password');
  const toggle = root.querySelector('.password-toggle');
  assert.ok(form && username && password);
  assert.equal(password.type, 'password');

  form.dispatchEvent(new StubEvent('submit', { bubbles: true, cancelable: true }));
  await settle(1);
  assert.match(root.textContent, /请输入用户名/);
  assert.equal(calls.length, 0);

  toggle.click();
  assert.equal(password.type, 'text');
  assert.equal(toggle.textContent, '隐藏');

  username.value = '  alice  ';
  password.value = 'secret';
  form.dispatchEvent(new StubEvent('submit', { bubbles: true, cancelable: true }));
  await settle(3);
  assert.deepEqual(callsOfLogin(calls), [['alice', 'secret']]);
  assert.equal(success.username, 'alice');
  assert.equal(success.role, 'admin');
  view.destroy();
});

function callsOfLogin(calls) {
  return calls.filter((call) => call.name === 'login').map((call) => call.args);
}

test('登录失败显示内联错误且不回显密码', async () => {
  const { root } = setup();
  const { api } = makeApi({
    login: async () => { throw new ApiError(401, 'bad_credentials', 'invalid password secret-value'); }
  });
  const view = mountLogin({ root, api, toast: makeToast(), onSuccess: () => { throw new Error('不应成功'); } });
  root.querySelector('#login-username').value = 'alice';
  root.querySelector('#login-password').value = 'wrong-password';
  root.querySelector('form').dispatchEvent(new StubEvent('submit', { bubbles: true, cancelable: true }));
  await settle(3);
  const text = root.textContent;
  assert.match(text, /用户名或密码不正确/);
  assert.ok(!text.includes('wrong-password'));
  view.destroy();
});

test('租户总览加载、创建弹窗与跳转', async () => {
  const { root, modalRoot } = setup();
  const toast = makeToast();
  const tenants = [
    { id: 't1', name: '小鱼', status: 'running', expiresAt: '2026-11-20T00:00:00Z', qq: { phase: 'online' }, bili: { mid: '1' }, relay: { configured: true } },
    { id: 't2', name: '大鱼', status: 'stopped', expiresAt: '2026-10-29T00:00:00Z' }
  ];
  let navigated = '';
  let changed = null;
  const { api, calls } = makeApi({
    listTenants: async () => ({ tenants }),
    createTenant: async () => ({ tenant: { id: 't3', name: '新租户', slug: 'new-bot' } })
  });
  const view = mountTenants({
    root,
    api,
    toast,
    modalRoot,
    now: Date.parse('2026-10-28T00:00:00Z'),
    navigate: (hash) => { navigated = hash; },
    onTenantsChanged: (list) => { changed = list; }
  });
  await settle(4);
  assert.match(root.textContent, /小鱼/);
  assert.match(root.textContent, /大鱼/);
  assert.match(root.textContent, /租户总数/);
  assert.equal(changed.length, 2);

  const createButton = findByText(root, 'button', '创建租户');
  assert.ok(createButton);
  createButton.click();
  const nameInput = modalRoot.querySelector('#create-tenant-name');
  const slugInput = modalRoot.querySelector('#create-tenant-slug');
  assert.ok(nameInput && slugInput);
  nameInput.value = '新租户';
  slugInput.value = 'new-bot';
  const submit = findByText(modalRoot, 'button', '创建租户');
  assert.ok(submit);
  submit.click();
  await settle(6);

  assert.equal(callsOfCall(calls, 'createTenant').length, 1);
  assert.deepEqual(callsOfCall(calls, 'createTenant')[0].args[0], { name: '新租户', slug: 'new-bot' });
  assert.equal(navigated, '#/tenants/t3/hosting');
  assert.equal(modalRoot.querySelectorAll('.modal-backdrop').length, 0);
  assert.ok(toast.messages.some((item) => item.message.includes('租户已创建')));
  view.destroy();
});

function callsOfCall(calls, name) {
  return calls.filter((call) => call.name === name);
}

function tenantFixture() {
  return {
    id: 't1',
    name: '小鱼',
    slug: 'fish',
    status: 'running',
    plan: { name: 'Pro' },
    expiresAt: '2026-11-20T00:00:00Z',
    qq: { phase: 'online', loggedIn: true, uin: '10001', nickname: '小号', kernel: 'llbot', onebotConnected: true, versionAligned: true, authTokenStatus: 'ok' },
    bili: { loggedIn: true, mid: '42', nickname: 'UP', cookieHealthy: true, subscriptions: { mentions: false, upVideos: false, privateMessages: false, liveRooms: false } }
  };
}

test('Hosting 渲染状态、保存 B 站四类订阅、准备内核与启动托管', async () => {
  const { root, modalRoot } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const tenant = { ...tenantFixture(), status: 'stopped' };
  const { api, calls } = makeApi({
    getTenant: async () => ({ tenant }),
    getQQStatus: async () => ({ phase: 'online', loggedIn: true, uin: '10001', nickname: '小号', kernel: 'llbot', onebotConnected: true, versionAligned: true, authTokenStatus: 'ok' }),
    getBiliStatus: async () => tenant.bili,
    getBiliConfig: async () => ({ subscriptions: { mentions: false, upVideos: false, privateMessages: false, liveRooms: false } }),
    updateBiliConfig: async () => ({ ok: true }),
    prepareQQ: async () => ({ ok: true }),
    startTenant: async () => ({ tenant })
  });
  const view = mountHosting({
    root,
    api,
    tenantId: 't1',
    toast,
    modalRoot,
    timers,
    now: () => Date.parse('2026-10-28T00:00:00Z')
  });
  await settle(5);
  const text = root.textContent;
  assert.match(text, /QQ 内核托管/);
  assert.match(text, /B 站桥接/);
  assert.match(text, /小号/);
  assert.match(text, /UP/);
  assert.match(text, /在线/);

  const mentions = root.querySelector('input[name="bili-sub-mentions"]');
  assert.ok(mentions);
  mentions.checked = true;
  fire(mentions, 'change');
  const saveButton = findByText(root, 'button', '保存订阅设置');
  assert.equal(saveButton.disabled, false);
  saveButton.click();
  await settle(4);
  assert.equal(callsOfCall(calls, 'updateBiliConfig').length, 1);
  assert.deepEqual(callsOfCall(calls, 'updateBiliConfig')[0].args[1], {
    mentions: true, upVideos: false, privateMessages: false, liveRooms: false
  });

  const uinInput = root.querySelector('#qq-uin');
  assert.ok(uinInput);
  assert.equal(uinInput.value, '10001');

  const napcat = [...root.querySelectorAll('input[name="qq-kernel"]')].find((input) => input.value === 'napcat');
  assert.ok(napcat);
  assert.equal(napcat.disabled, true);
  const prepare = findByText(root, 'button', '准备内核');
  assert.equal(prepare.disabled, true);
  prepare.click();
  await settle(4);
  assert.equal(callsOfCall(calls, 'prepareQQ').length, 0);

  const startTenant = findByText(root, 'button', '启动托管');
  assert.ok(startTenant);
  startTenant.click();
  await settle(5);
  assert.equal(callsOfCall(calls, 'startTenant').length, 1);

  view.destroy();
  assert.equal(timers.pending() >= 0, true);
});

test('Relay 展示脱敏 Key、额度与按日账单，保存新 Key/模型', async () => {
  const { root } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const overview = {
    relay: {
      key: 'sk-supersecret-123456',
      configured: true,
      model: 'm1',
      baseUrl: 'https://upstream.example/v1',
      keyStatus: 'active',
      quota: {
        costLimitMicros: 10_000_000,
        costUsedMicros: 1_000_000,
        tokenLimit: 1_000_000,
        tokenUsed: 100_000,
        planName: 'Pro'
      },
      daily: [{
        date: '2026-10-28',
        models: [{
          model: 'model-a',
          promptTokens: 100,
          completionTokens: 50,
          cachedTokens: 20,
          visionTokens: 1,
          requests: 2,
          costMicros: 1234
        }],
        totals: { requests: 2, promptTokens: 100, completionTokens: 50, cachedTokens: 20, visionTokens: 1, totalTokens: 151, costMicros: 1234 }
      }],
      today: { requests: 2, promptTokens: 100, completionTokens: 50, cachedTokens: 20, visionTokens: 1, totalTokens: 151, costMicros: 1234 },
      total: { requests: 2, promptTokens: 100, completionTokens: 50, cachedTokens: 20, visionTokens: 1, totalTokens: 151, costMicros: 1234 }
    }
  };
  const { api, calls } = makeApi({
    getTenant: async () => ({ tenant: tenantFixture() }),
    getRelayOverview: async () => overview,
    getRelayModels: async () => ({ data: [{ id: 'm1', context_length: 128000 }, { id: 'm2' }] }),
    updateRelayKey: async () => ({ ok: true })
  });
  const view = mountRelay({
    root,
    api,
    tenantId: 't1',
    toast,
    timers,
    now: () => Date.parse('2026-10-28T12:00:00Z')
  });
  await settle(5);
  const text = root.textContent;
  assert.ok(!text.includes('sk-supersecret-123456'));
  assert.match(text, /sk-••••••3456/);
  assert.match(text, /model-a/);
  assert.match(text, /按日按模型账单/);
  assert.match(text, /云端权威账单/);
  assert.match(text, /¥0.0012/);
  assert.match(text, /UP 新视频|Prompt/);

  const keyInput = root.querySelector('#relay-key');
  const modelSelect = root.querySelector('#relay-model');
  assert.ok(keyInput && modelSelect);
  keyInput.value = 'new-secret-key';
  modelSelect.value = 'm2';
  fire(modelSelect, 'change');
  findByText(root, 'button', '保存 Key / 模型').click();
  await settle(6);
  assert.equal(callsOfCall(calls, 'updateRelayKey').length, 1);
  assert.deepEqual(callsOfCall(calls, 'updateRelayKey')[0].args[1], { key: 'new-secret-key', model: 'm2' });
  assert.equal(keyInput.value, '');
  view.destroy();
});

test('QQ 二次验证错误使用安全且可操作的提示', async () => {
  const { modalRoot } = setup();
  const { api } = makeApi({ getQQQrcode: async () => { throw new ApiError(502, 'NAPCAT_WEBUI_AUTH_FAILED', 'NapCat WebUI 启用了二次验证 token=fixture-secret'); } });
  const flow = openQrFlow({ modalRoot, api, tenantId: 't1', safeMessages: true, timers: createFakeTimers() });
  await settle();
  assert.match(modalRoot.textContent, /二次验证，请联系平台管理员/);
  assert.doesNotMatch(modalRoot.textContent, /fixture-secret/);
  flow.close();
});

test('QQ 扫码弹窗轮询成功后回调并自动关闭', async () => {
  const { document, modalRoot } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const confirmed = [];
  const dataUrl = `data:image/png;base64,${'A'.repeat(96)}`;
  const { api } = makeApi({
    getQQQrcode: async () => ({ qrcode: dataUrl, expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    getQQStatus: async () => ({ qq: { phase: 'online', runtimeState: 'ready', loginState: 'online', agentChannelState: 'disconnected', runtimeGeneration: 0, canChat: false, loggedIn: true, nickname: '小号', uin: '10001', expectedUin: '10001' } })
  });
  const flow = openQrFlow({
    modalRoot,
    api,
    tenantId: 't1',
    kind: 'qq',
    toast,
    timers,
    onConfirmed: (info) => confirmed.push(info)
  });
  await settle(4);
  const image = modalRoot.querySelector('img');
  assert.ok(image);
  assert.equal(image.src, dataUrl);
  assert.match(modalRoot.textContent, /等待扫码/);

  await timers.tick(0);
  await settle(4);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].nickname, '小号');
  assert.ok(toast.messages.some((item) => item.message.includes('QQ 登录成功')));
  assert.match(modalRoot.textContent, /登录成功/);

  await timers.tick(1300);
  assert.equal(modalRoot.querySelectorAll('.modal-backdrop').length, 0);
  flow.close();
  document.body.classList.remove('modal-open');
});

test('B 站扫码轮询状态 confirmed 后回调并显示绑定成功', async () => {
  const { modalRoot } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const confirmed = [];
  const dataUrl = `data:image/png;base64,${'B'.repeat(96)}`;
  const { api } = makeApi({
    biliLoginQr: async () => ({ image: dataUrl, expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    getBiliLoginStatus: async () => ({ status: 'success', user: { mid: '9', nickname: 'UP 主' } })
  });
  openQrFlow({
    modalRoot,
    api,
    tenantId: 't1',
    kind: 'bili',
    toast,
    timers,
    onConfirmed: (info) => confirmed.push(info)
  });
  await settle(4);
  await timers.tick(0);
  await settle(4);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].mid, '9');
  assert.equal(confirmed[0].nickname, 'UP 主');
  assert.ok(toast.messages.some((item) => item.message.includes('B 站绑定成功')));
  assert.match(modalRoot.textContent, /登录成功/);
  // 清理自动关闭定时器
  await timers.tick(1300);
});

test('Relay 无 Key 时选择模型保存，一次性展示平台签发的 Key 并在关闭后移除', async () => {
  const { root, modalRoot } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const overview = {
    relay: {
      configured: false,
      keyMasked: '',
      keyStatus: 'missing',
      model: 'm1',
      plan: { name: 'Trial', monthlyCreditMicros: 0 },
      quota: { planName: 'Trial', costLimitMicros: null, tokenLimit: null, rpm: 10, tpm: 50_000 },
      billing: { balanceMicros: 0, heldMicros: 0, availableMicros: 0, currency: 'CNY' },
      usage: { days: 30, totals: { requests: 0 }, today: { requests: 0 }, daily: [], byModel: [] }
    }
  };
  const { api, calls } = makeApi({
    getTenant: async () => ({ tenant: tenantFixture() }),
    getRelayOverview: async () => overview,
    getRelayModels: async () => ({ ok: true, models: [{ id: 'm1', allowed: true }], upstream: { ok: false, error: '上游未配置' } }),
    updateRelayKey: async () => ({ key: 'sk-issued-secret-123456', configured: true })
  });
  const view = mountRelay({
    root,
    api,
    tenantId: 't1',
    toast,
    modalRoot,
    timers,
    now: () => Date.parse('2026-10-28T12:00:00Z')
  });
  await settle(5);
  assert.match(root.textContent, /上游探测失败/);
  const save = findByText(root, 'button', '保存 Key / 模型');
  save.click();
  await settle(6);
  assert.equal(callsOfCall(calls, 'updateRelayKey').length, 1);
  assert.deepEqual(callsOfCall(calls, 'updateRelayKey')[0].args[1], { model: 'm1' });
  assert.match(modalRoot.textContent, /新的 Relay Key/);
  const issuedInput = modalRoot.querySelector('#issued-relay-key');
  assert.equal(issuedInput.value, 'sk-issued-secret-123456');
  findByText(modalRoot, 'button', '我已保存').click();
  assert.equal(modalRoot.querySelectorAll('.modal-backdrop').length, 0);
  assert.ok(!root.textContent.includes('sk-issued-secret-123456'));
  view.destroy();
});

test('QQ 启动请求透传 UIN，并在等待扫码时打开二维码', async () => {
  const { root, modalRoot } = setup();
  const timers = createFakeTimers();
  const toast = makeToast();
  const tenant = { ...tenantFixture(), status: 'running' };
  const png = `data:image/png;base64,${'C'.repeat(96)}`;
  const { api, calls } = makeApi({
    getTenant: async () => ({ tenant }),
    getQQStatus: async () => ({
      phase: 'waiting_login', running: true, kernel: 'llbot', expectedUin: '10001',
      loggedIn: false, qrAvailable: true, authTokenStatus: 'ok'
    }),
    getBiliStatus: async () => ({ phase: 'offline', loggedIn: false, subscriptions: {} }),
    getBiliConfig: async () => ({ subscriptions: { mentions: false, upVideos: false, privateMessages: false, liveRooms: false } }),
    startQQ: async () => ({ ok: true }),
    getQQQrcode: async () => ({ qrcode: png, expiresAt: new Date(Date.now() + 120_000).toISOString() })
  });
  const view = mountHosting({
    root,
    api,
    tenantId: 't1',
    toast,
    modalRoot,
    timers,
    now: () => Date.parse('2026-10-28T00:00:00Z')
  });
  await settle(5);
  const startQq = findByText(root, 'button', '继续扫码登录');
  assert.ok(startQq);
  startQq.click();
  await settle(6);
  assert.equal(callsOfCall(calls, 'startQQ').length, 0);
  assert.equal(callsOfCall(calls, 'prepareQQ').length, 0);
  assert.ok(modalRoot.querySelector('img') || modalRoot.querySelector('.modal-backdrop'));
  view.destroy();
});
