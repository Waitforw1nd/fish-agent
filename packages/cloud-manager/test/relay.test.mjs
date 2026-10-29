import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loginAdmin, startManager, waitFor } from './helpers.mjs';
import { startFakeUpstream, UPSTREAM_KEY } from './fixtures/fake-upstream.mjs';
import { listModels, listPlans, planAllowsModel } from '../src/plans.js';
import { calculateCostMicros } from '../src/pricing.js';

const FLASH_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision', 'deepseek-v4.1-flash'];

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
