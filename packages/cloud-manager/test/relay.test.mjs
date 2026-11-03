import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loginAdmin, startManager, waitFor } from './helpers.mjs';
import { startFakeUpstream, UPSTREAM_KEY } from './fixtures/fake-upstream.mjs';
import { listModels, listPlans, planAllowsModel } from '../src/plans.js';
import { calculateCostMicros } from '../src/pricing.js';
import { loadConfig } from '../src/config.js';
import { requestJson } from '../src/qq/common.js';

const FLASH_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision', 'deepseek-v4.1-flash'];

test('bounded JSON requests stop an active drip at their absolute deadline', { timeout: 3000 }, async t => {
  const server = http.createServer((_req, res) => {
    const timer = setInterval(() => res.write('x'), 5);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 1000, deadlineMs: 60, maxBytes: 1024 }),
    error => error.code === 'ETIMEDOUT' || error.code === 'RESPONSE_ABORTED');
});

test('model discovery bounds upstream response size', async t => {
  const upstream = await startFakeUpstream({ oversizedModels: true }); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Large models', slug: 'large-models', planId: 'starter' });
  const panel = await admin.call(`/api/tenants/${created.json.tenant.id}/relay/models`);
  assert.equal(panel.status, 200);
  assert.equal(panel.json.upstream.ok, false);
  assert.ok(panel.json.models.some(model => model.id === 'deepseek-chat'), 'fallback models remain available');
});

test('model discovery does not reveal reflected upstream credentials', async t => {
  const upstream = await startFakeUpstream({ reflectModelAuthorization: true }); t.after(() => upstream.close());
  const env = await startManager({ relayCustomAllowPrivate: true }); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Models redaction', slug: 'models-redaction', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const panel = await admin.call(`/api/tenants/${tenantId}/relay/models`);
  assert.equal(panel.status, 200);
  assert.doesNotMatch(panel.text, new RegExp(UPSTREAM_KEY));
  const response = await fetch(`http://127.0.0.1:${manager.config.relayPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), new RegExp(UPSTREAM_KEY));
  const saved = await admin.call(`/api/tenants/${tenantId}/relay/custom`, { method: 'PUT', body: { baseUrl: upstream.baseUrl, model: 'deepseek-chat', apiKey: UPSTREAM_KEY } });
  assert.equal(saved.status, 200, saved.text);
  const customPanel = await admin.call(`/api/tenants/${tenantId}/relay/models`);
  assert.equal(customPanel.status, 200);
  assert.doesNotMatch(customPanel.text, new RegExp(UPSTREAM_KEY));
  assert.ok(customPanel.json.models.some(model => model.id === 'deepseek-chat'));
});

test('incomplete SSE without an accepted event releases the reservation', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Incomplete SSE', slug: 'incomplete-sse', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const before = manager.billing.wallet(tenantId).balanceMicros;
  const response = await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
    model: 'deepseek-chat', messages: [{ role: 'user', content: '__empty_incomplete_sse__' }], max_tokens: 16, stream: true,
    _fish_attribution: { platform: 'qq', chatKey: 'group:123' }
  }, key);
  assert.doesNotMatch(response, /\[DONE\]/);
  assert.equal(manager.billing.wallet(tenantId).balanceMicros, before);
  assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 0);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM meter_events WHERE tenant_id=?').get(tenantId).n, 0);
  for (const marker of ['__role_incomplete_sse__', '__finish_incomplete_sse__']) {
    await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: marker }], max_tokens: 16, stream: true
    }, key);
    assert.equal(manager.billing.wallet(tenantId).balanceMicros, before, `${marker} has no output`);
    assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 0);
  }
  await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
    model: 'deepseek-chat', messages: [{ role: 'user', content: '__zero_usage_sse__' }], max_tokens: 16, stream: true
  }, key);
  assert.equal(manager.billing.wallet(tenantId).balanceMicros, before);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 1, 'zero usage is reported usage and settles');
  for (const marker of ['__empty_complete_sse__', '__usage_only_sse__']) {
    const balance = manager.billing.wallet(tenantId).balanceMicros;
    await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: marker }], max_tokens: 16, stream: true
    }, key);
    assert.ok(manager.billing.wallet(tenantId).balanceMicros < balance, `${marker} must settle`);
  }
});

test('upstream response limit has a bounded configurable default', () => {
  const env = { CLOUD_MASTER_KEY: 'a'.repeat(64) };
  assert.equal(loadConfig(env).upstreamMaxResponseBytes, 8 * 1024 * 1024);
  assert.equal(loadConfig({ ...env, CLOUD_UPSTREAM_MAX_RESPONSE_BYTES: '32768' }).upstreamMaxResponseBytes, 32768);
  assert.equal(loadConfig({ ...env, CLOUD_UPSTREAM_MAX_RESPONSE_BYTES: '999999999' }).upstreamMaxResponseBytes, 64 * 1024 * 1024);
});

test('Relay bounds upstream JSON, errors and SSE while releasing holds and settling only accepted events', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager({ relayCustomAllowPrivate: true }); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  manager.config.upstreamMaxResponseBytes = 16 * 1024;
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Response limits', slug: 'response-limits', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const endpoint = `http://127.0.0.1:${manager.config.relayPort}/v1/chat/completions`;
  const cases = [
    ['json', false], ['json', true], ['error', false], ['error', true], ['frame', true], ['events', true]
  ];
  for (const custom of [false, true]) {
    if (custom) {
      const saved = await admin.call(`/api/tenants/${tenantId}/relay/custom`, { method: 'PUT', body: { baseUrl: upstream.baseUrl, model: 'deepseek-chat', apiKey: UPSTREAM_KEY } });
      assert.equal(saved.status, 200, saved.text);
    }
    for (const [kind, stream] of cases) {
      const ledgerBefore = manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n;
      const metersBefore = manager.db.prepare("SELECT COUNT(*) n FROM meter_events WHERE tenant_id=? AND meter='desktop.llm.tokens'").get(tenantId).n;
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: `__oversized_${kind}__` }], max_tokens: 16, stream,
          _fish_attribution: { platform: 'desktop', chatKey: 'private:7459086882832384' } }), signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      assert.equal(response.status, stream && (kind === 'frame' || kind === 'events') ? 200 : 502, `${kind}, stream=${stream}`);
      assert.match(body, /upstream_response_too_large/);
      assert.doesNotMatch(body, /PRIVATE_FIXTURE|\[DONE\]/);
      assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
      assert.equal(manager.billing.activeHolds.size, 0);
      assert.equal(manager.relay.inflight.get(tenantId) || 0, 0);
      assert.equal(manager.db.prepare("SELECT COUNT(*) n FROM reservations WHERE tenant_id=? AND status='held'").get(tenantId).n, 0);
      const accepted = kind === 'events';
      assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n - ledgerBefore, !custom && accepted ? 1 : 0);
      assert.equal(manager.db.prepare("SELECT COUNT(*) n FROM meter_events WHERE tenant_id=? AND meter='desktop.llm.tokens'").get(tenantId).n - metersBefore, accepted ? 1 : 0);
      await waitFor(() => (upstream.stats.oversizeClosed || []).length >= (custom ? cases.length : 0) + cases.findIndex(c => c[0] === kind && c[1] === stream) + 1);
    }
  }
  assert.ok(upstream.stats.oversizeClosed.every(item => item.writes < 1000), 'relay closes each oversized upstream before it completes');
});

test('a live stream retains an expired hold and its original entry until settlement', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Long stream', slug: 'long-stream', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const balance = manager.billing.wallet(tenantId).balanceMicros;
  const response = await fetch(`http://127.0.0.1:${manager.config.relayPort}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '__review_hold_stream__' }], max_tokens: 16, stream: true,
      _fish_attribution: { platform: 'desktop', chatKey: 'private:7459086882832384' } }), signal: AbortSignal.timeout(5000)
  });
  const hold = manager.db.prepare("SELECT * FROM reservations WHERE tenant_id=? AND status='held'").get(tenantId);
  assert.ok(hold);
  manager.db.prepare('UPDATE reservations SET expires_at=0 WHERE id=?').run(hold.id);
  assert.equal(manager.billing.expireHolds(tenantId), 0);
  assert.equal(manager.billing.wallet(tenantId).heldMicros, hold.estimated_micros);
  assert.throws(() => manager.billing.reserve({ tenantId, keyId: hold.key_id, model: hold.model,
    estimatedMicros: balance, maxTokens: 1 }), error => error.code === 'INSUFFICIENT_BALANCE');
  manager.db.prepare("INSERT INTO tenant_entries(tenant_id,entry,enabled,updated_at) VALUES(?,'desktop',0,?) ON CONFLICT(tenant_id,entry) DO UPDATE SET enabled=0").run(tenantId, Date.now());
  upstream.stats.releaseReviewStream();
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  assert.ok(manager.billing.wallet(tenantId).balanceMicros < balance);
  assert.equal(manager.db.prepare('SELECT entry FROM ledger WHERE reservation_id=?').get(hold.id).entry, 'desktop');
  assert.equal(manager.db.prepare("SELECT COUNT(*) n FROM meter_events WHERE tenant_id=? AND meter='desktop.llm.tokens'").get(tenantId).n, 1);
});

test('a lost reservation cannot produce a successful stream', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env, admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Lost hold', slug: 'lost-hold', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const response = await fetch(`http://127.0.0.1:${manager.config.relayPort}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '__review_hold_stream__' }], max_tokens: 16, stream: true }),
    signal: AbortSignal.timeout(5000)
  });
  manager.db.prepare("UPDATE reservations SET status='expired' WHERE tenant_id=? AND status='held'").run(tenantId);
  upstream.stats.releaseReviewStream();
  let partial = '';
  await assert.rejects(async () => { for await (const chunk of response.body) partial += Buffer.from(chunk).toString('utf8'); });
  assert.doesNotMatch(partial, /\[DONE\]/);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 0);
});

test('meter write failure rolls back token charges and cannot crash a streaming Relay', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } });
  const created = await admin.createTenant({ name: 'Settlement failure', slug: 'settlement-failure', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const base = `http://127.0.0.1:${manager.config.relayPort}`;
  const balance = manager.billing.wallet(tenantId).balanceMicros;
  manager.db.exec("CREATE TRIGGER reject_review_meter BEFORE INSERT ON meter_events WHEN NEW.meter='desktop.llm.tokens' BEGIN SELECT RAISE(ABORT, 'fixture meter failure'); END");
  const body = { model: 'deepseek-chat', messages: [{ role: 'user', content: '__settlement_failure__' }], max_tokens: 16,
    _fish_attribution: { platform: 'desktop', chatKey: 'private:7459086882832384' } };
  const buffered = await callRelay(base, 'POST', '/v1/chat/completions', body, key);
  assert.equal(buffered.status, 500);
  assert.equal(buffered.json.error.code, 'settlement_failed');
  let partial = '';
  await assert.rejects(async () => {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(5000) });
    for await (const chunk of response.body) partial += Buffer.from(chunk).toString('utf8');
  });
  assert.match(partial, /pong from fake upstream/);
  assert.equal(partial.includes('[DONE]'), false, 'failed settlement must not report a completed stream');
  assert.equal(manager.billing.wallet(tenantId).balanceMicros, balance);
  assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 0);
  assert.equal(manager.db.prepare("SELECT COUNT(*) n FROM relay_logs WHERE tenant_id=? AND error='settlement_failed'").get(tenantId).n, 2);
  manager.db.exec('DROP TRIGGER reject_review_meter');
  const recovered = await callRelay(base, 'POST', '/v1/chat/completions', body, key);
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=?').get(tenantId).n, 1);
  assert.equal(manager.db.prepare("SELECT COUNT(*) n FROM meter_events WHERE tenant_id=? AND meter='desktop.llm.tokens'").get(tenantId).n, 1);
});

test('Relay never reflects upstream credentials in buffered or streaming HTTP errors', async t => {
  const upstream = await startFakeUpstream(); t.after(() => upstream.close());
  const env = await startManager(); t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  assert.equal((await admin.call('/api/admin/upstream', { method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY } })).status, 200);
  const created = await admin.createTenant({ name: 'Redaction', slug: 'relay-error-redaction', planId: 'starter' });
  const tenantId = created.json.tenant.id, key = manager.relayKeys.plaintext(tenantId);
  const balance = manager.billing.wallet(tenantId).balanceMicros;
  for (const stream of [false, true]) for (const status of [401, 403, 429, 500]) {
    const response = await callRelay(`http://127.0.0.1:${manager.config.relayPort}`, 'POST', '/v1/chat/completions', {
      model: 'deepseek-chat', messages: [{ role: 'user', content: `__reflect_error_${status}__` }], max_tokens: 16, stream
    }, key);
    assert.equal(response.status, status === 429 ? 429 : 502, response.text);
    assert.equal(response.text.includes(UPSTREAM_KEY), false);
    assert.equal(response.text.includes(key), false);
    assert.equal(response.text.includes('authorization'), false);
    assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  }
  for (const stream of [false, true]) {
    const response = await callRelay(`http://127.0.0.1:${manager.config.relayPort}`, 'POST', '/v1/chat/completions', {
      model: 'deepseek-chat', messages: [{ role: 'user', content: '__reflect_success_error__' }], max_tokens: 16, stream
    }, key);
    assert.equal(response.status, 502);
    assert.equal(response.text.includes(UPSTREAM_KEY), false);
    assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  }
  for (const marker of ['__invalid_string__', '__invalid_array__', '__invalid_tools__', '__invalid_truncated__']) {
    for (const stream of [false, true]) {
      const response = await callRelay(`http://127.0.0.1:${manager.config.relayPort}`, 'POST', '/v1/chat/completions', {
        model: 'deepseek-chat', messages: [{ role: 'user', content: marker }], max_tokens: 16, stream
      }, key);
      assert.equal(response.status, marker === '__invalid_tools__' && stream ? 200 : 502, response.text);
      assert.match(response.text, /upstream_(?:invalid_response|error)/);
      assert.equal(response.text.includes(UPSTREAM_KEY), false);
      assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
      assert.equal(manager.billing.wallet(tenantId).balanceMicros, balance, 'invalid upstream data cannot be billed');
    }
  }
  for (const marker of ['__reflect_stream_error__', '__reflect_multiline_error__', '__reflect_malformed_error__']) {
    const sse = await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: marker }], max_tokens: 16, stream: true
    }, key);
    assert.match(sse, /upstream_error/);
    assert.equal(sse.includes(UPSTREAM_KEY), false);
    assert.equal(sse.includes('authorization'), false);
    assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  }
  assert.equal(manager.billing.wallet(tenantId).balanceMicros, balance);
  const normal = await streamRelay(`http://127.0.0.1:${manager.config.relayPort}`, {
    model: 'deepseek-chat', messages: [{ role: 'user', content: '__multiline_success__' }], max_tokens: 16, stream: true
  }, key);
  assert.match(normal, /pong from fake upstream/); assert.match(normal, /\[DONE\]/);
  assert.ok(manager.billing.wallet(tenantId).balanceMicros < balance);
});

test('preserved Flash models have explicit platform prices and remain available to existing plans', () => {
  const catalog = listModels();
  for (const model of FLASH_MODELS) {
    assert.ok(catalog.some(entry => entry.id === model));
    assert.ok(listPlans().every(plan => planAllowsModel(plan, model)));
    assert.equal(calculateCostMicros(model, {
      prompt_tokens: 1000, cached_tokens: 200, completion_tokens: 100
    }), 2500);
  }
  assert.equal(calculateCostMicros('unconfigured-model', { prompt_tokens: 1000 }), null);
  assert.ok(listPlans().every(plan => !planAllowsModel(plan, 'unconfigured-model')));
});

test('Flash default, panel models, Relay models and billed requests agree', async (t) => {
  const upstream = await startFakeUpstream({ models: [...FLASH_MODELS, 'upstream-only-model'] });
  t.after(() => upstream.close());
  const env = await startManager({ defaultModel: 'deepseek-flash' });
  t.after(() => env.stop());
  const { manager } = env;
  const admin = await loginAdmin(manager);
  const saved = await admin.call('/api/admin/upstream', {
    method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY }
  });
  assert.equal(saved.status, 200, saved.text);
  const created = await admin.createTenant({ name: 'Flash models', slug: 'flash-models', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  assert.equal(manager.tenants.row(tenantId).default_model, 'deepseek-flash');
  const key = manager.relayKeys.plaintext(tenantId);
  const relayBase = `http://127.0.0.1:${manager.config.relayPort}`;
  const panel = await admin.call(`/api/tenants/${tenantId}/relay/models`);
  assert.equal(panel.status, 200, panel.text);
  assert.equal(panel.json.platformModel, 'deepseek-flash');
  assert.deepEqual(panel.json.models.map(entry => entry.id).sort(), [...FLASH_MODELS].sort());
  const models = await callRelay(relayBase, 'GET', '/v1/models', null, key);
  assert.equal(models.status, 200, models.text);
  assert.deepEqual(models.json.data.map(entry => entry.id).sort(), [...FLASH_MODELS].sort());

  for (const model of FLASH_MODELS) {
    const chat = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
      model, messages: [{ role: 'user', content: 'catalog regression' }], max_tokens: 16
    }, key);
    assert.equal(chat.status, 200, chat.text);
    assert.equal(chat.json.model, model);
    const usage = chat.json.usage;
    const expectedCost = Math.ceil(
      (usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens) * 2
      + usage.prompt_tokens_details.cached_tokens * 0.5 + usage.completion_tokens * 8);
    const ledger = manager.db.prepare('SELECT model, cost_micros FROM ledger WHERE request_id = ?')
      .get(chat.headers['x-fish-request-id']);
    assert.equal(ledger.model, model);
    assert.equal(ledger.cost_micros, expectedCost);
    assert.equal(Number(chat.headers['x-fish-cost-micros']), expectedCost);
    assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  }
});

test('relay models, chat completions, streaming and billing', async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const env = await startManager();
  t.after(() => env.stop());
  const { manager, config } = env;
  const admin = await loginAdmin(manager);

  const upstreamUpdate = await admin.call('/api/admin/upstream', {
    method: 'PUT', body: { baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY }
  });
  assert.equal(upstreamUpdate.status, 200, upstreamUpdate.text);
  assert.equal(upstreamUpdate.json.upstream.configured, true);
  assert.equal(upstreamUpdate.json.upstream.hasKey, true);
  assert.equal(upstreamUpdate.json.upstream.apiKey, undefined);

  const created = await admin.createTenant({ name: 'Relay Demo', slug: 'relay-demo', planId: 'starter' });
  assert.equal(created.status, 201, created.text);
  const tenantId = created.json.tenant.id;
  const key = manager.relayKeys.plaintext(tenantId);
  assert.ok(key.startsWith('sk-fish-'));
  const relayBase = `http://127.0.0.1:${manager.config.relayPort}`;

  const models = await callRelay(relayBase, 'GET', '/v1/models', null, key);
  assert.equal(models.status, 200, models.text);
  const ids = models.json.data.map((entry) => entry.id);
  assert.ok(ids.includes('deepseek-chat'));
  assert.ok(!ids.includes('upstream-only-model'));

  const unauthorized = await callRelay(relayBase, 'GET', '/v1/models', null, 'sk-fish-invalid');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json.error.type, 'authentication_error');

  const overviewBefore = await admin.call(`/api/tenants/${tenantId}/relay/overview`);
  assert.equal(overviewBefore.status, 200, overviewBefore.text);
  assert.equal(overviewBefore.json.relay.key.prefix, key.slice(0, 15));
  assert.equal(overviewBefore.json.relay.upstream.ok, true);
  assert.ok(overviewBefore.json.billing.balanceMicros > 0);

  const chat = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello relay' }],
    max_tokens: 32,
    temperature: 0,
    _fish_attribution: { platform: 'qq', chatKey: 'group:123', runId: 'run-1', vision: true }
  }, key);
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.choices[0].message.content, 'pong from fake upstream');
  assert.ok(chat.json.usage.prompt_tokens > 0);
  assert.ok(Number(chat.headers['x-fish-cost-micros']) > 0);
  assert.ok(chat.headers['x-fish-request-id']);

  const ledger = manager.db.prepare('SELECT * FROM ledger WHERE tenant_id = ?').all(tenantId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].model, 'deepseek-chat');
  assert.ok(ledger[0].cost_micros > 0);
  assert.equal(ledger[0].platform, 'qq');
  assert.equal(ledger[0].chat_key, 'group:123');
  assert.equal(ledger[0].run_id, 'run-1');
  assert.equal(ledger[0].vision, 1);
  assert.equal(ledger[0].usage_source, 'reported');
  assert.equal(ledger[0].cached_tokens, 2);
  assert.equal(upstream.stats.requests.at(-1).body._fish_attribution, undefined);
  const walletAfter = manager.billing.wallet(tenantId);
  assert.ok(walletAfter.balanceMicros < overviewBefore.json.billing.balanceMicros);
  assert.equal(walletAfter.heldMicros, 0);

  const disallowed = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'upstream-only-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8
  }, key);
  assert.equal(disallowed.status, 403);
  assert.equal(disallowed.json.error.code, 'model_not_allowed');

  const balanceBeforeFailure = manager.billing.wallet(tenantId).balanceMicros;
  const failed = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '__upstream_error__' }],
    max_tokens: 16
  }, key);
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.type, 'upstream_error');
  assert.equal(manager.billing.wallet(tenantId).balanceMicros, balanceBeforeFailure);
  assert.equal(manager.billing.wallet(tenantId).heldMicros, 0);
  assert.equal(manager.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE tenant_id = ? AND status = 'held'").get(tenantId).n, 0);

  const streamText = await streamRelay(relayBase, {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'stream please' }],
    max_tokens: 32,
    stream: true,
    _fish_attribution: { platform: 'bili', chatKey: 'group:4503599627370500', runId: 'run-2' }
  }, key);
  assert.match(streamText, /data: /);
  assert.match(streamText, /pong from fake upstream/);
  assert.match(streamText, /\[DONE\]/);
  const ledgerAfterStream = manager.db.prepare('SELECT * FROM ledger WHERE tenant_id = ?').all(tenantId);
  assert.equal(ledgerAfterStream.length, 2);
  assert.equal(ledgerAfterStream[1].platform, 'bili');
  assert.equal(ledgerAfterStream[1].usage_source, 'reported');
  assert.equal(ledgerAfterStream[1].cached_tokens, 2);
  const estimated = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: '__no_usage__' }], max_tokens: 8
  }, key);
  assert.equal(estimated.status, 200);
  assert.equal(manager.db.prepare('SELECT usage_source FROM ledger WHERE request_id = ?').get(estimated.headers['x-fish-request-id']).usage_source, 'estimated');
  await streamRelay(relayBase, { model: 'deepseek-chat', messages: [{ role: 'user', content: '__no_usage__' }], max_tokens: 8, stream: true, _fish_attribution: { platform: 'qq', chatKey: 'group:456' } }, key);
  assert.equal(manager.db.prepare("SELECT usage_source FROM ledger WHERE tenant_id = ? AND chat_key = 'group:456'").get(tenantId).usage_source, 'estimated');
  const invalid = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }], _fish_attribution: { tenantId: 'other' }
  }, key);
  assert.equal(invalid.status, 400);

  manager.db.prepare('UPDATE wallets SET balance_micros = 0, updated_at = ? WHERE tenant_id = ?').run(Date.now(), tenantId);
  const noBalance = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: 'broke' }], max_tokens: 16
  }, key);
  assert.equal(noBalance.status, 402);
  assert.equal(noBalance.json.error.type, 'insufficient_quota');

  const topup = await admin.call(`/api/tenants/${tenantId}/relay/topup`, {
    method: 'POST', body: { amountMicros: 1_000_000, note: 'test topup' }
  });
  assert.equal(topup.status, 200, topup.text);
  assert.equal(topup.json.billing.balanceMicros, 1_000_000);

  // Rate limit with a trial tenant (10 RPM).
  const trial = await admin.createTenant({ name: 'Rate Demo', slug: 'rate-demo', planId: 'trial' });
  assert.equal(trial.status, 201, trial.text);
  const trialId = trial.json.tenant.id;
  const trialKey = manager.relayKeys.plaintext(trialId);
  let limited = null;
  for (let i = 0; i < 11; i += 1) {
    const response = await callRelay(relayBase, 'POST', '/v1/chat/completions', {
      model: 'deepseek-chat', messages: [{ role: 'user', content: `rate ${i}` }], max_tokens: 4
    }, trialKey);
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 200, response.text);
  }
  assert.ok(limited, 'expected a 429 rate limit response');
  assert.equal(limited.json.error.code, 'rate_limit_exceeded');
  assert.ok(Number(limited.headers['retry-after']) >= 1);

  await waitFor(async () => {
    const overview = await admin.call(`/api/tenants/${tenantId}/relay/overview`);
    return overview.json.usage.totals.requests >= 2 ? overview : null;
  }, { label: 'relay usage summary' });
  const overview = await admin.call(`/api/tenants/${tenantId}/relay/overview`);
  assert.equal(overview.json.billing.currency, 'CNY');
  assert.ok(overview.json.usage.daily.length >= 1);
  assert.ok(overview.json.usage.byModel.some((entry) => entry.model === 'deepseek-chat'));
  assert.ok(overview.json.usage.byChat.some(row => row.platform === 'qq' && row.chatKey === 'group:123' && row.visionRequests === 1));
  assert.ok(overview.json.usage.byChat.some(row => row.platform === 'bili' && row.chatKey === 'group:4503599627370500'));
  assert.equal(overview.json.usage.usageSources.estimated, 2);
  assert.equal(overview.json.usage.visionRequests, 1);
  const trialOverview = await admin.call(`/api/tenants/${trialId}/relay/overview`);
  assert.ok(!trialOverview.json.usage.byChat.some(row => row.chatKey === 'group:123'));
});

function callRelay(base, method, pathname, body, key) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: new URL(base).port, path: pathname, method,
      headers: {
        authorization: key ? `Bearer ${key}` : '',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function streamRelay(base, body, key) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: new URL(base).port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('official QQ OpenID attribution and tenant-bound Relay meter endpoint', async (t) => {
  const upstream=await startFakeUpstream(); t.after(()=>upstream.close());
  const env=await startManager(); t.after(()=>env.stop()); const {manager}=env; const admin=await loginAdmin(manager);
  assert.equal((await admin.call('/api/admin/upstream',{method:'PUT',body:{baseUrl:upstream.baseUrl,apiKey:UPSTREAM_KEY}})).status,200);
  const a=await admin.createTenant({name:'Official A',slug:'official-a',planId:'starter'});
  const b=await admin.createTenant({name:'Official B',slug:'official-b',planId:'starter'});
  const aid=a.json.tenant.id, bid=b.json.tenant.id, key=manager.relayKeys.plaintext(aid), base=`http://127.0.0.1:${manager.config.relayPort}`;
  // Explicit injection also exercises deployments that construct Relay independently.
  const {LedgerBillingProvider}=await import('../src/billing/provider.js'); manager.relay.billingProvider=new LedgerBillingProvider({db:manager.db,wallet:manager.billing});
  for(const platform of ['qq','qqbot']) {
    const result=await callRelay(base,'POST','/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'hello'}],max_tokens:16,_fish_attribution:{platform,chatKey:'group:qqbot_group_OpenID_123'}},key);
    assert.equal(result.status,200,result.text); const row=manager.db.prepare('SELECT platform,entry FROM ledger WHERE request_id=?').get(result.headers['x-fish-request-id']); assert.equal(row.platform,'qqbot'); assert.equal(row.entry,'qq_official');
  }
  for(const chatKey of ['private:qqbot_user_OpenID-1','private:qqbot_dm_OpenID-2','group:qqbot_channel_OpenID-3','group:qqbot_group_'+ 'A'.repeat(128)]) {
    const result=await callRelay(base,'POST','/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'hello'}],max_tokens:16,_fish_attribution:{platform:'qqbot',chatKey}},key);
    assert.equal(result.status,200,result.text);
    assert.equal(manager.db.prepare('SELECT chat_key FROM ledger WHERE request_id=?').get(result.headers['x-fish-request-id']).chat_key,chatKey);
  }
  const toolStream = await callRelay(base,'POST','/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'__tools_only__ __no_usage__'}],stream:true,max_tokens:256,_fish_attribution:{platform:'qqbot',chatKey:'private:qqbot_user_StreamTest'}},key);
  assert.equal(toolStream.status,200,toolStream.text);
  const toolUsage=manager.db.prepare('SELECT completion_tokens,usage_source FROM ledger WHERE request_id=?').get(toolStream.headers['x-fish-request-id']);
  assert.ok(toolUsage.completion_tokens>10,'fallback metering must include streamed tool arguments');assert.equal(toolUsage.usage_source,'estimated');
  const invalid=await callRelay(base,'POST','/v1/chat/completions',{model:'deepseek-chat',messages:[{role:'user',content:'hello'}],_fish_attribution:{platform:'qqbot',chatKey:'private:qqbot_group_bad'}},key); assert.equal(invalid.status,400);
  const event={tenantId:bid,idempotencyKey:'e1',entry:'desktop',meter:'desktop.message.in',quantity:1,unit:'count',source:'agent',occurredAt:Date.now()};
  const forged=await callRelay(base,'POST','/v1/fish/meter-events',{events:[event]},key); assert.equal(forged.status,400);
  event.tenantId=aid; const first=await callRelay(base,'POST','/v1/fish/meter-events',{events:[event]},key); assert.equal(first.status,200,first.text); assert.equal(first.json.accepted,1);
  const repeat=await callRelay(base,'POST','/v1/fish/meter-events',{events:[event]},key); assert.equal(repeat.json.duplicates,1);
});
