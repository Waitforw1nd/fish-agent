import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

export function registerRelayBillingRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summary, listSummaries, updateAgentRelayConfig } = deps;
  // Relay / billing
  router.get('/api/tenants/:id/relay/overview', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    const key = relayKeys.active(tenant.id);
    const wallet = billing.wallet(tenant.id);
    const usage = billing.usageSummary(tenant.id, { days: Number(ctx.url.searchParams.get('days')) || 30 });
    const models = await relay.panelModels(tenant);
    const keyMasked = key ? `${key.key_prefix}••••` : '';
    const custom = customUpstreams.public(tenant);
    const model = custom.model;
    const totalsView = { ...usage.totals, currency: 'CNY', available: true, totalTokens: usage.totals.promptTokens + usage.totals.completionTokens };
    const usageView = {
      ...usage,
      currency: 'CNY',
      estimatedLocally: usage.usageSources.estimated > 0,
      source: 'relay-ledger',
      totals: totalsView,
      total: totalsView,
      today: { ...usage.today, currency: 'CNY', available: true, totalTokens: (usage.today.promptTokens || 0) + (usage.today.completionTokens || 0) },
      daily: (usage.daily || []).map((day) => ({
        ...day,
        currency: 'CNY',
        totals: { ...day.totals, currency: 'CNY', available: true },
        models: (day.models || []).map((entry) => ({
          ...entry, currency: 'CNY', available: true, totalTokens: entry.promptTokens + entry.completionTokens
        }))
      })),
      byModel: (usage.byModel || []).map((entry) => ({
        ...entry, currency: 'CNY', available: true, totalTokens: entry.promptTokens + entry.completionTokens
      }))
    };
    const relayView = {
      configured: Boolean(key),
      hasKey: Boolean(key),
      keyMasked,
      keyStatus: key ? 'active' : 'missing',
      model,
      source: custom.source,
      key: key ? { prefix: key.key_prefix, createdAt: key.created_at, lastUsedAt: key.last_used_at } : null,
      plan: {
        id: plan.id, name: plan.name, rpm: plan.rpm, tpm: plan.tpm,
        maxOutputTokens: plan.maxOutputTokens, maxConcurrent: plan.maxConcurrent,
        monthlyCreditMicros: plan.monthlyCreditMicros, models: [...plan.models]
      },
      quota: {
        planName: plan.name,
        costLimitMicros: null,
        costUsedMicros: null,
        tokenLimit: null,
        tokenUsed: null,
        requestsLimit: null,
        requestsUsed: null,
        rpm: plan.rpm,
        tpm: plan.tpm,
        periodStart: null,
        periodEnd: tenant.expires_at || null
      },
      upstream: {
        configured: custom.configured ? custom.hasKey : relay.upstreamPublic().configured,
        source: custom.source,
        ok: models.upstream.ok,
        error: models.upstream.error,
        modelCount: models.upstream.count
      },
      billing: { ...wallet, currency: 'CNY', unit: 'micro-yuan' },
      usage: usageView,
      lastError: models.upstream.ok ? null : models.upstream.error,
      updatedAt: Date.now()
    };
    sendJson(ctx.res, 200, {
      ok: true,
      relay: relayView,
      billing: { ...wallet, currency: 'CNY', unit: 'micro-yuan' },
      usage: usageView,
      models
    });
  });

  router.get('/api/tenants/:id/relay/models', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const models = await relay.panelModels(tenant);
    const allowed = models.models.filter((entry) => entry.allowed);
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    const platformModels = plan.models.includes('*')
      ? (models.source === 'platform' ? allowed : [])
      : plan.models.map((id) => ({ id, allowed: true }));
    sendJson(ctx.res, 200, { ok: true, ...models, models: allowed, allModels: models.models,
      platformModels, platformModel: tenant.default_model || config.defaultModel || '' });
  });

  router.get('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const custom = customUpstreams.public(tenant);
    sendJson(ctx.res, 200, { ok: true, ...custom, custom });
  });

  router.put('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const { result: custom, restartRequired } = await updateAgentRelayConfig(tenant, (fresh) => customUpstreams.update(fresh, body));
    audit.record({
      actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'relay.custom.update',
      detail: { baseUrl: custom.baseUrl, model: custom.model, hasKey: custom.hasKey }, ip: ctx.ip
    });
    sendJson(ctx.res, 200, { ok: true, ...custom, custom, restartRequired });
  });

  router.delete('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const { result: custom, restartRequired } = await updateAgentRelayConfig(tenant, (fresh) => customUpstreams.delete(fresh));
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'relay.custom.delete', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...custom, custom, restartRequired });
  });

  router.post('/api/tenants/:id/relay/custom/test', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const result = await customUpstreams.probe(tenant, await readBody(ctx));
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'relay.custom.test',
      detail: { connected: result.connected }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...result, test: result });
  });

  router.get('/api/tenants/:id/relay/logs', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const days = parseQueryInt(ctx.url.searchParams, 'days', 30, 1, 365);
    const limit = parseQueryInt(ctx.url.searchParams, 'limit', 100, 1, 500);
    const model = String(ctx.url.searchParams.get('model') || '').trim();
    if (model.length > 200) throw httpError(400, 'INVALID_LOG_MODEL', 'model 筛选条件不能超过 200 字符');
    const status = String(ctx.url.searchParams.get('status') || '').trim();
    const logs = billing.relayLogs(tenant.id, { days, limit, model, status });
    sendJson(ctx.res, 200, { ok: true, logs });
  });

  router.get('/api/tenants/:id/billing/recharges', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, recharges: billing.recharges(tenant.id) });
  });

  router.get('/api/tenants/:id/billing/transactions', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const limit = parseQueryInt(ctx.url.searchParams, 'limit', 100, 1, 500);
    sendJson(ctx.res, 200, { ok: true, transactions: billing.transactions(tenant.id, limit) });
  });

  router.post('/api/tenants/:id/billing/recharges', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const recharge = billing.createRecharge(tenant.id, body.amountMicros, ctx.auth.user.id);
    audit.record({
      actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'billing.recharge.create',
      detail: { rechargeId: recharge.id, amountMicros: recharge.amountMicros }, ip: ctx.ip
    });
    sendJson(ctx.res, 201, { ok: true, recharge });
  });

  router.put('/api/tenants/:id/relay/key', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const providedKey = typeof body.key === 'string' ? body.key.trim() : '';
    const providedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const { result: issued, fresh, restartRequired } = await updateAgentRelayConfig(tenant, (current) => {
      const plan = getPlan(current.plan_id) || getPlan('trial');
      if (!providedKey && !providedModel && !relayKeys.active(tenant.id)) {
        throw httpError(400, 'RELAY_KEY_REQUIRED', '请输入 Relay Key 或选择默认模型');
      }
      if (providedModel) {
        if (providedModel.length > 200 || !(plan.models.includes('*') || plan.models.includes(providedModel))) {
          throw httpError(400, 'MODEL_NOT_ALLOWED', `模型 ${providedModel} 不在当前套餐白名单内`);
        }
        tenants.setDefaultModel(tenant.id, providedModel);
      }
      if (providedKey) return relayKeys.bind(tenant.id, providedKey);
      if (!relayKeys.active(tenant.id)) return relayKeys.issue(tenant.id);
      return null;
    });
    audit.record({
      actorUserId: ctx.auth.user.id,
      tenantId: tenant.id,
      action: providedKey ? 'relay.key.bind' : 'relay.key.rotate',
      detail: { keyPrefix: issued?.prefix || relayKeys.active(tenant.id)?.key_prefix, model: providedModel || null },
      ip: ctx.ip
    });
    const active = relayKeys.active(tenant.id);
    const { model, source } = customUpstreams.public(fresh);
    sendJson(ctx.res, 200, {
      ok: true,
      key: issued?.key || undefined,
      keyPrefix: active?.key_prefix || null,
      model,
      source,
      createdAt: active?.created_at || null,
      configured: Boolean(active),
      restartRequired,
      relay: {
        configured: Boolean(active),
        keyMasked: active ? `${active.key_prefix}••••` : '',
        keyStatus: active ? 'active' : 'missing',
        model,
        source
      }
    });
  });

  router.post('/api/tenants/:id/relay/topup', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可充值');
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const wallet = billing.credit(tenant.id, body.amountMicros, body.note || '管理员充值');
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'billing.credit', detail: { amountMicros: body.amountMicros }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, billing: { ...wallet, currency: 'CNY' } });
  });

}
