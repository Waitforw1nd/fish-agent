import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

function safeQQOperation(operation) {
  const message = (value) => redactSecrets(value).replace(/(credential["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]');
  const detail = (value) => typeof value === 'string' ? message(value) : value && { ...value, ...(value.message ? { message: message(value.message) } : {}) };
  return { ...operation, ...(operation.error ? { error: detail(operation.error) } : {}), ...(operation.rollback ? { rollback: detail(operation.rollback) } : {}) };
}

export function registerQQRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summary, listSummaries, updateAgentRelayConfig } = deps;
  // QQ protocol driver
  const qrView = (qrcode) => ({
    ...qrcode,
    imageDataUrl: qrcode.pngBase64,
    imageUrl: qrcode.pngBase64,
    pngBase64QrcodeData: qrcode.pngBase64,
    expiresAt: qrcode.expireAt,
    status: qrcode.state === 'ready' ? 'waiting' : qrcode.state
  });
  router.get('/api/qq/drivers', async (ctx) => {
    auth.require(ctx.req);
    sendJson(ctx.res, 200, { ok: true, defaultDriver: config.defaultQqDriver || 'napcat', drivers: await qq.drivers() });
  });
  router.post('/api/tenants/:id/qq/switch', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const body = await readBody(ctx);
    const operation = await qq.startSwitch(tenant, {
      driver: body.driver, expectedRevision: body.expectedRevision,
      idempotencyKey: body.idempotencyKey, ...(body.uin === undefined ? {} : { uin: body.uin })
    });
    sendJson(ctx.res, 202, { ok: true, operation: safeQQOperation(operation) });
  });
  router.get('/api/tenants/:id/qq/operations/:operationId', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    const operation = qq.publicOperation(db.prepare('SELECT * FROM qq_operations WHERE tenant_id = ? AND id = ?').get(tenant.id, ctx.params.operationId));
    sendJson(ctx.res, 200, { ok: true, operation: safeQQOperation(operation) });
  });
  router.post('/api/tenants/:id/qq/operations/:operationId/advance', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const operation = await qq.getOperation(tenant, ctx.params.operationId);
    sendJson(ctx.res, 200, { ok: true, operation: safeQQOperation(operation) });
  });
  router.post('/api/tenants/:id/qq/operations/:operationId/cancel', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const operation = await qq.cancelSwitch(tenant, ctx.params.operationId);
    sendJson(ctx.res, 200, { ok: true, operation: safeQQOperation(operation) });
  });
  router.post('/api/tenants/:id/qq/qrcode/refresh', async (ctx) => {
    const { tenant } = activeTenant(ctx);
    const body = await readBody(ctx);
    const qrcode = await qq.refreshQrcode(tenant, { runtimeGeneration: body.runtimeGeneration });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.qrcode.refresh', detail: { driver: qrcode.driver, runtimeGeneration: qrcode.runtimeGeneration }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qrcode: qrView(qrcode) });
  });
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
    const result = await qq.prepareAndStart(tenant, {
      driver: body.driver || body.kernel,
      uin: body.uin || body.expectedUin || body.qq,
      mode: body.mode,
      pmhqPort: body.pmhqPort,
      authToken: body.authToken
    });
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
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'qq.qrcode', detail: { driver: qrcode.driver }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, qrcode: qrView(qrcode) });
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
    sendJson(ctx.res, 200, { ok: true, logs: await qq.logs(tenant, Number(ctx.url.searchParams.get('limit')) || 100) });
  });

}
