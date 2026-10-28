import { getPlan, listPlans } from './plans.js';
import { createRouter, readJson, sendJson } from './http.js';
import { now } from './util.js';

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function bool(value) {
  return value === true;
}

function parseQueryInt(params, name, fallback, min, max) {
  if (!params.has(name)) return fallback;
  const raw = String(params.get(name) || '');
  if (!/^\d+$/.test(raw)) throw httpError(400, 'INVALID_QUERY', `${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw httpError(400, 'INVALID_QUERY', `${name} 必须在 ${min}-${max} 之间`);
  }
  return value;
}

export function createApiRouter(deps) {
  const {
    config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing,
    backup, settings, audit, users, agent, customUpstreams, logger, db
  } = deps;
  const router = createRouter();

  const readBody = (ctx, limit = config.apiMaxBodyBytes) => readJson(ctx.req, limit);
  const tenantCtx = (ctx, minRole = 'viewer') => {
    const { user } = ctx.auth || auth.require(ctx.req);
    const { tenant, role } = tenants.require(ctx.params.id, user, minRole);
    return { tenant, role };
  };
  const activeTenant = (ctx, minRole = 'operator') => {
    const result = tenantCtx(ctx, minRole);
    tenants.assertActive(result.tenant);
    return result;
  };
  const qqPhase = (state, processState) => {
    if (state === 'online') return 'online';
    if (['uin_mismatch', 'crashed', 'failed'].includes(state)) return 'error';
    if (['starting', 'restarting'].includes(processState) || state === 'starting') return 'starting';
    if (['running', 'restarting'].includes(processState)) return 'waiting_login';
    if (['awaiting_login', 'auth_required', 'running'].includes(state)) return 'waiting_login';
    return 'stopped';
  };
  const qqSummary = (tenant) => {
    const row = qq.account(tenant.id);
    if (!row) return { available: false, phase: 'stopped', kernel: 'unknown', state: 'unprepared', running: false, loggedIn: false };
    const process = deps.supervisor.status(tenant.id, 'qq');
    const phase = qqPhase(row.state, process.state);
    const caps = qq.capabilities(row.driver);
    const hasToken = row.auth_source && row.auth_source !== 'none';
    return {
      available: true,
      kernel: row.driver,
      driver: row.driver,
      state: row.state,
      phase,
      running: ['running', 'starting', 'restarting'].includes(process.state),
      loggedIn: row.state === 'online',
      online: row.state === 'online',
      uin: row.uin || '',
      nickname: row.nickname || '',
      authTokenStatus: caps?.authToken ? (hasToken ? 'ok' : 'missing') : 'ok',
      authTokenMessage: '',
      qrAvailable: Boolean(caps?.qrcode) && process.state === 'running' && row.state !== 'online',
      onebotConnected: row.state === 'online',
      onebotPort: row.ob11_port ?? null,
      onebotTokenConfigured: true,
      error: row.last_error || '',
      message: row.last_error || ''
    };
  };
  const biliSummary = (tenant) => {
    const row = bili.row(tenant.id);
    if (!row) return { available: false, phase: 'offline', state: 'unprepared', loggedIn: false, subscriptions: {} };
    const process = deps.supervisor.status(tenant.id, 'bili');
    const config = bili.getConfig(tenant);
    return {
      available: true,
      prepared: true,
      enabled: config.enabled,
      phase: process.state === 'crashed' || process.state === 'failed' ? 'error' : (process.state === 'running' ? 'waiting' : 'offline'),
      state: process.state,
      loggedIn: false,
      subscriptions: config.subscriptions,
      error: process.lastError || ''
    };
  };
  const relaySummary = (tenant) => {
    const key = relayKeys.active(tenant.id);
    const wallet = billing.wallet(tenant.id);
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    return {
      configured: Boolean(key),
      keyMasked: key ? `${key.key_prefix}••••` : '',
      keyStatus: key ? 'active' : 'missing',
      keyStatusLabel: key ? 'Key 有效' : '未绑定 Key',
      keyStatusTone: key ? 'ok' : 'warn',
      model: tenant.default_model || config.defaultModel,
      plan: { id: plan.id, name: plan.name, rpm: plan.rpm, tpm: plan.tpm },
      quota: { planName: plan.name, rpm: plan.rpm, tpm: plan.tpm, tokenLimit: null, tokenUsed: null, costLimitMicros: null, costUsedMicros: null },
      billing: { ...wallet, currency: 'CNY' }
    };
  };
  const summary = (tenant, role) => {
    const agentStatus = deps.supervisor.status(tenant.id, 'agent');
    const subscriptionStatus = tenant.status;
    const running = ['running', 'starting', 'restarting', 'stopping'].includes(agentStatus.state) || agentStatus.state === 'running';
    const status = subscriptionStatus === 'active'
      ? (agentStatus.state === 'running' ? 'running'
        : ['starting', 'restarting'].includes(agentStatus.state) ? 'starting'
          : agentStatus.state === 'stopping' ? 'stopping' : 'stopped')
      : subscriptionStatus;
    const serialized = tenants.serialize(tenant, { role });
    return {
      ...serialized,
      status,
      subscriptionStatus,
      running,
      consoleUrl: serialized.publicUrl,
      qq: qqSummary(tenant),
      bili: biliSummary(tenant),
      relay: relaySummary(tenant),
      summary: {
        agent: { state: agentStatus.state, pid: agentStatus.pid },
        qq: qqSummary(tenant),
        bili: biliSummary(tenant),
        relay: { configured: Boolean(relayKeys.active(tenant.id)) }
      }
    };
  };

  const listSummaries = (user) => tenants.listForUser(user)
    .map((item) => summary(tenants.row(item.id), item.role));

  router.post('/api/auth/login', async (ctx) => {
    const body = await readBody(ctx);
    const result = auth.login({
      username: body.username,
      password: body.password,
      ip: ctx.ip,
      userAgent: ctx.req.headers['user-agent']
    });
    audit.record({ actorUserId: result.user.id, action: 'auth.login', ip: ctx.ip });
    ctx.res.setHeader('set-cookie', auth.cookieHeader(result.token));
    sendJson(ctx.res, 200, {
      ok: true,
      user: result.user,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
      tenants: listSummaries(result.user)
    });
  });

  router.post('/api/auth/logout', async (ctx) => {
    auth.logout(auth.sessionTokenFrom(ctx.req));
    if (ctx.auth) audit.record({ actorUserId: ctx.auth.user.id, action: 'auth.logout', ip: ctx.ip });
    ctx.res.setHeader('set-cookie', auth.cookieHeader('', { clear: true }));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/me', async (ctx) => {
    const authed = auth.require(ctx.req);
    sendJson(ctx.res, 200, {
      ok: true,
      user: authed.user,
      csrfToken: authed.csrfToken,
      expiresAt: authed.expiresAt,
      tenants: listSummaries(authed.user)
    });
  });

  router.get('/api/plans', async (ctx) => {
    auth.require(ctx.req);
    sendJson(ctx.res, 200, { ok: true, plans: listPlans() });
  });

  router.get('/api/tenants', async (ctx) => {
    const authed = auth.require(ctx.req);
    const list = tenants.listForUser(authed.user).map((tenant) => summary(tenants.row(tenant.id), tenant.role));
    sendJson(ctx.res, 200, { ok: true, tenants: list });
  });

  router.post('/api/tenants', async (ctx) => {
    const authed = auth.require(ctx.req);
    const body = await readBody(ctx);
    let ownerUserId = authed.user.id;
    if (authed.user.role === 'admin' && (body.ownerUserId || body.ownerUsername)) {
      const owner = body.ownerUserId
        ? users.byId(body.ownerUserId)
        : users.byUsername(body.ownerUsername);
      if (!owner) throw httpError(400, 'UNKNOWN_OWNER', '指定的所有者不存在');
      ownerUserId = owner.id;
    } else if (body.ownerUserId || body.ownerUsername) {
      throw httpError(403, 'FORBIDDEN', '只有管理员可以指定租户所有者');
    }
    const tenant = tenants.create({
      name: body.name,
      slug: body.slug,
      planId: body.planId || body.plan,
      ownerUserId,
      actor: authed.user,
      ip: ctx.ip
    });
    const role = tenants.roleFor(authed.user, tenant.id);
    sendJson(ctx.res, 201, { ok: true, tenant: summary(tenants.row(tenant.id), role) });
  });

  router.get('/api/tenants/:id', async (ctx) => {
    const { tenant, role } = tenantCtx(ctx);
    const runtime = await hosting.status(tenant);
    const tenantView = summary(tenant, role);
    sendJson(ctx.res, 200, {
      ok: true,
      tenant: tenantView,
      qq: tenantView.qq,
      bili: tenantView.bili,
      relay: tenantView.relay,
      role,
      runtime,
      members: tenants.listMembers(tenant.id),
      backups: backup.list(tenant.id)
    });
  });

  router.patch('/api/tenants/:id', async (ctx) => {
    const { tenant, role } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const updated = tenants.update(tenant.id, body, { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, tenant: summary(tenants.row(updated.id), role) });
  });

  router.post('/api/tenants/:id/start', async (ctx) => {
    const { tenant, role } = activeTenant(ctx);
    const runtime = await hosting.start(tenants.row(tenant.id));
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: summary(tenants.row(tenant.id), role) });
  });

  router.post('/api/tenants/:id/stop', async (ctx) => {
    const { tenant, role } = tenantCtx(ctx, 'operator');
    const runtime = await hosting.stop(tenant, { reason: 'api' });
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: summary(tenants.row(tenant.id), role) });
  });

  router.post('/api/tenants/:id/restart', async (ctx) => {
    const { tenant, role } = activeTenant(ctx);
    const runtime = await hosting.restart(tenants.row(tenant.id));
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: summary(tenants.row(tenant.id), role) });
  });

  router.post('/api/tenants/:id/renew', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const isAdmin = ctx.auth.user.role === 'admin';
    const updated = tenants.renew(tenant.id, {
      days: body.days,
      planId: body.planId || body.plan,
      creditMicros: isAdmin && body.creditMicros !== undefined ? body.creditMicros : null,
      actor: ctx.auth.user,
      ip: ctx.ip
    });
    sendJson(ctx.res, 200, { ok: true, tenant: summary(tenants.row(updated.id), 'owner') });
  });

  router.post('/api/tenants/:id/suspend', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可暂停租户');
    const { tenant } = tenantCtx(ctx, 'owner');
    await hosting.stop(tenant, { reason: 'suspend' });
    const updated = tenants.setStatus(tenant.id, 'suspended', { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, tenant: summary(tenants.row(updated.id), 'admin') });
  });

  router.post('/api/tenants/:id/resume', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可恢复租户');
    const { tenant } = tenantCtx(ctx, 'owner');
    const updated = tenants.setStatus(tenant.id, 'active', { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, tenant: summary(tenants.row(updated.id), 'admin') });
  });

  router.get('/api/tenants/:id/logs', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const logs = hosting.logs(tenant, ctx.url.searchParams.get('kind') || 'all', Number(ctx.url.searchParams.get('limit')) || 100);
    sendJson(ctx.res, 200, { ok: true, logs });
  });

  router.get('/api/tenants/:id/audit', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    sendJson(ctx.res, 200, { ok: true, entries: audit.list(tenant.id, Number(ctx.url.searchParams.get('limit')) || 100) });
  });

  router.get('/api/tenants/:id/members', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, members: tenants.listMembers(tenant.id) });
  });

  router.post('/api/tenants/:id/members', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const user = body.userId ? users.byId(body.userId) : users.byUsername(body.username);
    if (!user) throw httpError(404, 'USER_NOT_FOUND', '用户不存在');
    const members = tenants.addMember(tenant.id, user, body.role || 'operator', { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, members });
  });

  router.delete('/api/tenants/:id/members/:userId', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const members = tenants.removeMember(tenant.id, ctx.params.userId, { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, members });
  });

  // QQ protocol driver
  router.post('/api/tenants/:id/qq/prepare', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const body = await readBody(ctx);
    const result = await qq.prepare(tenant, {
      driver: body.driver || body.kernel,
      uin: body.uin || body.expectedUin || body.qq,
      mode: body.mode,
      pmhqPort: body.pmhqPort,
      authToken: body.authToken
    });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.prepare', detail: { driver: result.driver, expectedUin: result.expectedUin }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qq: result, prepared: result.prepared || null });
  });

  router.post('/api/tenants/:id/qq/start', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    let body = {};
    try { body = await readBody(ctx); } catch { body = {}; }
    const wantedDriver = body.driver || body.kernel;
    const wantedUin = body.uin || body.expectedUin || body.qq;
    const account = qq.account(tenant.id);
    const existingStatus = account ? await qq.status(tenant, { probe: false }) : null;
    const settingsChanged = (body.mode !== undefined && body.mode !== existingStatus?.mode)
      || (body.pmhqPort !== undefined && Number(body.pmhqPort) !== existingStatus?.ports?.pmhq);
    if (!account || (wantedDriver && account.driver !== wantedDriver) || (wantedUin && account.expected_uin !== String(wantedUin)) || settingsChanged) {
      await qq.prepare(tenant, {
        driver: wantedDriver || account?.driver || 'llbot',
        uin: wantedUin || account?.expected_uin,
        mode: body.mode,
        pmhqPort: body.pmhqPort,
        authToken: body.authToken
      });
    } else if (Object.hasOwn(body, 'authToken') && String(body.authToken || '').trim()) {
      await qq.setAuthToken(tenant, body.authToken);
    }
    const result = await qq.start(tenant);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.start', detail: { driver: result.driver }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qq: result });
  });

  router.post('/api/tenants/:id/qq/stop', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const result = await qq.stop(tenant, { releasePorts: false });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.stop', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qq: result });
  });

  router.get('/api/tenants/:id/qq/status', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, qq: await qq.status(tenant) });
  });

  router.get('/api/tenants/:id/qq/qrcode', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    tenants.assertActive(tenant);
    let qrcode;
    try {
      qrcode = await qq.qrcode(tenant);
    } catch (error) {
      if (ctx.auth.user.role !== 'admin' && ['AUTH_TOKEN_REQUIRED', 'AUTH_TOKEN_INVALID'].includes(error.code)) {
        throw httpError(error.status || 409, error.code, '平台 QQ 登录授权不可用，请联系平台管理员处理');
      }
      throw error;
    }
    qrcode.imageDataUrl = qrcode.pngBase64;
    qrcode.imageUrl = qrcode.pngBase64;
    qrcode.pngBase64QrcodeData = qrcode.pngBase64;
    qrcode.expiresAt = qrcode.expireAt;
    qrcode.status = qrcode.state === 'ready' ? 'waiting' : qrcode.state;
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.qrcode', detail: { driver: qrcode.driver }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qrcode });
  });

  router.put('/api/tenants/:id/qq/auth-token', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const body = await readBody(ctx);
    if (!Object.hasOwn(body, 'token')) throw httpError(400, 'TOKEN_REQUIRED', '缺少 token 字段');
    const result = await qq.setAuthToken(tenant, body.token);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.auth-token.set', detail: { source: result.source }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...result, qq: await qq.status(tenant, { probe: false }) });
  });

  router.delete('/api/tenants/:id/qq/auth-token', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const result = await qq.setAuthToken(tenant, '');
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.auth-token.clear', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...result, qq: await qq.status(tenant, { probe: false }) });
  });

  router.get('/api/tenants/:id/qq/logs', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    sendJson(ctx.res, 200, { ok: true, logs: qq.logs(tenant, Number(ctx.url.searchParams.get('limit')) || 100) });
  });

  // Bilibili bridge
  router.post('/api/tenants/:id/bili/login/qr', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const login = await bili.loginQr(tenant);
    login.pngBase64QrcodeData = login.pngBase64;
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'bili.login.qr', ip: ctx.ip });
    sendJson(ctx.res, 200, { ...login, ok: true, login });
  });

  router.get('/api/tenants/:id/bili/login/status', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, login: await bili.loginStatus(tenant) });
  });

  router.get('/api/tenants/:id/bili/status', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, bili: await bili.status(tenant) });
  });

  router.get('/api/tenants/:id/bili/config', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, config: bili.getConfig(tenant) });
  });

  router.put('/api/tenants/:id/bili/config', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const body = await readBody(ctx);
    const result = await bili.updateConfig(tenant, body.config && typeof body.config === 'object' ? body.config : body);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'bili.config.update', detail: { appliedLive: result.appliedLive }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, config: result.config, appliedLive: result.appliedLive });
  });

  router.post('/api/tenants/:id/bili/logout', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const status = await bili.logout(tenant);
    sendJson(ctx.res, 200, { ok: true, bili: status });
  });

  router.post('/api/tenants/:id/bili/start', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const status = await bili.start(tenant);
    sendJson(ctx.res, 200, { ok: true, bili: status });
  });

  router.post('/api/tenants/:id/bili/stop', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const status = await bili.stop(tenant, { releasePorts: false });
    sendJson(ctx.res, 200, { ok: true, bili: status });
  });

  router.get('/api/tenants/:id/bili/logs', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    sendJson(ctx.res, 200, { ok: true, logs: bili.logs(tenant, Number(ctx.url.searchParams.get('limit')) || 100) });
  });

  // Relay / billing
  router.get('/api/tenants/:id/relay/overview', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    const key = relayKeys.active(tenant.id);
    const wallet = billing.wallet(tenant.id);
    const usage = billing.usageSummary(tenant.id, { days: Number(ctx.url.searchParams.get('days')) || 30 });
    const models = await relay.panelModels(tenant);
    const keyMasked = key ? `${key.key_prefix}••••` : '';
    const model = tenant.default_model || config.defaultModel;
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
        configured: relay.upstreamPublic().configured,
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
    sendJson(ctx.res, 200, { ok: true, ...models, models: allowed, allModels: models.models });
  });

  router.get('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const custom = customUpstreams.public(tenant);
    sendJson(ctx.res, 200, { ok: true, ...custom, custom });
  });

  router.put('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const body = await readBody(ctx);
    const custom = await customUpstreams.update(tenant, body);
    audit.record({
      actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'relay.custom.update',
      detail: { baseUrl: custom.baseUrl, model: custom.model, hasKey: custom.hasKey }, ip: ctx.ip
    });
    sendJson(ctx.res, 200, { ok: true, ...custom, custom });
  });

  router.delete('/api/tenants/:id/relay/custom', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const custom = customUpstreams.delete(tenant);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'relay.custom.delete', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...custom, custom });
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
    const plan = getPlan(tenant.plan_id) || getPlan('trial');
    const providedKey = typeof body.key === 'string' ? body.key.trim() : '';
    const providedModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!providedKey && !providedModel && !relayKeys.active(tenant.id)) {
      throw httpError(400, 'RELAY_KEY_REQUIRED', '请输入 Relay Key 或选择默认模型');
    }
    if (providedModel) {
      if (providedModel.length > 200 || !(plan.models.includes('*') || plan.models.includes(providedModel))) {
        throw httpError(400, 'MODEL_NOT_ALLOWED', `模型 ${providedModel} 不在当前套餐白名单内`);
      }
      tenants.setDefaultModel(tenant.id, providedModel);
    }
    let issued = null;
    if (providedKey) {
      issued = relayKeys.bind(tenant.id, providedKey);
    } else if (!relayKeys.active(tenant.id)) {
      issued = relayKeys.issue(tenant.id);
    }
    const fresh = tenants.row(tenant.id);
    await agent.writeConfig(fresh);
    const process = deps.supervisor.status(tenant.id, 'agent');
    let restartRequired = false;
    if (process.state === 'running') {
      restartRequired = true;
      try { await agent.restart(fresh); restartRequired = false; } catch (error) {
        logger?.warn?.('agent restart after relay key change failed', { tenantId: tenant.id, error: error.message });
      }
    }
    audit.record({
      actorUserId: ctx.auth.user.id,
      tenantId: tenant.id,
      action: providedKey ? 'relay.key.bind' : 'relay.key.rotate',
      detail: { keyPrefix: issued?.prefix || relayKeys.active(tenant.id)?.key_prefix, model: providedModel || null },
      ip: ctx.ip
    });
    const active = relayKeys.active(tenant.id);
    sendJson(ctx.res, 200, {
      ok: true,
      key: issued?.key || undefined,
      keyPrefix: active?.key_prefix || null,
      model: fresh.default_model || config.defaultModel,
      createdAt: active?.created_at || null,
      configured: Boolean(active),
      restartRequired,
      relay: {
        configured: Boolean(active),
        keyMasked: active ? `${active.key_prefix}••••` : '',
        keyStatus: active ? 'active' : 'missing',
        model: fresh.default_model || config.defaultModel
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

  // Backup / restore
  router.post('/api/tenants/:id/backup', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    const record = await backup.create(tenant.id, { actor: ctx.auth.user });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'backup.create', detail: { backupId: record.id, sizeBytes: record.sizeBytes }, ip: ctx.ip });
    sendJson(ctx.res, 201, { ok: true, backup: record });
  });

  router.get('/api/tenants/:id/backups', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, backups: backup.list(tenant.id) });
  });

  router.post('/api/tenants/:id/restore', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'owner');
    tenants.assertActive(tenant);
    const body = await readBody(ctx);
    if (!body.backupId) throw httpError(400, 'BACKUP_ID_REQUIRED', '缺少 backupId');
    const result = await backup.restore(tenant.id, body.backupId, { actor: ctx.auth.user, restart: body.restart });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'backup.restore', detail: { backupId: body.backupId }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...result });
  });

  // Admin
  router.get('/api/admin/users', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    sendJson(ctx.res, 200, { ok: true, users: users.list() });
  });

  router.get('/api/admin/users/:userId/tenants', async (ctx) => {
    if ((ctx.auth || auth.require(ctx.req)).user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    const user = users.byId(ctx.params.userId);
    if (!user) throw httpError(404, 'USER_NOT_FOUND', '用户不存在');
    const owned = tenants.listOwnedBy(user.id).map((item) => summary(tenants.row(item.id), item.role));
    sendJson(ctx.res, 200, { ok: true, user, tenants: owned });
  });

  router.post('/api/admin/users', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    const body = await readBody(ctx);
    const user = auth.createUser({ username: body.username, password: body.password, role: body.role || 'user' });
    audit.record({ actorUserId: ctx.auth.user.id, action: 'user.create', detail: { userId: user.id, role: user.role }, ip: ctx.ip });
    sendJson(ctx.res, 201, { ok: true, user });
  });

  router.post('/api/admin/recharges/:id/confirm', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可审核充值');
    const result = billing.confirmRecharge(ctx.params.id, ctx.auth.user.id);
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

  router.get('/api/admin/upstream', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    sendJson(ctx.res, 200, { ok: true, upstream: relay.upstreamPublic() });
  });

  router.put('/api/admin/upstream', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
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
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    const body = await readBody(ctx);
    const token = String(body.token || '').trim();
    if (token) settings.set('platform.llbotAuthToken', token);
    else settings.delete('platform.llbotAuthToken');
    audit.record({ actorUserId: ctx.auth.user.id, action: 'platform.llbot-token.update', detail: { hasToken: Boolean(token) }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, hasToken: Boolean(token) });
  });

  router.get('/api/admin/llbot-auth-token', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    sendJson(ctx.res, 200, { ok: true, hasToken: Boolean(settings.get('platform.llbotAuthToken', '') || config.platformAuthToken) });
  });

  router.get('/api/admin/audit', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可访问');
    const tenantId = ctx.url.searchParams.get('tenantId');
    const rows = tenantId
      ? audit.list(tenantId, Number(ctx.url.searchParams.get('limit')) || 200)
      : db.prepare('SELECT id, actor_user_id, tenant_id, action, detail, ip, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?')
        .all(Number(ctx.url.searchParams.get('limit')) || 200);
    sendJson(ctx.res, 200, { ok: true, entries: rows });
  });

  return router;
}
