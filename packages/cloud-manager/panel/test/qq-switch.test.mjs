import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/api.js';
import { createSwitchController } from '../views/qq-switch.js';
import { mountUserInstance } from '../views/user/instance.js';
import { appendRoot, findByText, flush, installDom } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

test('switch client uses CSRF and encoded operation path', async () => {
  const calls = []; const api = createApi({ fetchImpl: async (path, init) => { calls.push({ path, init }); return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }; } });
  api.setCsrfToken('csrf');
  await api.switchQQ('t', { driver: 'napcat', expectedRevision: 4, idempotencyKey: 'key' });
  await api.getQQOperation('t', 'a/b'); await api.cancelQQOperation('t', 'a/b');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(calls[0].init.body), { driver: 'napcat', expectedRevision: 4, idempotencyKey: 'key' });
  assert.equal(calls[1].path, '/api/tenants/t/qq/operations/a%2Fb');
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf');
  await api.advanceQQOperation('t', 'a/b');
  assert.equal(calls[3].path, '/api/tenants/t/qq/operations/a%2Fb/advance');
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(calls[3].init.headers['X-CSRF-Token'], 'csrf');
});

test('restores operation, handles cancellation and rejects stale operation QR', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let cancelled = 0;
  const op = { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true, runtimeGeneration: 2, qrGeneration: 3 };
  const api = { getQQOperation: async () => ({ operation: op }), cancelQQOperation: async () => { cancelled++; return { operation: { ...op, phase: 'rolling_back', canCancel: false } }; }, getQQQrcode: async () => ({ operationId: 'old', runtimeGeneration: 2, qrGeneration: 3, imageDataUrl: 'data:image/png;base64,QUE=' }) };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op'); assert.match(root.textContent, /等待扫码/);
  findByText(root, 'button', '继续切换扫码').click(); await settle();
  assert.match(modalRoot.textContent, /操作已变化/); assert.equal(modalRoot.querySelector('img').hidden, true);
  findByText(root, 'button', '取消切换').click(); await settle(); assert.equal(cancelled, 1); assert.match(root.textContent, /正在回滚/);
  control.destroy();
});

test('uncertain repeated request retains idempotency key', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const keys = [];
  const api = { switchQQ: async (id, body) => { keys.push(body.idempotencyKey); if (keys.length === 1) throw Object.assign(new Error('network'), { isNetwork: true }); return { operation: { operationId: 'op', status: 'succeeded', phase: 'cleaning_up' } }; } };
  const control = createSwitchController({ api, tenantId: 't', modalRoot }); root.appendChild(control.node);
  await control.start({ driver: 'llbot', expectedRevision: 1, uin: '12345' });
  await control.start({ driver: 'llbot', expectedRevision: 1, uin: '12345' });
  assert.equal(keys[0], keys[1]); assert.match(root.textContent, /切换完成/); control.destroy();
});


test('page reload restores operation, updates QR generation, and closing QR does not cancel', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers();
  let generation = 3, cancelled = 0, reads = 0;
  const api = {
    getTenant: async () => ({ role: 'owner', tenant: { id: 't', status: 'running' } }),
    getQQDrivers: async () => ({ defaultDriver: 'napcat', drivers: [{ id: 'napcat', label: 'NapCat', allowed: true, available: true }] }),
    getQQStatus: async () => ({ kernel: 'napcat', runtimeState: 'ready', loginState: 'waiting_qr', runtimeGeneration: 2, expectedUin: '12345', activeOperationId: 'op', revision: 1 }),
    getQQOperation: async () => ({ operation: { operationId: 'op', status: 'running', phase: 'waiting_qr', runtimeGeneration: 2, qrGeneration: generation, canCancel: true } }),
    getQQQrcode: async () => { reads++; return { operationId: 'op', runtimeGeneration: 2, qrGeneration: generation, status: 'ready', imageDataUrl: generation === 3 ? 'data:image/png;base64,QUE=' : 'data:image/png;base64,QkI=' }; },
    cancelQQOperation: async () => { cancelled++; }
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't', timers }); await settle();
  assert.match(root.textContent, /等待扫码/);
  findByText(root, 'button', '继续切换扫码').click(); await settle();
  assert.match(modalRoot.querySelector('img').src, /QUE=/);
  generation = 4; await timers.tick(0); await timers.tick(3000); await settle();
  assert.match(modalRoot.querySelector('img').src, /QkI=/);
  findByText(modalRoot, 'button', '关闭').click(); await settle();
  const before = reads; await timers.tick(6000); await settle();
  assert.equal(reads, before); assert.equal(cancelled, 0); assert.match(root.textContent, /等待扫码/);
  view.destroy();
});

test('cancel response cannot be overwritten by an earlier operation poll', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers();
  const op = { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true };
  let reads = 0, release;
  const api = { getQQOperation: async () => ++reads === 1 ? { operation: op } : new Promise(resolve => { release = resolve; }),
    cancelQQOperation: async () => ({ operation: { ...op, status: 'cancelled', canCancel: false } }) };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op'); await timers.tick(0); await settle();
  findByText(root, 'button', '取消切换').click(); await settle();
  release({ operation: op }); await settle();
  assert.equal(control.operation.status, 'cancelled'); assert.match(root.textContent, /切换已取消/);
  control.destroy();
});

test('rollback failure and wrong account stay visible and never report success', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers();
  const op = { operationId: 'op', status: 'needs_attention', phase: 'rolling_back', error: { code: 'UIN_MISMATCH', message: '登录账号不匹配' }, rollback: { status: 'failed' } };
  const control = createSwitchController({ api: { getQQOperation: async () => ({ operation: op }) }, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op');
  assert.match(root.textContent, /登录账号不匹配/); assert.match(root.textContent, /旧内核恢复失败/); assert.doesNotMatch(root.textContent, /切换完成/);
  assert.equal(findByText(root, 'button', '继续切换扫码').hidden, true);
  control.destroy();
});

test('QR generation mismatch hides the previously valid image until the matching code arrives', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers();
  let operationGeneration = 3, imageGeneration = 3;
  const api = {
    getQQOperation: async () => ({ operation: { operationId: 'op', status: 'running', phase: 'waiting_qr', runtimeGeneration: 2, qrGeneration: operationGeneration, canCancel: true } }),
    getQQQrcode: async () => ({ operationId: 'op', runtimeGeneration: 2, qrGeneration: imageGeneration, status: 'ready', imageDataUrl: 'data:image/png;base64,QUE=' })
  };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op'); findByText(root, 'button', '继续切换扫码').click(); await settle();
  assert.equal(modalRoot.querySelector('img').hidden, false);
  operationGeneration = 4; await timers.tick(0); await timers.tick(3000); await settle();
  assert.equal(modalRoot.querySelector('img').hidden, true); assert.match(modalRoot.textContent, /等待最新二维码/);
  imageGeneration = 4; await timers.tick(3000); await settle(); assert.equal(modalRoot.querySelector('img').hidden, false);
  control.destroy();
});

test('viewer restores operation but cannot cancel or request a QR', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let cancelled = 0;
  const api = { getQQOperation: async () => ({ operation: { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true, runtimeGeneration: 2, qrGeneration: 3 } }),
    cancelQQOperation: async () => { cancelled++; } };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  api.advanceQQOperation = async () => { throw new Error('viewer cannot advance'); };
  control.setWritable(false); await control.restore('op'); await timers.tick(0); await settle();
  assert.equal(findByText(root, 'button', '取消切换').hidden, true); assert.equal(findByText(root, 'button', '继续切换扫码').hidden, true);
  findByText(root, 'button', '取消切换').click(); findByText(root, 'button', '继续切换扫码').click(); await settle(); assert.equal(cancelled, 0);
  assert.equal(modalRoot.textContent, '');
  control.destroy();
});

test('operator polls with protected advance and terminal completion stops polling', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let advances = 0;
  const op = { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true };
  const api = { getQQOperation: async () => ({ operation: op }),
    advanceQQOperation: async () => { advances++; return { operation: { ...op, status: 'succeeded', phase: 'completed', canCancel: false } }; } };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op'); await timers.tick(0); await settle(); await timers.tick(6000); await settle();
  assert.equal(advances, 1); assert.equal(control.operation.status, 'succeeded'); assert.match(root.textContent, /切换完成/);
  control.destroy();
});

test('cancel follows server capability and running status instead of assuming a phase is cancellable', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let cancels = 0;
  const states = [
    { operationId: 'blocked', status: 'running', phase: 'waiting_qr', canCancel: false },
    { operationId: 'terminal', status: 'cancelled', phase: 'rolled_back', canCancel: true },
    { operationId: 'allowed', status: 'running', phase: 'verify_agent', canCancel: true }
  ];
  const api = { getQQOperation: async (tenantId, id) => ({ operation: states.find(value => value.operationId === id) }),
    cancelQQOperation: async () => { cancels++; return { operation: { ...states[2], status: 'cancelled', canCancel: false } }; } };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  for (const id of ['blocked', 'terminal']) {
    await control.restore(id);
    assert.equal(findByText(root, 'button', '取消切换').hidden, true);
    findByText(root, 'button', '取消切换').click(); await settle();
  }
  assert.equal(cancels, 0);
  await control.restore('allowed'); assert.equal(findByText(root, 'button', '取消切换').hidden, false);
  findByText(root, 'button', '取消切换').click(); await settle(); assert.equal(cancels, 1);
  control.destroy();
});

test('leaving the operation page stops advance until the operation is restored', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let advances = 0;
  const op = { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true };
  const api = { getQQOperation: async () => ({ operation: op }), advanceQQOperation: async () => { advances++; return { operation: op }; } };
  const first = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(first.node);
  await first.restore('op'); await timers.tick(0); await settle(); first.destroy();
  const before = advances; await timers.tick(9000); await settle(); assert.equal(advances, before);
  const second = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(second.node);
  await second.restore('op'); await timers.tick(0); await settle(); assert.equal(advances, before + 1);
  second.destroy();
});

test('cancel after commit shows the conflict and disables repeated cancellation while polling continues', async () => {
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers(); let cancels = 0, advances = 0;
  const op = { operationId: 'op', status: 'running', phase: 'waiting_qr', canCancel: true };
  const api = { getQQOperation: async () => ({ operation: op }),
    cancelQQOperation: async () => { cancels++; throw Object.assign(new Error('committed'), { status: 409, code: 'CANCEL_TOO_LATE' }); },
    advanceQQOperation: async () => { advances++; return { operation: { ...op, status: 'succeeded', phase: 'completed', canCancel: false } }; } };
  const control = createSwitchController({ api, tenantId: 't', modalRoot, timers }); root.appendChild(control.node);
  await control.restore('op'); findByText(root, 'button', '取消切换').click(); await settle();
  assert.match(root.textContent, /已提交，无法取消/); assert.equal(findByText(root, 'button', '取消切换').hidden, true);
  findByText(root, 'button', '取消切换').click(); await settle(); assert.equal(cancels, 1);
  await timers.tick(0); await settle(); assert.equal(advances, 1); assert.equal(control.operation.status, 'succeeded');
  control.destroy();
});

test('409 restores existing operation from status without starting another switch', async () => {
  const { root, modalRoot } = appendRoot(installDom()); let starts = 0;
  const api = { switchQQ: async () => { starts++; throw Object.assign(new Error('busy'), { status: 409, code: 'QQ_SWITCH_ACTIVE' }); },
    getQQStatus: async () => ({ activeOperationId: 'existing' }),
    getQQOperation: async () => ({ operation: { operationId: 'existing', status: 'running', phase: 'rolling_back', canCancel: false } }) };
  const control = createSwitchController({ api, tenantId: 't', modalRoot }); root.appendChild(control.node);
  await control.start({ driver: 'napcat', expectedRevision: 1, uin: '12345' });
  assert.equal(starts, 1); assert.equal(control.operation.operationId, 'existing'); assert.match(root.textContent, /正在回滚/); control.destroy();
});
