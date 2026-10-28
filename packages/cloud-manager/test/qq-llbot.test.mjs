import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loginAdmin, request, startManager, waitFor } from './helpers.mjs';

test('LLBot real login endpoints, auth-token gate and UIN verification', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'QQ Demo', slug: 'qq-demo', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;

  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'llbot', uin: '10001' }
  });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(prepared.json.qq.driver, 'llbot');
  assert.equal(prepared.json.qq.expectedUin, '10001');
  assert.equal(prepared.json.qq.entryExists, true);
  assert.equal(prepared.json.qq.authToken.hasToken, false);
  assert.equal(prepared.json.qq.state, 'prepared');

  const qqConfigPath = path.join(manager.tenants.row(tenantId).data_dir, 'qq', 'llbot', 'data', 'config_10001.json');
  const qqConfig = JSON.parse(fs.readFileSync(qqConfigPath, 'utf8'));
  assert.equal(qqConfig.webui.host, '127.0.0.1');
  assert.equal(qqConfig.ob11.connect[0].enable, true);
  assert.equal(qqConfig.ob11.connect[0].host, '127.0.0.1');
  assert.ok(qqConfig.ob11.connect[0].token);

  const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.qq.state, 'auth_required');
  assert.equal(started.json.qq.process.state, 'running');

  const blockedQr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.equal(blockedQr.status, 409);
  assert.equal(blockedQr.json.code, 'AUTH_TOKEN_REQUIRED');
  assert.equal(blockedQr.json.authToken.hasToken, false);

  const setToken = await admin.call(`/api/tenants/${tenantId}/qq/auth-token`, {
    method: 'PUT', body: { token: 'test-auth-token-1234567890' }
  });
  assert.equal(setToken.status, 200, setToken.text);
  assert.equal(setToken.json.source, 'tenant');
  assert.equal(setToken.json.authToken.hasToken, true);

  await waitFor(async () => {
    const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
    return status.json.qq.authToken.validation === 'valid' ? status : null;
  }, { label: 'auth token validation' });

  const qr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.equal(qr.status, 200, qr.text);
  assert.equal(qr.json.qrcode.state, 'ready');
  assert.match(qr.json.qrcode.qrcodeUrl, /qr\.example\.test/);
  assert.ok(qr.json.qrcode.pngBase64.startsWith('data:image/png;base64,'));
  assert.ok(qr.json.qrcode.expireAt > Date.now());

  const account = manager.qq.account(tenantId);
  const webuiPassword = manager.secrets.get(tenantId, 'qq.webui_password');
  const hash = crypto.createHash('sha256').update(webuiPassword).digest('hex');
  const online = await request(`http://127.0.0.1:${account.webui_port}`, {
    method: 'POST', path: '/__fake/online', body: { uin: '10001', nick: 'Fake Logged In' },
    headers: { 'x-webui-token': hash }
  });
  assert.equal(online.status, 200, online.text);

  await waitFor(async () => {
    const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
    return status.json.qq.state === 'online' ? status : null;
  }, { label: 'qq online' });
  const onlineStatus = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(onlineStatus.json.qq.online, true);
  assert.equal(onlineStatus.json.qq.uin, '10001');
  assert.equal(onlineStatus.json.qq.nickname, 'Fake Logged In');

  const agentConfig = JSON.parse(fs.readFileSync(path.join(manager.tenants.row(tenantId).data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(agentConfig.channels.qq.enabled, true);
  assert.equal(agentConfig.channels.qq.wsUrl, `ws://127.0.0.1:${account.ob11_port}`);
  assert.equal(agentConfig.channels.qq.accessToken, manager.secrets.get(tenantId, 'qq.onebot_token'));
  assert.equal(agentConfig.server.port, manager.agent.port(manager.tenants.row(tenantId)));
  assert.match(agentConfig.api.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.ok(agentConfig.api.apiKey.startsWith('sk-fish-'));

  const wrongLogin = await request(`http://127.0.0.1:${account.webui_port}`, {
    method: 'POST', path: '/__fake/online', body: { uin: '20002', nick: 'Wrong Account' },
    headers: { 'x-webui-token': hash }
  });
  assert.equal(wrongLogin.status, 200);
  const mismatch = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(mismatch.json.qq.state, 'uin_mismatch');
  assert.equal(mismatch.json.qq.online, false);
  assert.equal(mmStatusStopped(mismatch.json.qq), true);

  const cleared = await admin.call(`/api/tenants/${tenantId}/qq/auth-token`, { method: 'DELETE' });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.json.source, 'none');
});

function mmStatusStopped(qq) {
  return qq.process.state === 'stopped';
}
