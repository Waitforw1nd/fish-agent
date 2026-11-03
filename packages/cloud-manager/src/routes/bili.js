import { sendJson } from '../http.js';
import { httpError, requireObjectBody } from '../contracts/http.js';

export function registerBiliRoutes(router, deps) {
  const { bili, audit, readBody, tenantCtx, activeTenant } = deps;
  router.get('/api/tenants/:id/bili/explore', async (ctx) => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, explore: await bili.control(tenant, '/admin/explore') });
  });
  router.put('/api/tenants/:id/bili/explore', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const body = requireObjectBody(await readBody(ctx));
    sendJson(ctx.res, 200, { ok: true, explore: await bili.control(tenant, '/admin/explore', { method: 'PUT', body }) });
  });
  router.post('/api/tenants/:id/bili/explore/risk/clear', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const result = await bili.control(tenant, '/admin/risk/clear', { method: 'POST' });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'bili.explore.risk.clear', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, risk: result });
  });
  for (const action of ['edit', 'approve', 'reject']) router.post('/api/tenants/:id/bili/explore/drafts/:draftId/' + action, async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const id = String(ctx.params.draftId);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw httpError(400, 'invalid_draft', 'Invalid draft');
    const body = requireObjectBody(await readBody(ctx));
    const result = await bili.control(tenant, '/admin/explore/drafts/' + id + '/' + action, { method: 'POST', body: { text: body.text } });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'bili.explore.' + action, detail: { draftId: id }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, explore: result });
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
    const body = requireObjectBody(await readBody(ctx));
    const result = await bili.updateConfig(tenant, Object.hasOwn(body, 'config') ? requireObjectBody(body.config) : body);
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

}
