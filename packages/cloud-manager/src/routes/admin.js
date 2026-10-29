import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

export function registerAdminRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summaries, listSummaries, updateAgentRelayConfig, requireAdmin } = deps;
  // Admin
  router.get('/api/admin/overview', async (ctx) => {
    const { user } = requireAdmin(ctx);
    const instances = await listSummaries(user);
    const accounts = users.list();
    const stats = billing.platformStats();
    const ts = Date.now();
    const counts = {
      total: instances.length,
      running: instances.filter((entry) => entry.status === 'running').length,
      ready: instances.filter((entry) => entry.readiness.ready).length,
      expiring: instances.filter((entry) => entry.subscriptionStatus === 'active' && Number(entry.expiresAt) > ts && Number(entry.expiresAt) <= ts + 3 * 86400000).length,
      suspended: instances.filter((entry) => entry.subscriptionStatus === 'suspended').length,
      expired: instances.filter((entry) => entry.subscriptionStatus === 'expired').length
    };
    const overview = {
      tenants: counts,
      users: { total: accounts.length, active: accounts.filter((entry) => !entry.disabled).length,
        disabled: accounts.filter((entry) => entry.disabled).length,
        admins: accounts.filter((entry) => entry.role === 'admin' && !entry.disabled).length },
      pendingRecharges: stats.pendingRecharges,
      usage: { today: stats.today, last7Days: stats.last7Days },
      upstream: relay.upstreamPublic(),
      drivers: await qq.drivers()
    };
    sendJson(ctx.res, 200, { ok: true, overview });
  });

  router.get('/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { ok: true, users: users.list() });
  });

  router.get('/api/admin/users/:userId/tenants', async (ctx) => {
    requireAdmin(ctx);
    const user = users.byId(ctx.params.userId);
    if (!user) throw httpError(404, 'USER_NOT_FOUND', '用户不存在');
    const owned = await summaries(tenants.listOwnedBy(user.id));
    sendJson(ctx.res, 200, { ok: true, user, tenants: owned });
  });

  router.post('/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    const body = await readBody(ctx);
    const user = auth.createUser({ username: body.username, password: body.password, role: body.role || 'user' });
    audit.record({ actorUserId: ctx.auth.user.id, action: 'user.create', detail: { userId: user.id, role: user.role }, ip: ctx.ip });
    sendJson(ctx.res, 201, { ok: true, user });
  });

  router.patch('/api/admin/users/:userId', async (ctx) => {
    const { user: actor } = requireAdmin(ctx);
    const body = await readBody(ctx);
    const updated = users.update(ctx.params.userId, body);
    audit.record({ actorUserId: actor.id, action: 'user.update',
      detail: { userId: updated.id, role: updated.role, disabled: Boolean(updated.disabled), passwordReset: body.password !== undefined }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, user: updated });
  });

  router.get('/api/admin/recharges', async (ctx) => {
    requireAdmin(ctx);
    const params = ctx.url.searchParams;
    const status = params.get('status') || 'all';
    const tenantId = String(params.get('tenantId') || '').trim();
    if (tenantId.length > 200) throw httpError(400, 'INVALID_QUERY', 'tenantId 超出长度限制');
    const limit = parseQueryInt(params, 'limit', 100, 1, 500);
    sendJson(ctx.res, 200, { ok: true, recharges: billing.listRecharges({ status, tenantId, limit }) });
  });

  router.post('/api/admin/recharges/:id/confirm', async (ctx) => {
    requireAdmin(ctx);
    const body = await readBody(ctx);
    const result = billing.confirmRecharge(ctx.params.id, ctx.auth.user.id, body.note);
    audit.record({
      actorUserId: ctx.auth.user.id, tenantId: result.recharge.tenantId, action: 'billing.recharge.confirm',
      detail: { rechargeId: result.recharge.id, amountMicros: result.recharge.amountMicros }, ip: ctx.ip
    });
    sendJson(ctx.res, 200, {
      ok: true,
      recharge: result.recharge,
      billing: { ...result.wallet, currency: 'CNY', unit: 'micro-yuan' }
    });
  });

  router.post('/api/admin/recharges/:id/reject', async (ctx) => {
    requireAdmin(ctx);
    const body = await readBody(ctx);
    const recharge = billing.rejectRecharge(ctx.params.id, ctx.auth.user.id, body.note);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: recharge.tenantId, action: 'billing.recharge.reject',
      detail: { rechargeId: recharge.id, amountMicros: recharge.amountMicros }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, recharge });
  });

  router.get('/api/admin/upstream', async (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { ok: true, upstream: relay.upstreamPublic() });
  });

  router.put('/api/admin/upstream', async (ctx) => {
    requireAdmin(ctx);
    const body = await readBody(ctx);
    const upstream = relay.setUpstream({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      clear: body.clear === true
    });
    audit.record({ actorUserId: ctx.auth.user.id, action: 'upstream.update', detail: { configured: upstream.configured, baseUrl: upstream.baseUrl }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, upstream });
  });

  router.put('/api/admin/llbot-auth-token', async (ctx) => {
    requireAdmin(ctx);
    const body = await readBody(ctx);
    const token = String(body.token || '').trim();
    if (token) settings.set('platform.llbotAuthToken', token);
    else settings.delete('platform.llbotAuthToken');
    audit.record({ actorUserId: ctx.auth.user.id, action: 'platform.llbot-token.update', detail: { hasToken: Boolean(token) }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, hasToken: Boolean(token) });
  });

  router.get('/api/admin/llbot-auth-token', async (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { ok: true, hasToken: Boolean(settings.get('platform.llbotAuthToken', '') || config.platformAuthToken) });
  });

  router.get('/api/admin/audit', async (ctx) => {
    requireAdmin(ctx);
    const params = ctx.url.searchParams;
    const tenantId = String(params.get('tenantId') || '').trim();
    const actorUserId = String(params.get('actorUserId') || '').trim();
    const action = String(params.get('action') || '').trim();
    if ([tenantId, actorUserId, action].some((value) => value.length > 200)) throw httpError(400, 'INVALID_QUERY', '筛选条件过长');
    const rows = audit.search({ tenantId, actorUserId, action, limit: parseQueryInt(params, 'limit', 200, 1, 500) });
    sendJson(ctx.res, 200, { ok: true, entries: rows });
  });

}
