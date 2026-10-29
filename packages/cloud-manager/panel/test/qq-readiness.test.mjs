import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUserInstance } from '../views/user/instance.js';
import { mountUserInstances } from '../views/user/instances.js';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const toast = { show() {} };
const drivers = { defaultDriver: 'napcat', drivers: [
  { id: 'napcat', label: 'NapCat', allowed: true, available: true, capabilities: {} }
] };

function status(loginState = 'waiting_qr', runtimeState = 'ready') {
  return {
    kernel: 'napcat', runtimeState, loginState, agentChannelState: 'disconnected',
    expectedUin: '123456', uin: loginState === 'online' ? '123456' : '',
    runtimeGeneration: 1
  };
}

function tenant(online, id = 't1') {
  const steps = [
    { id: 'agent', label: '启动实例', ready: true },
    { id: 'qq', label: '扫码登录 QQ', ready: online },
    { id: 'channel', label: '配置模型渠道', ready: false },
    { id: 'whitelist', label: '选择互动白名单', ready: false }
  ];
  return { tenant: { id, name: id, role: 'owner', status: 'running',
    readiness: { steps, completed: online ? 2 : 1, total: 4 } }, role: 'owner' };
}

test('QQ 状态变化只刷新实例摘要，保留编辑和打开的扫码弹窗', async () => {
  const { root, modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  let current = status(), reads = 0;
  const api = {
    getTenant: async () => { reads++; return tenant(current.loginState === 'online'); },
    getQQDrivers: async () => drivers,
    getQQStatus: async () => current,
    getQQQrcode: () => new Promise(() => {}),
    getBiliConfig: async () => ({ config: { subscriptions: {}, upMids: ['100'] } }),
    getBiliStatus: async () => ({})
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle(); await timers.tick(0); await timers.tick(5000); await settle();
  assert.equal(reads, 2, 'unchanged QQ status must not repeatedly reload the summary');
  assert.match(root.textContent, /开通进度 1\/4/);

  findByText(root, 'button', '继续扫码登录').click();
  await settle();
  const qqInput = root.querySelector('#user-qq-uin');
  const biliInput = root.querySelector('textarea');
  const modal = modalRoot.firstElementChild;
  qqInput.value = '987654';
  biliInput.value = 'unsaved';
  fire(biliInput, 'input');
  assert.equal(view.hasUnsavedChanges(), true);

  current = status('online');
  await timers.tick(5000); await settle();
  assert.equal(reads, 3);
  assert.match(root.textContent, /开通进度 2\/4/);
  assert.match(root.textContent, /✓ 扫码登录 QQ/);
  assert.equal(findByText(root, 'button', 'QQ 已登录').disabled, true);
  assert.equal(root.querySelector('#user-qq-uin'), qqInput);
  assert.equal(qqInput.value, '987654');
  assert.equal(root.querySelector('textarea'), biliInput);
  assert.equal(biliInput.value, 'unsaved');
  assert.equal(view.hasUnsavedChanges(), true);
  assert.equal(modalRoot.firstElementChild, modal);

  current = status();
  await timers.tick(5000); await settle();
  assert.equal(reads, 4);
  assert.match(root.textContent, /开通进度 1\/4/);
  assert.match(root.textContent, /○ 扫码登录 QQ/);
  assert.equal(findByText(root, 'button', '继续扫码登录').disabled, false);
  assert.equal(biliInput.value, 'unsaved');
  assert.equal(modalRoot.firstElementChild, modal);
  view.destroy();
});

test('首次 QQ 状态刷新过期的实例就绪度，摘要读取失败后会重试', async () => {
  const { root, modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  let reads = 0;
  const api = {
    getTenant: async () => {
      reads++;
      if (reads === 1) return tenant(false);
      if (reads === 2) throw new Error('temporary failure');
      return tenant(true);
    },
    getQQDrivers: async () => drivers,
    getQQStatus: async () => status('online')
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle();
  assert.match(root.textContent, /开通进度 1\/4/);
  assert.equal(findByText(root, 'button', 'QQ 已登录').disabled, true);
  await timers.tick(0); await settle();
  assert.equal(reads, 3);
  assert.match(root.textContent, /开通进度 2\/4/);
  await timers.tick(5000); await settle();
  assert.equal(reads, 3);
  view.destroy();
});

test('摘要与 QQ 状态不一致时，即使状态不变也会再次读取摘要', async () => {
  const { root, modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  let reads = 0;
  const api = {
    getTenant: async () => tenant(++reads >= 3),
    getQQDrivers: async () => drivers,
    getQQStatus: async () => status('online')
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle();
  assert.equal(reads, 2);
  assert.match(root.textContent, /开通进度 1\/4/);
  await timers.tick(0); await settle();
  assert.equal(reads, 3);
  assert.match(root.textContent, /开通进度 2\/4/);
  await timers.tick(5000); await settle();
  assert.equal(reads, 3);
  view.destroy();
});

test('过期的摘要响应及销毁后的响应不会覆盖最新状态或新实例', async () => {
  const { root, modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  let current = status(), reads = 0;
  const pending = [];
  const api = {
    getTenant: (id) => {
      if (id === 't2') return Promise.resolve(tenant(false, id));
      reads++;
      if (reads <= 2) return Promise.resolve(tenant(false));
      return new Promise((resolve) => pending.push(resolve));
    },
    getQQDrivers: async () => drivers,
    getQQStatus: async () => current
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle(); await timers.tick(0); await settle();
  current = status('online');
  await timers.tick(5000); await settle();
  current = status('offline', 'stopped');
  await timers.tick(5000); await settle();
  assert.equal(pending.length, 2);
  pending[1](tenant(false)); await settle();
  pending[0](tenant(true)); await settle();
  assert.match(root.textContent, /开通进度 1\/4/);
  assert.equal(findByText(root, 'button', '扫码登录 QQ').disabled, false);

  current = status('online');
  await timers.tick(5000); await settle();
  assert.equal(pending.length, 3);
  view.destroy();
  current = status('offline', 'stopped');
  const next = mountUserInstance({ root, modalRoot, api, tenantId: 't2', toast, timers });
  await settle();
  pending[2](tenant(true)); await settle();
  assert.match(root.textContent, /t2/);
  assert.match(root.textContent, /开通进度 1\/4/);
  next.destroy();
});

test('登录期间较早的 QQ 轮询响应不能覆盖启动后的状态', async () => {
  const { root, modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  let reads = 0, resolveOldPoll;
  const api = {
    getTenant: async () => tenant(false),
    getQQDrivers: async () => drivers,
    getQQStatus: () => {
      reads++;
      if (reads === 1) return Promise.resolve(status('offline', 'stopped'));
      if (reads === 2) return new Promise((resolve) => { resolveOldPoll = resolve; });
      return Promise.resolve(status());
    },
    prepareQQ: async () => {},
    startQQ: async () => {},
    getQQQrcode: () => new Promise(() => {})
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers });
  await settle(); await timers.tick(0);
  root.querySelector('#user-qq-uin').value = '123456';
  findByText(root, 'button', '扫码登录 QQ').click();
  await settle();
  assert.match(root.textContent, /QQ 登录：waiting_qr/);
  resolveOldPoll(status('online')); await settle();
  assert.match(root.textContent, /QQ 登录：waiting_qr/);
  assert.equal(findByText(root, 'button', '继续扫码登录').disabled, false);
  view.destroy();
});

test('返回实例列表或手动刷新时读取最新的服务端就绪度', async () => {
  const { root } = appendRoot(installDom());
  let online = false;
  const api = { listTenants: async () => ({ tenants: [tenant(online).tenant] }) };
  const view = mountUserInstances({ root, api, toast });
  await settle();
  assert.match(root.textContent, /开通进度 1\/4/);
  online = true;
  findByText(root, 'button', '刷新').click();
  await settle();
  assert.match(root.textContent, /开通进度 2\/4/);
  view.destroy();
  const next = mountUserInstances({ root, api, toast });
  await settle();
  assert.match(root.textContent, /开通进度 2\/4/);
  next.destroy();
});
