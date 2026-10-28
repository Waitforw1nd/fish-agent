import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loginAdmin, request, startManager, waitFor } from './helpers.mjs';

test('Bilibili bridge login, subscriptions and agent channel wiring', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Bili Demo', slug: 'bili-demo', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;

  const configBefore = await admin.call(`/api/tenants/${tenantId}/bili/config`);
  assert.equal(configBefore.status, 200);
  assert.equal(configBefore.json.config.subscriptions.mentions, true);
  assert.equal(configBefore.json.config.subscriptions.liveRoom, false);

  const qr = await admin.call(`/api/tenants/${tenantId}/bili/login/qr`, { method: 'POST' });
  assert.equal(qr.status, 200, qr.text);
  assert.equal(qr.json.login.state, 'waiting');
  assert.match(qr.json.login.qrcodeUrl, /bili\.example\.test/);

  const statusWaiting = await admin.call(`/api/tenants/${tenantId}/bili/login/status`);
  assert.equal(statusWaiting.status, 200, statusWaiting.text);
  assert.equal(statusWaiting.json.login.state, 'waiting');
  assert.equal(statusWaiting.json.login.online, false);

  const controlPort = manager.bili.row(tenantId).control_port;
  const controlToken = manager.secrets.get(tenantId, 'bili.control_token');
  const online = await request(`http://127.0.0.1:${controlPort}`, {
    method: 'POST', path: '/__fake/online', body: { mid: '9527', nickname: 'Fake UP' },
    headers: { authorization: `Bearer ${controlToken}` }
  });
  assert.equal(online.status, 200, online.text);

  await waitFor(async () => {
    const status = await admin.call(`/api/tenants/${tenantId}/bili/status`);
    return status.json.bili.online ? status : null;
  }, { label: 'bili online' });
  const status = await admin.call(`/api/tenants/${tenantId}/bili/status`);
  assert.equal(status.json.bili.online, true);
  assert.equal(status.json.bili.mid, '9527');
  assert.equal(status.json.bili.nickname, 'Fake UP');
  assert.equal(status.json.bili.pollers.mentions.enabled, true);

  const loginStatus = await admin.call(`/api/tenants/${tenantId}/bili/login/status`);
  assert.equal(loginStatus.json.login.state, 'success');
  assert.equal(loginStatus.json.login.online, true);

  const updated = await admin.call(`/api/tenants/${tenantId}/bili/config`, {
    method: 'PUT',
    body: {
      enabled: true,
      subscriptions: { mentions: true, upVideos: false, privateMessages: true, liveRoom: true },
      liveRoomIds: [1234],
      upMids: ['42'],
      commentIntervalMs: 1000
    }
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.appliedLive, true);
  assert.equal(updated.json.config.subscriptions.upVideos, false);
  assert.equal(updated.json.config.subscriptions.liveRoom, true);
  assert.deepEqual(updated.json.config.liveRoomIds, [1234]);
  assert.equal(updated.json.config.commentIntervalMs, 15000);

  const after = await admin.call(`/api/tenants/${tenantId}/bili/config`);
  assert.equal(after.json.config.subscriptions.liveRoom, true);
  const fakeState = JSON.parse(fs.readFileSync(path.join(manager.tenants.row(tenantId).data_dir, 'bili', 'data', 'fake-bili-state.json'), 'utf8'));
  assert.equal(fakeState.subscriptions.up, false);

  const rejected = await admin.call(`/api/tenants/${tenantId}/bili/config`, {
    method: 'PUT', body: { subscriptions: { mentions: true }, cookie: 'SESSDATA=secret' }
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.code, 'BILI_SECRET_REJECTED');

  const agentConfig = JSON.parse(fs.readFileSync(path.join(manager.tenants.row(tenantId).data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(agentConfig.channels.bili.enabled, true);
  assert.match(agentConfig.channels.bili.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(agentConfig.channels.bili.accessToken, manager.secrets.get(tenantId, 'bili.onebot_token'));

  const stopped = await admin.call(`/api/tenants/${tenantId}/bili/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.bili.process.state, 'stopped');
});
