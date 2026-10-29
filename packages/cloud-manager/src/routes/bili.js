import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

export function registerBiliRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summary, listSummaries, updateAgentRelayConfig } = deps;
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

}
