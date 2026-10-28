import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMe,
  normalizeTenant,
  normalizeTenantList,
  normalizeQQStatus,
  normalizeQr,
  normalizeSubscriptions,
  normalizeBiliConfig,
  buildBiliConfigPayload,
  normalizeBiliStatus,
  normalizeBiliLogin,
  normalizeRelayOverview,
  normalizeModels,
  normalizeQuota,
  normalizeBilling,
  normalizeTotals
} from '../lib/normalize.js';

const NOW = Date.parse('2026-10-28T08:00:00Z');
const PNG = `data:image/png;base64,${'A'.repeat(96)}`;

test('账单归一化保留会话、估算和含图片请求成本', () => {
  const billing = normalizeBilling({ usage: { byChat: [{ date: '2026-10-28', model: 'm', platform: 'bili', chatKey: 'group:4503599627370500', costMicros: 12, visionRequests: 1, visionRequestCostMicros: 12, usageSources: { estimated: 1 } }], usageSources: { estimated: 1 }, visionRequests: 1, visionRequestCostMicros: 12 } });
  assert.equal(billing.byChat[0].chatKey, 'group:4503599627370500');
  assert.equal(billing.byChat[0].usageSources.estimated, 1);
  assert.equal(billing.visionRequestCostMicros, 12);
});

test('normalizeMe 容忍 user / 直接对象', () => {
  const me = normalizeMe({ user: { id: 'u1', username: 'alice', displayName: 'Alice', role: 'admin' } });
  assert.equal(me.id, 'u1');
  assert.equal(me.username, 'alice');
  assert.equal(me.displayName, 'Alice');
  assert.equal(me.role, 'admin');
  const direct = normalizeMe({ id: 'u2', name: 'bob', roles: ['owner'] });
  assert.equal(direct.username, 'bob');
  assert.equal(direct.role, 'owner');
});

test('normalizeTenantList 支持数组和多种包装', () => {
  const list = normalizeTenantList({ tenants: [{ id: 't1', name: 'A' }, { id: '', name: 'bad' }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 't1');
  assert.equal(normalizeTenantList([{ id: 't2', name: 'B' }])[0].name, 'B');
  assert.equal(normalizeTenantList({ data: { tenants: [{ id: 't3' }] } })[0].id, 't3');
  assert.deepEqual(normalizeTenantList({ nope: true }), []);
});

test('normalizeTenant 汇总计划、到期、QQ/B 站/Relay 状态', () => {
  const tenant = normalizeTenant({
    tenant: {
      id: 7,
      name: '小鱼',
      slug: 'fish',
      status: 'running',
      plan: { name: 'Pro' },
      expiresAt: '2026-11-20T00:00:00Z',
      qq: { phase: 'online', uin: 10001, nickname: 'QQ 小号', kernel: 'llbot', onebot: { connected: true, port: 3001 } },
      bili: { mid: '42', nickname: 'UP', cookieHealthy: true },
      relay: { configured: true, keyMasked: 'sk-••••••abcd' }
    }
  }, { now: NOW });
  assert.equal(tenant.id, '7');
  assert.equal(tenant.slug, 'fish');
  assert.equal(tenant.status, 'running');
  assert.equal(tenant.plan.name, 'Pro');
  assert.equal(tenant.expiry.state, 'ok');
  assert.equal(tenant.qq.phase, 'online');
  assert.equal(tenant.qq.onebotConnected, true);
  assert.equal(tenant.bili.loggedIn, true);
  assert.equal(tenant.relay.configured, true);
  assert.ok(!('raw' in tenant));
});

test('normalizeTenant 到期覆盖运行状态，stopped 不再被误判为运行', () => {
  const expired = normalizeTenant({ id: 't', status: 'running', expiresAt: '2026-10-01T00:00:00Z' }, { now: NOW });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.running, false);
  const stopped = normalizeTenant({ id: 't2', status: 'stopped', qq: { phase: 'stopped' } }, { now: NOW });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.qq.running, false);
});

test('normalizeQQStatus 处理 running / 扫码 / token 状态且不回显秘密', () => {
  const online = normalizeQQStatus({
    status: 'running',
    loggedIn: true,
    uin: '12345',
    nickname: '小号',
    kernel: 'LLBot',
    authToken: 'sk-super-secret-token-value',
    authTokenStatus: { status: 'invalid', message: 'token expired' },
    onebot: { connected: true, port: 3001, tokenConfigured: true },
    version: { qq: '9.9.9', aligned: true }
  });
  assert.equal(online.phase, 'online');
  assert.equal(online.running, true);
  assert.equal(online.onebotConnected, true);
  assert.equal(online.onebotPort, 3001);
  assert.equal(online.authTokenStatus, 'invalid');
  assert.equal(online.version, '9.9.9');
  assert.equal(online.expectedUin, '');
  assert.equal(online.versionAligned, true);
  assert.ok(!JSON.stringify(online).includes('sk-super-secret'));

  const waiting = normalizeQQStatus({ phase: 'waiting_login', qrAvailable: true, expectedUin: 10086 });
  assert.equal(waiting.phase, 'waiting_login');
  assert.equal(waiting.expectedUin, '10086');
  assert.equal(waiting.qrAvailable, true);
  assert.equal(waiting.tone, 'warn');

  const stopped = normalizeQQStatus({ phase: 'stopped' });
  assert.equal(stopped.running, false);
  const missing = normalizeQQStatus(undefined);
  assert.equal(missing.available, false);
  assert.equal(normalizeQQStatus({ phase: '已扫码待确认' }).phase, 'waiting_confirm');
  assert.equal(normalizeQQStatus({ phase: 'error', error: { message: 'boom' } }).error, 'boom');
});

test('normalizeQr 保留外层过期时间并识别扫码状态', () => {
  const qr = normalizeQr({ qrcode: PNG, expiresAt: '2026-10-28T08:02:00Z' }, { now: NOW });
  assert.equal(qr.imageSrc, PNG);
  assert.equal(qr.status, 'waiting');
  assert.equal(qr.expired, false);
  assert.equal(qr.expiresAt, '2026-10-28T08:02:00.000Z');

  const ok = normalizeQr({ image: PNG, status: 'ok' }, { now: NOW });
  assert.equal(ok.status, 'waiting');

  const scanned = normalizeQr({ qrCode: { image: PNG, status: 'scanned' } }, { now: NOW });
  assert.equal(scanned.status, 'scanned');

  const expired = normalizeQr({ image: PNG, expiresAt: '2026-10-28T07:59:00Z' }, { now: NOW });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expired, true);

  const fromString = normalizeQr('A'.repeat(96), { now: NOW });
  assert.match(fromString.imageSrc, /^data:image\/png;base64,/);

  const unsafe = normalizeQr({ image: 'javascript:alert(1)' }, { now: NOW });
  assert.equal(unsafe.imageSrc, null);

  const ttl = normalizeQr({ image: PNG, expiresIn: 60 }, { now: NOW });
  assert.equal(ttl.expiresAt, new Date(NOW + 60_000).toISOString());
});

test('normalizeSubscriptions 支持嵌套、扁平别名与部分已知', () => {
  const all = normalizeSubscriptions({ subscriptions: { mentions: true, upVideos: true, privateMessages: true, liveRooms: true } });
  assert.deepEqual(all.subscriptions, { mentions: true, upVideos: true, privateMessages: true, liveRooms: true });
  assert.equal(all.complete, true);

  const flat = normalizeSubscriptions({ replyMentions: true, newVideos: true, dm: true, live: true });
  assert.deepEqual(flat.subscriptions, { mentions: true, upVideos: true, privateMessages: true, liveRooms: true });

  const partial = normalizeSubscriptions({ subscriptions: { mentions: true } });
  assert.equal(partial.subscriptions.mentions, true);
  assert.equal(partial.known.liveRooms, false);
  assert.equal(partial.complete, false);

  const empty = normalizeSubscriptions(null);
  assert.equal(empty.available, false);
  assert.equal(empty.known.mentions, false);

  assert.deepEqual(buildBiliConfigPayload({ mentions: 1, upVideos: false }), {
    subscriptions: { mentions: true, upVideos: false, privateMessages: false, liveRoom: false }
  });
});

test('normalizeBiliConfig 识别 config 包装', () => {
  const config = normalizeBiliConfig({ config: { subscriptions: { mentions: true, liveRooms: true } } });
  assert.equal(config.available, true);
  assert.equal(config.subscriptions.mentions, true);
  assert.equal(config.known.liveRooms, true);
});

test('normalizeBiliStatus 不回传 Cookie 秘密，四类订阅来自状态', () => {
  const status = normalizeBiliStatus({
    loggedIn: true,
    mid: 42,
    nickname: 'UP 主',
    cookie: { healthy: true, SESSDATA: 'secret-cookie', bili_jct: 'secret-csrf' },
    subscriptions: { mentions: true, upVideos: true, privateMessages: false, liveRooms: true },
    lastPollAt: '2026-10-28T07:59:00Z',
    rateLimited: true
  });
  assert.equal(status.loggedIn, true);
  assert.equal(status.mid, '42');
  assert.equal(status.cookieHealthy, true);
  assert.equal(status.subscriptions.mentions, true);
  assert.equal(status.rateLimited, true);
  assert.ok(!JSON.stringify(status).includes('secret-cookie'));
  assert.ok(!JSON.stringify(status).includes('secret-csrf'));

  const offline = normalizeBiliStatus(null);
  assert.equal(offline.available, false);
  assert.equal(offline.phase, 'unknown');
});

test('normalizeBiliLogin 识别 waiting / scanned / confirmed / expired', () => {
  assert.equal(normalizeBiliLogin({ status: 'waiting' }).status, 'waiting');
  assert.equal(normalizeBiliLogin({ status: 'scanned' }).status, 'scanned');
  const success = normalizeBiliLogin({ status: 'success', user: { mid: '9', nickname: '小明' } });
  assert.equal(success.status, 'confirmed');
  assert.equal(success.loggedIn, true);
  assert.equal(success.mid, '9');
  assert.equal(success.nickname, '小明');
  assert.equal(normalizeBiliLogin({ status: 'ok', nickname: '有昵称' }).status, 'confirmed');
  assert.equal(normalizeBiliLogin({ status: 'expired' }).status, 'expired');
  assert.equal(normalizeBiliLogin({ loggedIn: true }).status, 'confirmed');
});

test('normalizeRelayOverview 隐藏原始 Key，归一化额度与账单', () => {
  const overview = normalizeRelayOverview({
    relay: {
      key: 'sk-real-secret-key-123456',
      configured: true,
      model: 'model-a',
      baseUrl: 'https://upstream.example/v1',
      keyStatus: { status: 'active' },
      quota: {
        costLimitMicros: 10_000_000,
        costUsedMicros: 2_500_000,
        tokenLimit: 1_000_000,
        tokenUsed: 200_000,
        requestsLimit: 1000,
        requestsUsed: 20,
        rpm: 60,
        tpm: 120000,
        planName: 'Pro',
        periodStart: '2026-10-01T00:00:00Z',
        periodEnd: '2026-11-01T00:00:00Z'
      },
      daily: [
        {
          date: '2026-10-28',
          models: [
            { model: 'model-a', promptTokens: 1000, completionTokens: 500, cachedTokens: 200, visionTokens: 10, requests: 2, costMicros: 12345 },
            { model: 'model-b', promptTokens: 500, completionTokens: 250, cachedTokens: 0, requests: 1, costMicros: 5000 }
          ],
          totals: { requests: 3, promptTokens: 1500, completionTokens: 750, cachedTokens: 200, visionTokens: 10, totalTokens: 2260, costMicros: 17345 }
        },
        {
          date: '2026-10-27',
          models: { 'model-a': { promptTokens: 100, completionTokens: 50, requests: 1, cost: 0.001 } }
        }
      ],
      today: { requests: 3, totalTokens: 2260, costMicros: 17345 },
      total: { requests: 4, totalTokens: 2410, costMicros: 18345 },
      localEstimate: { requests: 3, totalTokens: 2200, cost: 0.0173 }
    }
  });

  assert.equal(overview.configured, true);
  assert.ok(!JSON.stringify(overview).includes('sk-real-secret-key'));
  assert.match(overview.keyMasked, /^sk-••••••3456$/);
  assert.equal(overview.keyStatus.status, 'active');
  assert.equal(overview.model, 'model-a');
  assert.equal(overview.baseHost, 'upstream.example');
  assert.equal(overview.quota.costLimitMicros, 10_000_000);
  assert.equal(overview.quota.tokenUsed, 200_000);
  assert.equal(overview.billing.days.length, 2);
  assert.equal(overview.billing.days[0].date, '2026-10-28');
  assert.equal(overview.billing.days[0].models[0].model, 'model-a');
  assert.equal(overview.billing.days[1].models[0].costMicros, 1000);
  assert.equal(overview.billing.today.costMicros, 17345);
  assert.equal(overview.billing.total.requests, 4);
  assert.equal(overview.localEstimate.costMicros, 17300);
});

test('normalizeBilling 支持 byModel 累计回退与小数金额', () => {
  const billing = normalizeBilling({
    byModel: { 'model-x': { requests: 2, promptTokens: 10, completionTokens: 5, cost: 0.002 } },
    total: { requests: 2, promptTokens: 10, completionTokens: 5, cost: 0.002 },
    currency: 'USD'
  }, { now: new Date(NOW) });
  assert.equal(billing.hasDaily, false);
  assert.equal(billing.byModel.length, 1);
  assert.equal(billing.byModel[0].costMicros, 2000);
  assert.equal(billing.currency, 'USD');
  assert.equal(billing.total.costMicros, 2000);
});

test('normalizeQuota 支持显式字段与 unit 语义', () => {
  const cost = normalizeQuota({ costLimitMicros: 5_000_000, costUsedMicros: 1_000_000 });
  assert.equal(cost.costLimitMicros, 5_000_000);
  const token = normalizeQuota({ limit: 1000, used: 100, unit: 'tokens' });
  assert.equal(token.tokenLimit, 1000);
  assert.equal(token.tokenUsed, 100);
  const ambiguous = normalizeQuota({ limit: 1000000, used: 10 });
  assert.equal(ambiguous.costLimitMicros, null);
  assert.equal(ambiguous.tokenLimit, null);
});

test('normalizeTotals 计算总计但不重复计算缓存', () => {
  const totals = normalizeTotals({ promptTokens: 100, completionTokens: 50, cachedTokens: 25, visionTokens: 5, costMicros: 123 });
  assert.equal(totals.totalTokens, 155);
  assert.equal(totals.cachedTokens, 25);
  assert.equal(totals.costMicros, 123);
  assert.equal(totals.available, true);
});

test('normalizeModels 兼容 OpenAI 列表、字符串和去重', () => {
  const models = normalizeModels({
    object: 'list',
    data: [
      { id: 'gpt-x', context_length: 128000, pricing: { prompt: 0.1, completion: 0.2 }, owned_by: 'cloud' },
      { id: 'gpt-x' },
      'plain-model'
    ]
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gpt-x');
  assert.equal(models[0].contextWindow, 128000);
  assert.match(models[0].priceLabel, /入 0.1/);
  assert.equal(models[1].id, 'plain-model');
  assert.deepEqual(normalizeModels([]), []);
});

test('normalizeRelayOverview 对齐真实后端钱包、套餐与 usage', () => {
  const overview = normalizeRelayOverview({
    relay: {
      configured: true,
      keyMasked: 'sk-abcdefghi••••',
      key: { prefix: 'sk-abcdefghi', createdAt: 1, lastUsedAt: 2 },
      keyStatus: 'active',
      model: 'deepseek-chat',
      plan: {
        id: 'pro', name: '专业套餐', rpm: 240, tpm: 2_000_000,
        monthlyCreditMicros: 150_000_000, maxOutputTokens: 8192, maxConcurrent: 12,
        models: ['deepseek-chat']
      },
      quota: {
        planName: '专业套餐', costLimitMicros: null, costUsedMicros: null,
        tokenLimit: null, tokenUsed: null, requestsLimit: null, requestsUsed: null,
        rpm: 240, tpm: 2_000_000, periodStart: null, periodEnd: 1_800_000_000_000
      },
      billing: { balanceMicros: 12_000_000, heldMicros: 1_000_000, availableMicros: 11_000_000, currency: 'CNY' },
      usage: {
        days: 30,
        totals: { requests: 3, promptTokens: 100, completionTokens: 50, cachedTokens: 20, costMicros: 1234 },
        today: { requests: 2, promptTokens: 80, completionTokens: 40, cachedTokens: 10, costMicros: 1000 },
        daily: [{
          date: '2026-10-28',
          requests: 2,
          totals: { requests: 2, promptTokens: 80, completionTokens: 40, cachedTokens: 10, totalTokens: 120, costMicros: 1000 },
          models: [{ model: 'deepseek-chat', requests: 2, promptTokens: 80, completionTokens: 40, cachedTokens: 10, totalTokens: 120, costMicros: 1000 }]
        }],
        byModel: [{ model: 'deepseek-chat', requests: 3, promptTokens: 100, completionTokens: 50, cachedTokens: 20, totalTokens: 150, costMicros: 1234 }]
      },
      lastError: null,
      updatedAt: 1_800_000_000_000
    }
  });
  assert.equal(overview.configured, true);
  assert.match(overview.keyMasked, /sk-abcdefghi/);
  assert.equal(overview.plan.monthlyCreditMicros, 150_000_000);
  assert.equal(overview.plan.maxConcurrent, 12);
  assert.equal(overview.wallet.available, true);
  assert.equal(overview.wallet.availableMicros, 11_000_000);
  assert.equal(overview.quota.planName, '专业套餐');
  assert.equal(overview.quota.rpm, 240);
  assert.equal(overview.quota.periodEnd, 1_800_000_000_000);
  assert.equal(overview.billing.windowDays, 30);
  assert.equal(overview.billing.today.costMicros, 1000);
  assert.equal(overview.billing.days.length, 1);
});

test('normalizeBiliLogin 将桥接未运行识别为错误', () => {
  const stopped = normalizeBiliLogin({ state: 'stopped', status: 'unknown', online: false, message: 'B站桥接未运行' });
  assert.equal(stopped.status, 'error');
  const confirmed = normalizeBiliLogin({ state: 'success', status: 'confirmed', online: true, mid: 1, nickname: 'UP' });
  assert.equal(confirmed.status, 'confirmed');
});
