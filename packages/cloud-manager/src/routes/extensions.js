import { httpError } from '../contracts/http.js';

const decoded = (value) => {
  try { return decodeURIComponent(String(value)); }
  catch { throw httpError(400, 'INVALID_PARAMETER', '路径参数无效'); }
};

export function registerExtensionRoutes(router, deps) {
  const { tenantCtx, requireAdmin, readBody, sendOk, extensionService: service, audit } = deps;
  const base = '/api/tenants/:id/extensions';
  const maxBody = 12 * 1024 * 1024;
  const record = (ctx, tenantId, action, detail) => audit?.record({
    actorUserId: ctx.auth?.user?.id || null, tenantId, action, detail, ip: ctx.ip
  });

  router.get(base, async (ctx) => {
    const { tenant, role } = tenantCtx(ctx);
    sendOk(ctx, await service.list(tenant, { admin: role === 'admin' }));
  });
  router.post(`${base}/install-zip`, async (ctx) => {
    requireAdmin(ctx);
    const { tenant } = tenantCtx(ctx);
    const result = await service.installZip(tenant, await readBody(ctx, maxBody));
    record(ctx, tenant.id, 'extension.install', { id: result.id, kind: result.kind });
    sendOk(ctx, result, 201);
  });
  router.post(`${base}/install-catalog`, async (ctx) => {
    requireAdmin(ctx);
    const { tenant } = tenantCtx(ctx);
    const body = await readBody(ctx);
    const result = await service.installCatalog(tenant, body.extId || body.id);
    record(ctx, tenant.id, 'extension.install_catalog', { id: result.id, kind: result.kind });
    sendOk(ctx, result, 201);
  });
  router.post(`${base}/reload`, async (ctx) => {
    requireAdmin(ctx);
    const { tenant } = tenantCtx(ctx);
    const result = await service.reload(tenant);
    record(ctx, tenant.id, 'extension.reload', {});
    sendOk(ctx, result);
  });
  router.delete(`${base}/:extId`, async (ctx) => {
    requireAdmin(ctx);
    const { tenant } = tenantCtx(ctx);
    const result = await service.remove(tenant, decoded(ctx.params.extId), {
      cleanConfig: ctx.url.searchParams.get('cleanConfig') === '1',
      blockBuiltin: ctx.url.searchParams.get('fallback') !== '1'
    });
    record(ctx, tenant.id, 'extension.remove', { id: result.id, blocked: result.blocked });
    sendOk(ctx, result);
  });
  router.post(`${base}/:extId/restore`, async (ctx) => {
    requireAdmin(ctx);
    const { tenant } = tenantCtx(ctx);
    const result = await service.restore(tenant, decoded(ctx.params.extId));
    record(ctx, tenant.id, 'extension.restore', { id: result.id });
    sendOk(ctx, result);
  });

  const catalog = '/api/admin/extensions/catalog';
  router.get(catalog, async (ctx) => {
    requireAdmin(ctx);
    sendOk(ctx, service.catalogList());
  });
  router.post(catalog, async (ctx) => {
    requireAdmin(ctx);
    const result = await service.uploadCatalog(await readBody(ctx, maxBody));
    record(ctx, null, 'extension.catalog.upload', { id: result.id, kind: result.kind });
    sendOk(ctx, result, 201);
  });
  router.delete(`${catalog}/:extId`, async (ctx) => {
    requireAdmin(ctx);
    const result = await service.deleteCatalog(decoded(ctx.params.extId));
    record(ctx, null, 'extension.catalog.delete', { id: result.id });
    sendOk(ctx, result);
  });
  for (const operation of ['deploy', 'undeploy']) {
    router.post(`${catalog}/:extId/${operation}`, async (ctx) => {
      requireAdmin(ctx);
      const body = await readBody(ctx);
      const id = decoded(ctx.params.extId);
      const result = await service.batch(id, body.tenantIds, operation);
      record(ctx, null, `extension.catalog.${operation}`, {
        id, success: result.results.filter((item) => item.ok).length, failed: result.results.filter((item) => !item.ok).length
      });
      sendOk(ctx, result);
    });
  }
}
