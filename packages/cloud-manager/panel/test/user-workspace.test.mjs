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

const driverList = { defaultDriver: 'napcat', drivers: [
  { id: 'llbot', label: 'LLBot', allowed: true, installed: true, available: true, capabilities: {} },
  { id: 'napcat', label: 'NapCat', allowed: true, installed: true, available: true, capabilities: { qrcodeRefresh: true } }
] };

test('二维码刷新使用 POST 并丢弃先前请求，运行代次不匹配不显示二维码', async () => {
  const { root, modalRoot } = setup(); const timers = createFakeTimers(); let firstResolve, reads = 0, refreshes = 0;
  const api = { getTenant: async () => ({ tenant: { id: 't', role: 'owner', status: 'running' }, role: 'owner' }), getQQDrivers: async () => driverList,
    getQQStatus: async () => ({ kernel: 'napcat', runtimeState: 'ready', loginState: 'waiting_qr', expectedUin: '123456', runtimeGeneration: 2 }),
    getQQQrcode: () => ++reads === 1 ? new Promise(resolve => { firstResolve = resolve; }) : Promise.resolve({ status: 'ready', runtimeGeneration: 2, qrGeneration: 2, imageDataUrl: 'data:image/png;base64,QkI=' }),
    refreshQQQrcode: async (_id, generation) => { assert.equal(generation, 2); refreshes++; return { status: 'ready', runtimeGeneration: 3, qrGeneration: 1, imageDataUrl: 'data:image/png;base64,Q0M=' }; } };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't', toast, timers }); await settle();
  findByText(root, 'button', '继续扫码登录').click(); await settle();
  findByText(root, 'button', '继续扫码登录').click(); await settle();
  assert.match(modalRoot.querySelector('img').src, /QkI=/);
  firstResolve({ status: 'ready', runtimeGeneration: 1, imageDataUrl: 'data:image/png;base64,QUE=' }); await settle();
  assert.match(modalRoot.querySelector('img').src, /QkI=/);
  findByText(modalRoot, 'button', '获取新二维码').click(); await settle(); assert.equal(refreshes, 1);
  assert.match(modalRoot.querySelector('img').src, /Q0M=/);
  assert.equal(modalRoot.querySelector('.qr-countdown').textContent, ''); view.destroy();
});

test('旧实例保留内核并重复扫码不重启，viewer 与到期只读', async () => {
  const { root, modalRoot } = setup(); const calls = []; const timers = createFakeTimers();
  const api = {
    getTenant: async id => ({ tenant: { id, role: 'owner', status: 'running' }, role: 'owner' }),
    getQQDrivers: async () => driverList,
    getQQStatus: async () => ({ kernel: 'llbot', runtimeState: 'ready', loginState: 'waiting_qr', expectedUin: '123456', runtimeGeneration: 1 }),
    prepareQQ: async () => calls.push('prepare'), startQQ: async () => calls.push('start'),
    getQQQrcode: async () => { calls.push('qr'); return { status: 'pending', runtimeGeneration: 1 }; }
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't2', toast, timers }); await settle();
  assert.equal(root.querySelector('#user-qq-driver').value, 'llbot');
  assert.match(root.textContent, /运行环境：ready.*QQ 登录：waiting_qr.*Agent 通道：unknown/);
  findByText(root, 'button', '继续扫码登录').click(); await settle();
  assert.deepEqual(calls, ['qr']); view.destroy(); assert.equal(modalRoot.textContent, '');
  const other = setup();
  const readonly = mountUserInstance({ ...other, tenantId: 't3', toast, timers, api: { ...api, getTenant: async () => ({ tenant: { id: 't3', role: 'viewer', status: 'running' }, role: 'viewer' }) } });
  await settle(); assert.equal(findByText(other.root, 'button', '继续扫码登录'), null); readonly.destroy();
  const expired = setup();
  const expiredView = mountUserInstance({ ...expired, tenantId: 't4', toast, timers, api: { ...api, getTenant: async () => ({ tenant: { id: 't4', role: 'owner', status: 'running', expiresAt: '2000-01-01' }, role: 'owner' }) } });
  await settle(); assert.equal(findByText(expired.root, 'button', '继续扫码登录').disabled, true); expiredView.destroy();
});

test('新实例使用平台默认，不可用内核显示原因并阻止启动', async () => {
  const { root, modalRoot } = setup(); const timers = createFakeTimers(); let writes = 0;
  const api = { getTenant: async () => ({ tenant: { id: 't1', status: 'running', role: 'owner' }, role: 'owner' }), getQQStatus: async () => ({}),
    getQQDrivers: async () => ({ ...driverList, drivers: [driverList.drivers[0], { ...driverList.drivers[1], available: false, reason: '镜像未安装' }] }),
    prepareQQ: async () => writes++, startQQ: async () => writes++ };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers }); await settle();
  assert.equal(root.querySelector('#user-qq-driver').value, 'napcat'); assert.match(root.textContent, /镜像未安装/);
  assert.equal(findByText(root, 'button', '扫码登录 QQ').disabled, true); assert.equal(writes, 0); view.destroy();
});

test('切换实例丢弃旧准备及二维码响应', async () => {
  const { root, modalRoot } = setup(); const timers = createFakeTimers(); let releasePrepare, releaseQr; const calls = [];
  const api = { getTenant: async id => ({ tenant: { id, role: 'owner', status: 'running' }, role: 'owner' }), getQQDrivers: async () => driverList,
    getQQStatus: async () => ({}), prepareQQ: id => { calls.push(['prepare', id]); return id === 't1' ? new Promise(resolve => { releasePrepare = resolve; }) : Promise.resolve(); },
    startQQ: async id => calls.push(['start', id]), getQQQrcode: id => { calls.push(['qr', id]); return new Promise(resolve => { releaseQr = resolve; }); } };
  const first = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers }); await settle();
  root.querySelector('#user-qq-uin').value = '123456'; findByText(root, 'button', '扫码登录 QQ').click(); await settle(); first.destroy();
  const second = mountUserInstance({ root, modalRoot, api, tenantId: 't2', toast, timers }); await settle(); releasePrepare(); await settle();
  assert.deepEqual(calls, [['prepare', 't1']]); root.querySelector('#user-qq-uin').value = '123456'; findByText(root, 'button', '扫码登录 QQ').click(); await settle();
  second.destroy(); releaseQr({ status: 'waiting', imageDataUrl: 'data:image/png;base64,AA==' }); await settle();
  assert.equal(modalRoot.textContent, ''); assert.deepEqual(calls, [['prepare', 't1'], ['prepare', 't2'], ['start', 't2'], ['qr', 't2']]);
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
