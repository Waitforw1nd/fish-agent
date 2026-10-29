import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loginAdmin, startManager, waitFor } from './helpers.mjs';
import { startFakeUpstream, UPSTREAM_KEY } from './fixtures/fake-upstream.mjs';

test('panel contract: same-origin writes, runtime status, QQ/Bili/relay response shapes', async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);
  const origin = `http://127.0.0.1:${config.panelPort}`;

  const created = await admin.call('/api/tenants', {
    method: 'POST',
    body: { name: '中文租户（无 slug）' },
    csrf: false,
    headers: { origin }
  });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  assert.match(created.json.tenant.slug, /^bot-[a-f0-9]{8}$/);
  assert.equal(created.json.tenant.status, 'stopped');
  assert.equal(created.json.tenant.running, false);
  assert.equal(created.json.tenant.subscriptionStatus, 'active');
  assert.match(created.json.tenant.consoleUrl, /^http:\/\/bot-[a-f0-9]{8}\.test\.local:\d+$/);
  assert.equal(created.json.tenant.relay.configured, true);
  assert.ok(created.json.tenant.relay.keyMasked);

  const panelIndex = await admin.call('/');
  assert.equal(panelIndex.status, 200);
  assert.match(panelIndex.text, /Fish Cloud/);
  assert.match(panelIndex.text, /Content-Security-Policy/);
  const panelJs = await admin.call('/app.js');
  assert.equal(panelJs.status, 200);
  assert.match(panelJs.text, /mountLogin|createApi/);
  const panelRoute = await admin.call('/login');
  assert.equal(panelRoute.status, 200);
  assert.match(panelRoute.text, /Fish Cloud/);

  const started = await admin.call(`/api/tenants/${tenantId}/start`, { method: 'POST', csrf: false, headers: { origin } });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.tenant.status, 'running');
  assert.equal(started.json.tenant.running, true);
  const list = await admin.call('/api/tenants');
  assert.equal(list.json.tenants[0].status, 'running');

  const prepared = await admin.call(`/api/tenants/${tenantId}/qq/prepare`, {
    method: 'POST', body: { kernel: 'llbot', uin: '10001' }
  });
  assert.equal(prepared.status, 200, prepared.text);
  assert.equal(prepared.json.qq.kernel, 'llbot');
  assert.equal(prepared.json.qq.phase, 'stopped');
  assert.equal(prepared.json.qq.authTokenStatus, 'missing');

  const qqStarted = await admin.call(`/api/tenants/${tenantId}/qq/start`, {
    method: 'POST', body: { kernel: 'llbot' }
  });
  assert.equal(qqStarted.status, 200, qqStarted.text);
  assert.equal(qqStarted.json.qq.phase, 'waiting_login');
  assert.equal(qqStarted.json.qq.running, true);
  assert.equal(qqStarted.json.qq.qrAvailable, true);
  assert.equal(qqStarted.json.qq.kernel, 'llbot');

  const qqStatus = await admin.call(`/api/tenants/${tenantId}/qq/status`);
  assert.equal(qqStatus.json.qq.phase, 'waiting_login');
  assert.equal(qqStatus.json.qq.authTokenStatus, 'missing');
  const qrBlocked = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.equal(qrBlocked.status, 409);
  assert.equal(qrBlocked.json.code, 'AUTH_TOKEN_REQUIRED');
  assert.equal(qrBlocked.json.authToken.hasToken, false);

  const token = await admin.call(`/api/tenants/${tenantId}/qq/auth-token`, {
    method: 'PUT', body: { token: 'panel-auth-token-12345' }
  });
  assert.equal(token.status, 200, token.text);
  let lastStatus = null;
  const diagnostics = () => ({
    httpStatus: lastStatus?.status ?? null,
    phase: lastStatus?.json?.qq?.phase ?? null,
    processState: manager.supervisor.status(tenantId, 'qq').state,
    authTokenStatus: lastStatus?.json?.qq?.authTokenStatus ?? null,
    validation: lastStatus?.json?.qq?.authToken?.validation ?? null,
    logCodes: manager.supervisor.logs(tenantId, 'qq').flatMap(line => line.match(/\b(?:EADDRINUSE|EACCES|ECONNREFUSED|ERR_[A-Z_]+)\b/g) || [])
  });
  assert.equal(token.json.restartRequired, false, JSON.stringify(diagnostics()));
  try {
    await waitFor(async () => {
      lastStatus = await admin.call(`/api/tenants/${tenantId}/qq/status`);
      return lastStatus.json.qq.authTokenStatus === 'ok' ? lastStatus : null;
    }, { label: 'panel auth token valid' });
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(diagnostics())}`, { cause: error });
  }
  const qr = await admin.call(`/api/tenants/${tenantId}/qq/qrcode`);
  assert.equal(qr.status, 200, qr.text);
  assert.equal(qr.json.qrcode.status, 'waiting');
  assert.ok(qr.json.qrcode.imageDataUrl.startsWith('data:image/png;base64,'));
  assert.ok(qr.json.qrcode.expiresAt > Date.now());
  assert.equal(qr.json.qrcode.state, 'ready');

  const biliConfig = await admin.call(`/api/tenants/${tenantId}/bili/config`, {
    method: 'PUT',
    body: { subscriptions: { mentions: true, upVideos: true, privateMessages: false, liveRooms: true } }
  });
  assert.equal(biliConfig.status, 200, biliConfig.text);
  assert.equal(biliConfig.json.config.subscriptions.liveRoom, true);
  assert.equal(biliConfig.json.config.subscriptions.privateMessages, false);

  const biliQr = await admin.call(`/api/tenants/${tenantId}/bili/login/qr`, { method: 'POST' });
  assert.equal(biliQr.status, 200, biliQr.text);
  assert.equal(biliQr.json.status, 'waiting');
  assert.ok(biliQr.json.imageDataUrl.startsWith('data:image/png;base64,'));
  assert.ok(biliQr.json.expiresAt > Date.now());
  assert.equal(biliQr.json.login.state, 'waiting');
  const biliStatus = await admin.call(`/api/tenants/${tenantId}/bili/status`);
  assert.equal(biliStatus.status, 200);
  assert.ok(['waiting', 'offline', 'online'].includes(biliStatus.json.bili.phase));
  assert.equal(biliStatus.json.bili.subscriptions.liveRoom, true);

  await admin.call('/api/admin/upstream', {
    method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY }
  });
  const relayKey = await admin.call(`/api/tenants/${tenantId}/relay/key`, {
    method: 'PUT', body: { key: 'sk-managed-panel-key', model: 'deepseek-chat' }
  });
  assert.equal(relayKey.status, 200, relayKey.text);
  assert.equal(relayKey.json.configured, true);
  assert.equal(relayKey.json.model, 'deepseek-chat');

  const relayCall = await fetch(`http://127.0.0.1:${manager.config.relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-managed-panel-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'panel contract' }], max_tokens: 8 })
  });
  assert.equal(relayCall.status, 200, await relayCall.text());

  const overview = await admin.call(`/api/tenants/${tenantId}/relay/overview`);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.json.relay.configured, true);
  assert.equal(overview.json.relay.keyStatus, 'active');
  assert.ok(overview.json.relay.keyMasked.includes('sk-managed'));
  assert.equal(overview.json.relay.model, 'deepseek-chat');
  assert.equal(overview.json.relay.quota.rpm, 10);
  assert.equal(typeof overview.json.relay.usage.total.costMicros, 'number');
  assert.ok(Array.isArray(overview.json.relay.usage.daily));
  assert.equal(overview.json.relay.usage.daily[0]?.totals?.available, true);

  const models = await admin.call(`/api/tenants/${tenantId}/relay/models`);
  assert.equal(models.status, 200, models.text);
  assert.ok(models.json.models.every((entry) => entry.allowed));
  assert.ok(!models.json.models.some((entry) => entry.id === 'upstream-only-model'));
  assert.ok(models.json.allModels.some((entry) => entry.id === 'upstream-only-model'));

  const agentConfig = JSON.parse(fs.readFileSync(manager.agent.configPath(manager.tenants.row(tenantId)), 'utf8'));
  assert.equal(agentConfig.api.model, 'deepseek-chat');
  assert.equal(agentConfig.api.apiKey, 'sk-managed-panel-key');
});
