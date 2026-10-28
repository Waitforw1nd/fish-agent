import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/api.js';
import { parseRoute, canAccessRoute, defaultRouteForUser } from '../lib/router.js';
import { normalizeRelayLogs, normalizeRecharges } from '../lib/user-data.js';
import { mountUserInstances } from '../views/user/instances.js';
import { mountUserInstance } from '../views/user/instance.js';
import { mountUserChannel } from '../views/user/channel.js';
import { mountUserLogs } from '../views/user/logs.js';
import { mountUserBilling } from '../views/user/billing.js';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';

const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
const setup = () => appendRoot(installDom());
const tenant = { id: 't1', name: '小鱼' };
const toast = { show() {} };

test('用户路由与角色访问限制', () => {
  for (const name of ['instances', 'channel', 'logs', 'billing']) {
    const route = parseRoute(`#/user/${name}`);
    assert.equal(canAccessRoute(route, { role: 'user' }), true);
    assert.equal(canAccessRoute(route, { role: 'admin' }), true);
  }
  assert.equal(canAccessRoute(parseRoute('#/tenants/t1/relay'), { role: 'user' }), false);
  assert.equal(canAccessRoute(parseRoute('#/tenants/t1/relay'), { role: 'admin' }), true);
  assert.equal(defaultRouteForUser({ role: 'user' }), '#/user/instances');
  assert.equal(parseRoute('#/user/instances/a%2Fb').tenantId, 'a/b');
  assert.equal(canAccessRoute(parseRoute('#/user/instances/a%2Fb'), { role: 'user' }), true);
  assert.equal(parseRoute('#/users/u%2F1/instances').userId, 'u/1');
  for (const path of ['#/users', '#/users/u%2F1/instances']) {
    assert.equal(canAccessRoute(parseRoute(path), { role: 'user' }), false);
    assert.equal(canAccessRoute(parseRoute(path), { role: 'admin' }), true);
  }
});

test('用户 API 路径、筛选、微元及 CSRF', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } };
  } });
  api.setCsrfToken('csrf');
  await api.getRelayCustom('t/1');
  await api.updateRelayCustom('t/1', { baseUrl: 'https://example.com/v1', apiKey: 'secret', model: 'm' });
  await api.deleteRelayCustom('t/1');
  await api.getRelayLogs('t/1', { days: 7, model: 'm x', status: 'error' });
  await api.getRecharges('t/1');
  await api.createRecharge('t/1', { amount: 12.34 });
  assert.deepEqual(calls.map(c => [c.init.method, c.path]), [
    ['GET', '/api/tenants/t%2F1/relay/custom'], ['PUT', '/api/tenants/t%2F1/relay/custom'],
    ['DELETE', '/api/tenants/t%2F1/relay/custom'], ['GET', '/api/tenants/t%2F1/relay/logs?days=7&model=m+x&status=error'],
    ['GET', '/api/tenants/t%2F1/billing/recharges'], ['POST', '/api/tenants/t%2F1/billing/recharges']
  ]);
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf');
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf');
  assert.equal(calls[5].init.headers['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(calls[5].init.body), { amountMicros: 12340000 });
  await api.getUsers(); await api.getUserTenants('u/1'); await api.createUser({ username: 'alice', password: 'password', role: 'user' });
  await api.createTenant({ name: 'fish', planId: 'pro', ownerUserId: 'u/1' });
  assert.deepEqual(calls.slice(6).map(c => [c.init.method, c.path]), [['GET', '/api/admin/users'], ['GET', '/api/admin/users/u%2F1/tenants'], ['POST', '/api/admin/users'], ['POST', '/api/tenants']]);
  assert.deepEqual(JSON.parse(calls[9].init.body), { name: 'fish', planId: 'pro', ownerUserId: 'u/1' });
});

test('后端日志和充值字段按实际单位及状态呈现', () => {
  const [log] = normalizeRelayLogs({ logs: [{ status: 201, cost: 123, latency: 45, tokens: 9 }] });
  assert.equal(log.status, 'success'); assert.equal(log.costMicros, 123); assert.equal(log.latencyMs, 45);
  assert.equal(normalizeRelayLogs({ logs: [{ status: 302 }] })[0].status, 'error');
  const result = normalizeRecharges({ wallet: { balanceMicros: 100, availableMicros: 0 }, recharges: [{ status: 'confirmed', confirmedAt: 123 }] });
  assert.equal(result.wallet.availableMicros, 0); assert.equal(result.recharges[0].statusLabel, '已到账'); assert.equal(result.recharges[0].reviewedAt, 123);
});

test('无实例统一引导，实例页支持启动并隐藏内核信息', async () => {
  for (const mount of [mountUserChannel, mountUserLogs, mountUserBilling]) {
    const { root } = setup(); const view = mount({ root, api: {}, tenants: [] });
    assert.match(root.textContent, /先创建一个实例/); view.destroy();
  }
  const { root } = setup(); let started = false;
  const api = { listTenants: async () => ({ tenants: [{ ...tenant, role: 'owner', status: 'stopped', consoleUrl: 'https://example.com', qq: { kernel: 'llbot' } }] }), startTenant: async () => { started = true; } };
  const view = mountUserInstances({ root, api, toast }); await settle();
  assert.ok(findByText(root, 'a', 'Bot 控制台')); assert.doesNotMatch(root.textContent, /llbot|QQ|Bili/i);
  findByText(root, 'button', '启动').click(); await settle(); assert.equal(started, true); view.destroy();
});

test('多实例卡片、套餐选项与实例上限', async () => {
  const { root, modalRoot } = setup(); let created;
  const api = { listTenants: async () => ({ tenants: [{ id: 't1', name: '鱼一', role: 'owner' }, { id: 't2', name: '鱼二', role: 'viewer' }] }), listPlans: async () => ({ plans: [{ id: 'trial', name: '试用', maxTenants: 1 }, { id: 'pro', name: '专业', maxTenants: 10 }] }), createTenant: async (body) => { created = body; } };
  const view = mountUserInstances({ root, modalRoot, api, toast }); await settle();
  assert.equal(root.querySelectorAll('.user-instance-card').length, 2);
  assert.equal(root.querySelectorAll('a').filter(a => a.getAttribute('href') === '#/user/instances/t2').length, 1);
  findByText(root, 'button', '创建实例').click(); await settle();
  assert.match(modalRoot.textContent, /最多拥有 1 个实例/);
  modalRoot.querySelector('#create-instance-name').value = '鱼三';
  modalRoot.querySelector('#create-instance-plan').value = 'pro';
  fire(modalRoot.querySelector('#create-instance-plan'), 'change');
  assert.match(modalRoot.textContent, /最多拥有 10 个实例/);
  findByText(modalRoot, 'button', '创建实例').click(); await settle();
  assert.deepEqual(created, { name: '鱼三', planId: 'pro' }); view.destroy();
});

test('实例详情按选中实例扫码，viewer 只读，卸载关闭弹窗', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  const api = {
    getTenant: async (id) => ({ tenant: { id, name: '第二条鱼', role: 'owner', status: 'stopped' }, role: 'owner' }),
    prepareQQ: async (id, body) => calls.push(['prepare', id, body]),
    startQQ: async (id, body) => calls.push(['start', id, body]),
    getQQQrcode: async (id) => { calls.push(['qr', id]); return { status: 'waiting' }; },
    getQQStatus: async () => ({ status: 'waiting_login' })
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't2', toast }); await settle();
  root.querySelector('#user-qq-uin').value = '123456';
  findByText(root, 'button', '扫码登录 QQ').click(); await settle();
  assert.deepEqual(calls.slice(0, 3), [['prepare', 't2', { kernel: 'llbot', uin: '123456' }], ['start', 't2', { kernel: 'llbot', uin: '123456' }], ['qr', 't2']]);
  assert.doesNotMatch(root.textContent + modalRoot.textContent, /llbot|OneBot|token|端口/i);
  view.destroy(); assert.equal(modalRoot.textContent, '');
  const other = setup();
  const readonly = mountUserInstance({ ...other, tenantId: 't3', toast, api: { getTenant: async () => ({ tenant: { id: 't3', name: '只读', role: 'viewer' }, role: 'viewer' }) } });
  await settle(); assert.equal(findByText(other.root, 'button', '扫码登录 QQ'), null); assert.equal(findByText(other.root, 'button', '启动实例'), null); readonly.destroy();
});

test('详情读取真实形状的 QQ 状态，定时刷新并在卸载后停止', async () => {
  const { root, modalRoot } = setup();
  const timers = createFakeTimers(); let calls = 0; let release;
  const api = {
    getTenant: async () => ({ ok: true, tenant: { id: 't1', name: '小鱼', role: 'owner', qq: { phase: 'stopped' } }, qq: { phase: 'stopped' }, role: 'owner' }),
    getQQStatus: async (id) => { assert.equal(id, 't1'); calls++; if (calls === 1) return { ok: true, qq: { state: 'awaiting_login', running: true } }; if (calls === 2) return { ok: true, qq: { state: 'online', loggedIn: true } }; return new Promise(resolve => { release = resolve; }); }
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers, visibility: { isHidden: () => false, subscribe: () => () => {} } });
  await settle(); assert.match(root.textContent, /状态：已停止/);
  await timers.tick(0); assert.match(root.textContent, /状态：等待扫码/);
  const input = root.querySelector('#user-qq-uin'); input.value = '123456';
  await timers.tick(5000); assert.match(root.textContent, /状态：在线/); assert.equal(input.value, '123456');
  await timers.tick(5000); assert.equal(calls, 3); view.destroy(); release({ qq: { state: 'stopped' } }); await settle();
  await timers.tick(20000); assert.equal(calls, 3); assert.equal(root.textContent, ''); assert.equal(timers.pending(), 0);
});

test('扫码确认后主动刷新实际 QQ 状态', async () => {
  const { root, modalRoot } = setup(); const timers = createFakeTimers(); let calls = 0;
  const api = {
    getTenant: async () => ({ tenant: { id: 't1', name: '小鱼', role: 'owner', qq: { phase: 'stopped' } }, role: 'owner' }),
    getQQStatus: async () => ({ qq: { state: ++calls === 1 ? 'stopped' : 'online', loggedIn: calls > 1 } }),
    prepareQQ: async () => {}, startQQ: async () => {}, getQQQrcode: async () => ({ status: 'confirmed' })
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle(); await timers.tick(0); assert.match(root.textContent, /状态：已停止/);
  root.querySelector('#user-qq-uin').value = '123456'; findByText(root, 'button', '扫码登录 QQ').click(); await settle();
  assert.equal(calls, 2); assert.match(root.textContent, /状态：在线/); view.destroy();
});

test('切换实例忽略旧准备响应及二维码请求，缺失实例不回退', async () => {
  const { root, modalRoot } = setup();
  let releasePrepare, releaseQr;
  const calls = [];
  const timers = createFakeTimers();
  const api = {
    getTenant: async (id) => ({ tenant: { id, name: id, role: 'owner' }, role: 'owner' }),
    prepareQQ: (id) => { calls.push(['prepare', id]); return id === 't1' ? new Promise(resolve => { releasePrepare = resolve; }) : Promise.resolve(); },
    startQQ: async (id) => calls.push(['start', id]),
    getQQQrcode: (id) => { calls.push(['qr', id]); return new Promise(resolve => { releaseQr = resolve; }); },
    getQQStatus: async (id) => { calls.push(['status', id]); return {}; }
  };
  const first = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers }); await settle();
  root.querySelector('#user-qq-uin').value = '123456'; findByText(root, 'button', '扫码登录 QQ').click(); await settle();
  first.destroy();
  const second = mountUserInstance({ root, modalRoot, api, tenantId: 't2', toast, timers }); await settle();
  releasePrepare(); await settle();
  assert.deepEqual(calls, [['prepare', 't1']]);
  root.querySelector('#user-qq-uin').value = '123456'; findByText(root, 'button', '扫码登录 QQ').click(); await settle();
  second.destroy(); releaseQr({ status: 'waiting', imageDataUrl: 'data:image/png;base64,AA==' }); await settle();
  assert.equal(modalRoot.textContent, ''); assert.deepEqual(calls, [['prepare', 't1'], ['prepare', 't2'], ['start', 't2'], ['qr', 't2']]);
  let accessed = false;
  const missing = mountUserChannel({ root, tenantId: 'missing', tenants: [{ id: 't1', name: '鱼一', role: 'owner' }], api: { getRelayOverview: async () => { accessed = true; } } });
  await settle(); assert.equal(accessed, false); assert.match(root.textContent, /所选实例不可用/); missing.destroy();
});

test('渠道保存只写密钥，日志筛选和充值提交', async () => {
  {
    const { root } = setup(); let saved;
    const api = { getRelayOverview: async () => ({ configured: false }), getRelayCustom: async () => ({ configured: false }), updateRelayCustom: async (_id, data) => { saved = data; return { configured: true, hasKey: true, baseUrl: data.baseUrl, model: data.model }; } };
    const view = mountUserChannel({ root, api, toast, tenants: [tenant] }); await settle();
    root.querySelector('#custom-base-url').value = 'https://example.com/v1'; root.querySelector('#custom-api-key').value = 'secret'; root.querySelector('#custom-model').value = 'm';
    findByText(root, 'button', '保存配置').click(); await settle();
    assert.equal(saved.apiKey, 'secret'); assert.equal(root.querySelector('#custom-api-key').value, ''); assert.doesNotMatch(root.textContent, /secret/); assert.match(root.textContent, /未测试/); view.destroy();
  }
  {
    const { root } = setup(); let filters;
    const api = { getRelayLogs: async (_id, f) => { filters = f; return { logs: [{ status: 200, model: 'model1', tokens: 4, cost: 100, latency: 10, source: 'custom' }] }; } };
    const view = mountUserLogs({ root, api, toast, tenants: [tenant] }); await settle();
    root.querySelector('#log-model').value = 'model1'; fire(root.querySelector('form'), 'submit'); await settle();
    assert.equal(filters.model, 'model1'); assert.match(root.textContent, /model1/); assert.match(root.textContent, /custom/); view.destroy();
  }
  {
    const { root } = setup(); let amount;
    const api = { getRecharges: async () => ({ recharges: [{ id: 'r1', status: 'pending', amountMicros: 5000000 }] }), getRelayOverview: async () => ({ wallet: { balanceMicros: 1000000, availableMicros: 1000000 } }), createRecharge: async (_id, body) => { amount = body.amount; } };
    const view = mountUserBilling({ root, api, toast, tenants: [tenant] }); await settle();
    assert.match(root.textContent, /待管理员审核/); assert.match(root.textContent, /1\.00/);
    root.querySelector('#recharge-amount').value = '5'; fire(root.querySelector('form'), 'submit'); await settle(); assert.equal(amount, 5); view.destroy();
  }
});
