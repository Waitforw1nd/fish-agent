import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

export function registerAuthRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summary, listSummaries, updateAgentRelayConfig } = deps;
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

  router.put('/api/auth/password', async (ctx) => {
    const authed = ctx.auth || auth.require(ctx.req);
    const body = await readBody(ctx);
    auth.changePassword(authed.user.id, authed.session.id, body.currentPassword, body.newPassword);
    audit.record({ actorUserId: authed.user.id, action: 'auth.password.change', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true });
  });

}
