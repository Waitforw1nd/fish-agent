import { sendJson } from '../http.js';
import { getPlan, listPlans } from '../plans.js';
import { httpError, parseQueryInt } from '../contracts/http.js';
import { redactSecrets } from '../util.js';

export function registerTenantsRoutes(router, deps) {
  const { config, auth, tenants, hosting, qq, bili, relay, relayKeys, billing, backup, settings, audit, users, agent, customUpstreams, logger, db, readBody, tenantCtx, activeTenant, summary, listSummaries, updateAgentRelayConfig } = deps;
  router.get('/api/plans', async (ctx) => {
    auth.require(ctx.req);
    sendJson(ctx.res, 200, { ok: true, plans: listPlans() });
  });

  router.get('/api/tenants', async (ctx) => {
    const authed = auth.require(ctx.req);
    const list = await listSummaries(authed.user);
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
    if (body.days !== undefined && authed.user.role !== 'admin') {
      throw httpError(403, 'FORBIDDEN', '只有管理员可以指定服务天数');
    }
    if (body.days !== undefined && (!Number.isSafeInteger(body.days) || body.days < 1 || body.days > 3650)) {
      throw httpError(400, 'INVALID_DAYS', '服务天数必须是 1-3650 的整数');
    }
    const tenant = tenants.create({
      name: body.name,
      slug: body.slug,
      planId: body.planId || body.plan,
      ownerUserId,
      days: body.days,
      actor: authed.user,
      ip: ctx.ip
    });
    const role = tenants.roleFor(authed.user, tenant.id);
    sendJson(ctx.res, 201, { ok: true, tenant: await summary(tenants.row(tenant.id), role) });
  });

  router.get('/api/tenants/:id', async (ctx) => {
    const { tenant, role } = tenantCtx(ctx);
    const runtime = await hosting.status(tenant);
    const tenantView = await summary(tenant, role, runtime.qq);
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
    sendJson(ctx.res, 200, { ok: true, tenant: await summary(tenants.row(updated.id), role) });
  });

  router.post('/api/tenants/:id/start', async (ctx) => {
    const { tenant, role } = activeTenant(ctx);
    const runtime = await hosting.start(tenants.row(tenant.id));
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: await summary(tenants.row(tenant.id), role, runtime.qq) });
  });

  router.post('/api/tenants/:id/stop', async (ctx) => {
    const { tenant, role } = tenantCtx(ctx, 'operator');
    const runtime = await hosting.stop(tenant, { reason: 'api' });
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: await summary(tenants.row(tenant.id), role, runtime.qq) });
  });

  router.post('/api/tenants/:id/restart', async (ctx) => {
    const { tenant, role } = activeTenant(ctx);
    const runtime = await hosting.restart(tenants.row(tenant.id));
    sendJson(ctx.res, 200, { ok: true, runtime, tenant: await summary(tenants.row(tenant.id), role, runtime.qq) });
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
    sendJson(ctx.res, 200, { ok: true, tenant: await summary(tenants.row(updated.id), 'owner') });
  });

  router.post('/api/tenants/:id/suspend', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可暂停租户');
    const { tenant } = tenantCtx(ctx, 'owner');
    await hosting.stop(tenant, { reason: 'suspend' });
    const updated = tenants.setStatus(tenant.id, 'suspended', { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, tenant: await summary(tenants.row(updated.id), 'admin') });
  });

  router.post('/api/tenants/:id/resume', async (ctx) => {
    if (ctx.auth.user.role !== 'admin') throw httpError(403, 'FORBIDDEN', '仅管理员可恢复租户');
    const { tenant } = tenantCtx(ctx, 'owner');
    const updated = tenants.setStatus(tenant.id, 'active', { actor: ctx.auth.user, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, tenant: await summary(tenants.row(updated.id), 'admin') });
  });

  router.get('/api/tenants/:id/logs', async (ctx) => {
    const { tenant } = tenantCtx(ctx, 'operator');
    const logs = await hosting.logs(tenant, ctx.url.searchParams.get('kind') || 'all', Number(ctx.url.searchParams.get('limit')) || 100);
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

}
