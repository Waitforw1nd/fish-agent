import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loginAdmin, startManager, waitFor } from './helpers.mjs';

test('SnowLuma driver lifecycle retains explicit capability differences', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'Driver Demo', slug: 'driver-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;

  for (const driver of ['snowluma']) {
    const uin = driver === 'napcat' ? '10003' : '10004';
    const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
      method: 'POST', body: { driver, uin }
    });
    assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepared.json.qq.driver, driver);
    assert.equal(prepared.json.qq.capabilities.qrcode, driver === 'napcat');
    assert.equal(prepared.json.qq.capabilities.authToken, false);
    assert.equal(prepared.json.qq.expectedUin, uin);
    assert.equal(prepared.json.qq.authToken.applicable, false);

    const tenant = manager.tenants.row(tenantId);
    const configFile = driver === 'napcat'
      ? path.join(tenant.data_dir, 'qq', 'napcat', 'config', `onebot11_${uin}.json`)
      : path.join(tenant.data_dir, 'qq', 'snowluma', 'config', `onebot_${uin}.json`);
    assert.equal(fs.existsSync(configFile), true);
    const onebotConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(onebotConfig.network.websocketServers[0].host, '127.0.0.1');
    assert.ok(onebotConfig.network.websocketServers[0].port > 0);
    assert.ok(onebotConfig.network.httpServers[0].port > 0);

    const tokenUnsupported = await admin.call(`/api/tenants/${tenantId}/qq/auth-token`, {
      method: 'PUT', body: { token: 'not-applicable-token' }
    });
    assert.equal(tokenUnsupported.status, 400);

    const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.qq.process.state, 'running');

    await waitFor(async () => {
      const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
      return status.json.qq.state === 'online' ? status : null;
    }, { label: `${driver} online` });
    const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
    assert.equal(status.json.qq.online, true);
    assert.equal(status.json.qq.uin, uin);
    assert.equal(status.json.qq.nickname, `Fake ${driver}`);

    if (driver === 'snowluma') {
      const qr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
      assert.equal(qr.status, 501);
      assert.equal(qr.json.code, 'QRCODE_UNSUPPORTED');
    }

    const agentConfig = JSON.parse(fs.readFileSync(path.join(tenant.data_dir, 'data', 'config.json'), 'utf8'));
    assert.equal(agentConfig.channels.qq.enabled, true);
    assert.match(agentConfig.channels.qq.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.match(agentConfig.channels.qq.httpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const stopped = await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(stopped.json.qq.process.state, 'stopped');
    assert.equal((await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
      method: 'POST', body: { driver: 'llbot', uin: '10009' }
    })).status, 200);
  }
});

test('platform LLBot auth token is used as fallback and never returned', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const set = await admin.call('/api/admin/llbot-auth-token', {
    method: 'PUT', body: { token: 'platform-auth-token-123456' }
  });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.hasToken, true);
  const read = await admin.call('/api/admin/llbot-auth-token');
  assert.equal(read.json.hasToken, true);
  assert.equal(JSON.stringify(read.json).includes('platform-auth-token-123456'), false);

  const created = await admin.createTenant({ name: 'Platform QQ', slug: 'platform-qq', planId: 'starter' });
  const tenantId = created.json.tenant.id;
  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'llbot', uin: '10010' }
  });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(prepared.json.qq.authToken.hasToken, true);
  assert.equal(prepared.json.qq.authToken.source, 'platform');
  const authFile = path.join(manager.tenants.row(tenantId).data_dir, 'qq', 'llbot', 'data', 'auth_token.txt');
  assert.equal(fs.readFileSync(authFile, 'utf8'), 'platform-auth-token-123456');

  const started = await admin.call(`/api/tenants/${tenantId}/qq/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);
  const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(status.json.qq.authToken.hasToken, true);
  assert.equal(status.json.qq.authToken.source, 'platform');
});
