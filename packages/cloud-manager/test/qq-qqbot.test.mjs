import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { loginAdmin, startManager, waitFor } from './helpers.mjs';
import { verifyQqbotCredentials } from '../src/qq/qqbot.js';

test('official credential verification rejects malformed tokens, redirects and connection errors safely', async t => {
  let data = {}, disconnect = false, redirect = false, requests = 0;
  const server = http.createServer((req, res) => {
    requests++; req.resume(); req.on('end', () => {
      if (disconnect) { req.socket.destroy(); return; }
      if (redirect) res.writeHead(307, { location: '/unexpected' });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const tokenUrl = `http://127.0.0.1:${server.address().port}/token`;
  const verify = (url = tokenUrl) => verifyQqbotCredentials({ appId: '123456', appSecret: 'PRIVATE_FIXTURE', tokenUrl: url });
  for (const malformed of [{ access_token: { secret: 'PRIVATE_FIXTURE' }, expires_in: 120 },
    { access_token: 'token', expires_in: 0 }, { access_token: 'token', expires_in: 'Infinity' }, ['PRIVATE_FIXTURE']]) {
    data = malformed; await assert.rejects(verify(), error => error.code === 'QQBOT_CREDENTIALS_INVALID' && !error.message.includes('PRIVATE_FIXTURE'));
  }
  data = { access_token: 'token', expires_in: '120' };
  assert.deepEqual(await verify(), { ok: true, expiresIn: 120 });
  redirect = true; const before = requests; await assert.rejects(verify()); assert.equal(requests, before + 1);
  redirect = false; disconnect = true;
  await assert.rejects(verify(), error => error.code === 'QQBOT_VERIFY_UNREACHABLE' && !error.message.includes('PRIVATE_FIXTURE'));
  for (const url of [tokenUrl.replace('http:', 'ftp:'), tokenUrl.replace('http://', 'http://user:PRIVATE_FIXTURE@')]) {
    await assert.rejects(verify(url), error => error.code === 'QQBOT_TOKEN_URL_INVALID' && !error.message.includes('PRIVATE_FIXTURE'));
  }
});

// 官方 QQ 机器人（qqbot）驱动的云端接入测试：
// 凭证校验走本地 fixture（代替 bots.qq.com），验证 prepare/start/status/stop
// 全生命周期、密钥托管、以及 Agent 配置里的 connection.type='qqbot' 下发。
async function tokenFixture(t, { fail = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(fail
        ? { code: 10001, message: 'invalid appsecret: ' + seen.at(-1).clientSecret }
        : { access_token: 'token-fixture', expires_in: '120' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, url: `http://127.0.0.1:${server.address().port}/token` };
}

test('qqbot driver is listed and needs no local runtime install', async (t) => {
  const env = await startManager();
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const drivers = await admin.call('/api/qq/drivers');
  assert.equal(drivers.status, 200);
  const qqbot = drivers.json.drivers.find((driver) => driver.id === 'qqbot');
  assert.ok(qqbot, '官方机器人应出现在驱动列表');
  assert.equal(qqbot.available, true);
  assert.equal(qqbot.capabilities.qrcode, false);
  assert.equal(qqbot.capabilities.official, true);
});

test('qqbot prepare validates input, verifies credentials and never echoes the secret', async (t) => {
  const fixture = await tokenFixture(t);
  const env = await startManager({ qqbotTokenUrl: fixture.url });
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const created = await admin.createTenant({ name: 'QQBot Demo', slug: 'qqbot-demo', planId: 'starter' });
  const tenantId = created.json.tenant.id;

  const badAppId = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: 'abc', appSecret: 'secret-123456' }
  });
  assert.equal(badAppId.status, 400);

  const noSecret = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123' }
  });
  assert.equal(noSecret.status, 400);
  assert.equal(noSecret.json.code, 'QQBOT_SECRET_REQUIRED');

  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: 'secret-fixture-1', sandbox: false }
  });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(prepared.json.qq.driver, 'qqbot');
  assert.equal(prepared.json.qq.expectedUin, '1905870123');
  assert.equal(prepared.json.qq.capabilities.qrcode, false);
  assert.equal(prepared.text.includes('secret-fixture-1'), false, 'AppSecret 绝不出现在响应里');
  assert.deepEqual(fixture.seen.at(-1), { appId: '1905870123', clientSecret: 'secret-fixture-1' });

  // 同配置幂等：不带 AppSecret 再 prepare 不触发凭证校验
  const before = fixture.seen.length;
  const again = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123' }
  });
  assert.equal(prepared.status, 200);
  assert.equal(fixture.seen.length, before);
  assert.equal(again.json.qq.state, 'prepared');

  // 换密钥 → 重新校验
  const rotated = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: 'secret-fixture-2' }
  });
  assert.equal(rotated.status, 200);
  assert.equal(fixture.seen.at(-1).clientSecret, 'secret-fixture-2');
});

test('qqbot rejected credentials surface a clear 400', async (t) => {
  const fixture = await tokenFixture(t, { fail: true });
  const env = await startManager({ qqbotTokenUrl: fixture.url });
  t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const created = await admin.createTenant({ name: 'QQBot Bad', slug: 'qqbot-bad', planId: 'starter' });
  const rejected = await admin.call(`/api/tenants/${created.json.tenant.id}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: 'wrong-secret-1' }
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.code, 'QQBOT_CREDENTIALS_INVALID');
  assert.match(rejected.json.error || '', /白名单/);
  assert.equal(rejected.text.includes('wrong-secret-1'), false, 'reflected platform errors must not expose AppSecret');
});

test('official driver allowlist and concurrent AppID claims prevent cross-tenant duplication', async t => {
  const fixture = await tokenFixture(t);
  const env = await startManager({ qqbotTokenUrl: fixture.url }); t.after(() => env.stop());
  const admin = await loginAdmin(env.manager);
  const tenants = [];
  for (const slug of ['claim-a', 'claim-b']) tenants.push((await admin.createTenant({ name: slug, slug, planId: 'starter' })).json.tenant.id);
  const prepare = id => admin.call(`/api/tenants/${id}/qq/prepare`, { method: 'POST', body: { driver: 'qqbot', appId: '1905870999', appSecret: 'claim-secret-123' } });
  const allowed = env.manager.config.qqDrivers;
  env.manager.config.qqDrivers = allowed.filter(x => x !== 'qqbot');
  assert.equal((await prepare(tenants[0])).status, 400); assert.equal(fixture.seen.length, 0);
  env.manager.config.qqDrivers = allowed;
  const results = await Promise.all(tenants.map(prepare));
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  const loser = tenants[results.findIndex(x => x.status === 409)];
  assert.equal(env.manager.qq.account(loser), null);
  assert.equal(env.manager.secrets.has(loser, 'qq.qqbot.appSecret'), false);
});

test('qqbot start writes connection.type=qqbot into agent config and reports online via agent health', async (t) => {
  const fixture = await tokenFixture(t);
  const env = await startManager({ qqbotTokenUrl: fixture.url });
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const created = await admin.createTenant({ name: 'QQBot Live', slug: 'qqbot-live', planId: 'starter' });
  const tenantId = created.json.tenant.id;

  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { driver: 'qqbot', appId: '1905870123', appSecret: 'secret-fixture-live' }
  });
  assert.equal(prepared.status, 200, prepared.text);

  const started = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST' });
  assert.equal(started.status, 200, started.text);

  const tenant = manager.tenants.row(tenantId);
  const agentConfig = JSON.parse(fs.readFileSync(path.join(tenant.data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(agentConfig.connection.enabled, true);
  assert.equal(agentConfig.connection.type, 'qqbot');
  assert.equal(agentConfig.connection.qqbot.appId, '1905870123');
  assert.equal(agentConfig.connection.qqbot.appSecret, 'secret-fixture-live');
  assert.equal(agentConfig.connection.qqbot.intents, 1 << 25);
  assert.equal(agentConfig.channels.qq.enabled, false, '官方机器人没有本地协议端，channels.qq 保持关闭');

  await waitFor(async () => {
    const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
    return status.json.qq.state === 'online' ? status : null;
  }, { label: 'qqbot online via agent health' });
  const status = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(status.json.qq.online, true);
  assert.equal(status.json.qq.canChat, true);
  assert.equal(status.json.qq.qrAvailable, false);
  assert.equal(status.text.includes('secret-fixture-live'), false);

  // 二维码接口对官方机器人无意义
  const qr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.notEqual(qr.status, 200);

  const stopped = await admin.call(`/api/tenants/${tenantId}/qq/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200, stopped.text);
  assert.equal(stopped.json.qq.state, 'prepared');
  const afterStop = JSON.parse(fs.readFileSync(path.join(tenant.data_dir, 'data', 'config.json'), 'utf8'));
  assert.equal(afterStop.connection.enabled, false, '停止后 Agent 配置里的连接应关闭');
});
