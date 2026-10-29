import assert from 'node:assert/strict';
import test from 'node:test';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';
import { openQrFlow } from '../views/qr.js';

async function settle() { for (let i = 0; i < 4; i++) await flush(); }
const label = '获取新二维码';
const oldQr = { qrcode: { state: 'expired', runtimeGeneration: 1, qrGeneration: 1, imageDataUrl: 'data:image/png;base64,QUE=' } };
const newQr = { qrcode: { state: 'ready', runtimeGeneration: 2, qrGeneration: 1, imageDataUrl: 'data:image/png;base64,QkI=' } };

function open(api, options = {}) {
  const { modalRoot } = appendRoot(installDom());
  const timers = createFakeTimers();
  const flow = openQrFlow({ modalRoot, api, tenantId: 't1', capabilities: { qrcodeRefresh: true }, runtimeGeneration: 1, timers, ...options });
  return { modalRoot, timers, flow };
}

test('new QR replaces an expired code and ignores repeated clicks while loading', async () => {
  let resolveRefresh;
  let calls = 0, reads = 0;
  const generations = [];
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => { reads++; return oldQr; },
    refreshQQQrcode: (_id, generation) => {
      generations.push(generation);
      calls++;
      return new Promise(resolve => { resolveRefresh = resolve; });
    },
    getQQStatus: async () => ({ runtimeGeneration: 2, loginState: 'waiting_qr' })
  });
  await settle();
  const button = findByText(modalRoot, 'button', label);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  button.click(); fire(button, 'click');
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(modalRoot.querySelector('img').getAttribute('src'), null);
  resolveRefresh(newQr);
  await settle();
  assert.equal(reads, 1);
  assert.equal(button.disabled, false);
  assert.equal(modalRoot.querySelector('img').src, newQr.qrcode.imageDataUrl);
  assert.equal(modalRoot.querySelector('img').hidden, false);
  assert.equal(modalRoot.querySelector('.qr-countdown').textContent, '');
  button.click();
  assert.deepEqual(generations, [1, 2]);
  resolveRefresh(newQr); await settle();
  flow.close();
  assert.equal(timers.pending(), 0);
});

test('refresh errors allow retry and late responses cannot reopen a closed modal', async () => {
  let calls = 0;
  let resolveRefresh;
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => oldQr,
    refreshQQQrcode: async () => {
      if (++calls === 1) throw new Error('temporary error');
      return new Promise(resolve => { resolveRefresh = resolve; });
    }
  });
  await settle();
  const button = findByText(modalRoot, 'button', label);
  button.click(); await settle();
  assert.equal(button.disabled, false);
  assert.equal(modalRoot.querySelector('img').hidden, true);
  button.click(); await settle();
  flow.close(); resolveRefresh(newQr); await settle();
  assert.equal(modalRoot.textContent, '');
  assert.equal(timers.pending(), 0);
});

test('a refresh racing with scan confirmation keeps polling for the logged-in account', async () => {
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => oldQr,
    refreshQQQrcode: async () => { throw Object.assign(new Error('confirm on phone'), { code: 'QQ_LOGIN_IN_PROGRESS' }); },
    getQQStatus: async () => ({ runtimeGeneration: 1, loginState: 'online', loggedIn: true, uin: '12345', expectedUin: '12345' })
  });
  await settle();
  const button = findByText(modalRoot, 'button', label);
  button.click(); await settle();
  assert.equal(button.disabled, true);
  await timers.tick(0); await settle();
  assert.equal(button.hidden, true);
  await timers.tick(1300);
  assert.equal(modalRoot.textContent, '');
  flow.close();
});

test('a stale runtime does not let an old dialog repeatedly restart the login session', async () => {
  let calls = 0;
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => oldQr,
    refreshQQQrcode: async () => { calls++; throw Object.assign(new Error('stale'), { code: 'QRCODE_STALE' }); }
  });
  await settle();
  const button = findByText(modalRoot, 'button', label);
  button.click(); await settle();
  assert.equal(button.disabled, true);
  fire(button, 'click'); await settle(); assert.equal(calls, 1);
  assert.equal(modalRoot.querySelector('img').hidden, true);
  assert.equal(timers.pending(), 0);
  flow.close();
});

for (const fail of [false, true]) test(`late polling ${fail ? 'errors' : 'QR responses'} cannot overwrite a refreshed generation`, async () => {
  let releasePoll, reads = 0;
  const { modalRoot, timers, flow } = open({
    getQQQrcode: () => ++reads === 1 ? Promise.resolve({ ...oldQr.qrcode, state: 'ready' }) : new Promise((resolve, reject) => { releasePoll = fail ? reject : resolve; }),
    getQQStatus: async () => ({ runtimeGeneration: 1, loginState: 'waiting_qr' }),
    refreshQQQrcode: async () => newQr
  });
  await settle(); await timers.tick(0); await settle();
  findByText(modalRoot, 'button', label).click(); await settle();
  releasePoll(fail ? new Error('obsolete poll failure') : oldQr); await settle();
  assert.equal(modalRoot.querySelector('img').src, newQr.qrcode.imageDataUrl);
  assert.equal(modalRoot.querySelector('img').hidden, false);
  assert.doesNotMatch(modalRoot.textContent, /obsolete poll failure|运行实例已变化|二维码已过期/);
  flow.close(); assert.equal(timers.pending(), 0);
});

test('switch QR hides refresh even with driver capability and close never cancels the operation', async () => {
  let refreshes = 0, cancels = 0, reads = 0;
  const operation = { operationId: 'op', status: 'running', phase: 'waiting_qr', runtimeGeneration: 1, qrGeneration: 3 };
  const { modalRoot, timers, flow } = open({
    getQQOperation: async () => ({ operation }),
    getQQQrcode: async () => { reads++; return { ...oldQr.qrcode, state: 'ready', operationId: 'op', qrGeneration: 3 }; },
    refreshQQQrcode: async () => { refreshes++; return newQr; },
    cancelQQOperation: async () => { cancels++; }
  }, { operationId: 'op', qrGeneration: 3 });
  await settle();
  const button = findByText(modalRoot, 'button', label);
  assert.equal(button.hidden, true);
  assert.equal(modalRoot.querySelector('img').hidden, false);
  assert.match(modalRoot.textContent, /可继续扫码.*取消切换.*重新发起/);
  fire(button, 'click'); await settle();
  assert.equal(refreshes, 0);
  await timers.tick(0); await settle(); assert.equal(reads, 2);
  findByText(modalRoot, 'button', '关闭').click();
  await timers.tick(6000); await settle();
  assert.equal(reads, 2); assert.equal(cancels, 0); assert.equal(timers.pending(), 0);
  assert.equal(modalRoot.textContent, ''); flow.close();
});

for (const mismatch of ['operationId', 'runtimeGeneration', 'qrGeneration']) test(`switch QR rejects mismatching ${mismatch} and retains generation validation`, async () => {
  const operation = { operationId: 'op', status: 'running', phase: 'waiting_qr', runtimeGeneration: 1, qrGeneration: 3 };
  let qr = { ...oldQr.qrcode, state: 'ready', operationId: 'op', qrGeneration: 3 };
  const { modalRoot, timers, flow } = open({
    getQQOperation: async () => ({ operation }),
    getQQQrcode: async () => qr
  }, { operationId: 'op', qrGeneration: 3 });
  await settle(); assert.equal(modalRoot.querySelector('img').hidden, false);
  qr = { ...qr, [mismatch]: mismatch === 'operationId' ? 'other' : 9 };
  await timers.tick(0); await settle();
  assert.equal(modalRoot.querySelector('img').hidden, true);
  assert.equal(findByText(modalRoot, 'button', label).hidden, true);
  if (mismatch === 'qrGeneration') {
    operation.qrGeneration = 9;
    await timers.tick(3000); await settle();
    assert.equal(modalRoot.querySelector('img').hidden, false);
  } else assert.equal(timers.pending(), 0);
  flow.close(); assert.equal(timers.pending(), 0);
});

test('ordinary refresh cannot adopt a QR from another operation even with a newer runtime', async () => {
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => oldQr,
    refreshQQQrcode: async () => ({ qrcode: { ...newQr.qrcode, operationId: 'other' } })
  });
  await settle(); findByText(modalRoot, 'button', label).click(); await settle();
  assert.equal(modalRoot.querySelector('img').hidden, true);
  assert.match(modalRoot.textContent, /切换操作已变化/);
  assert.equal(findByText(modalRoot, 'button', '获取中').disabled, true);
  assert.equal(timers.pending(), 0); flow.close();
});

test('ordinary QR status cannot confirm an account after a switch operation starts', async () => {
  let confirmations = 0;
  const { modalRoot, timers, flow } = open({
    getQQQrcode: async () => ({ ...oldQr.qrcode, state: 'ready' }),
    getQQStatus: async () => ({ activeOperationId: 'other', runtimeGeneration: 1, loginState: 'online', loggedIn: true, uin: '12345', expectedUin: '12345' })
  }, { onConfirmed: () => { confirmations++; } });
  await settle(); await timers.tick(0); await settle();
  assert.equal(confirmations, 0); assert.equal(modalRoot.querySelector('img').hidden, true);
  assert.match(modalRoot.textContent, /切换操作已变化/);
  assert.equal(timers.pending(), 0); flow.close();
});
