import test from 'node:test';
import assert from 'node:assert/strict';
import { startManager, loginAdmin } from '../../test/helpers.mjs';
import { normalizeQQDrivers, normalizeQQStatus, normalizeQr } from '../lib/normalize.js';
import { mountUserInstance } from '../views/user/instance.js';
import { appendRoot, installDom, findByText, flush } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

test('面板消费真实管理器合同与 fake LLBot 扫码数据', async (t) => {
  const env = await startManager({ platformAuthToken: 'fixture-auth-token', napcatImage: '' });
  t.after(() => env.stop());
  const client = await loginAdmin(env.manager);
  const created = await client.createTenant({ name: 'fixture' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.tenant.id;
  const list = await client.call('/api/qq/drivers');
  assert.equal(list.status, 200, list.text);
  const drivers = normalizeQQDrivers(list.json);
  assert.equal(drivers.defaultDriver, 'napcat');
  assert.ok(drivers.drivers.find(d => d.id === 'llbot'));
  const initial = await client.call(`/api/tenants/${id}/qq/status`);
  const unprepared = normalizeQQStatus(initial.json);
  assert.equal(unprepared.kernel, 'unknown');
  assert.equal(unprepared.runtimeState, 'stopped');
  assert.equal(unprepared.canChat, false);
  const prepared = await client.call(`/api/tenants/${id}/qq/prepare`, { method: 'POST', body: { kernel: 'llbot', uin: '10001' } });
  assert.equal(prepared.status, 200, prepared.text);
  const status = normalizeQQStatus(prepared.json);
  assert.equal(status.kernel, 'llbot'); assert.equal(status.expectedUin, '10001'); assert.equal(status.uin, '');
  assert.equal(status.runtimeGeneration, 0); assert.equal(status.canChat, false);
  const startedTenant = await client.startTenant(id); assert.equal(startedTenant.status, 200, startedTenant.text);
  const started = await client.call(`/api/tenants/${id}/qq/start`, { method: 'POST', body: { kernel: 'llbot', uin: '10001' } });
  assert.equal(started.status, 200, started.text);
  const actual = normalizeQQStatus(started.json);
  assert.equal(actual.runtimeState, 'ready'); assert.equal(actual.loginState, 'waiting_qr'); assert.equal(actual.agentChannelState, 'disconnected'); assert.equal(actual.canChat, false);
  const qrResponse = await client.call(`/api/tenants/${id}/qq/qrcode`);
  assert.equal(qrResponse.status, 200, qrResponse.text);
  const qr = normalizeQr(qrResponse.json);
  assert.equal(qr.runtimeGeneration, 0); assert.ok(qr.imageSrc.startsWith('data:image/png;base64,'));
  let prepares = 0, starts = 0;
  const api = {
    getTenant: async () => (await client.getTenant(id)).json,
    getQQDrivers: async () => (await client.call('/api/qq/drivers')).json,
    getQQStatus: async () => (await client.call(`/api/tenants/${id}/qq/status`)).json,
    getQQQrcode: async () => (await client.call(`/api/tenants/${id}/qq/qrcode`)).json,
    prepareQQ: async () => { prepares++; }, startQQ: async () => { starts++; }
  };
  const { root, modalRoot } = appendRoot(installDom()); const timers = createFakeTimers();
  const view = mountUserInstance({ root, modalRoot, api, tenantId: id, timers });
  t.after(() => view.destroy());
  await new Promise(resolve => setTimeout(resolve, 100)); await settle();
  assert.equal(root.querySelector('#user-qq-driver').value, 'llbot');
  assert.equal(root.querySelector('#user-qq-uin').value, '10001');
  assert.match(root.textContent, /运行环境：ready.*QQ 登录：waiting_qr.*Agent 通道：disconnected/);
  findByText(root, 'button', '继续扫码登录').click();
  await new Promise(resolve => setTimeout(resolve, 100)); await settle();
  assert.equal(prepares, 0); assert.equal(starts, 0); assert.ok(modalRoot.querySelector('img').src.startsWith('data:image/png;base64,'));
});
