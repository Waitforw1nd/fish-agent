import { sendJson } from '../http.js';
import { ENTRIES } from '../billing/provider.js';
import { requireObjectBody } from '../contracts/http.js';

export function registerBillingRoutes(router, { billingProvider, tenantCtx, requireAdmin, readBody, audit, db }) {
  const query = (ctx, tenantId, entry) => {
    const params = ctx.url.searchParams;
    const number = (key, fallback) => {
      const raw = params.get(key);
      if (raw === null) return fallback;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw Object.assign(new Error('Invalid time'), { status: 400, code: 'INVALID_TIME' });
      }
      return value;
    };
    const from = number('from', 0);
    const to = number('to', Date.now() + 1);
    const groupBy = params.get('groupBy') || 'meter';
    if (to <= from || !['meter', 'day'].includes(groupBy)) {
      throw Object.assign(new Error('Invalid usage range'), { status: 400, code: 'INVALID_USAGE' });
    }
    const selected = entry || params.get('entry') || undefined;
    if (selected && !ENTRIES.includes(selected)) {
      throw Object.assign(new Error('Invalid entry'), { status: 400, code: 'INVALID_ENTRY' });
    }
    return { tenantId, entry: selected, meter: params.get('meter') || undefined, from, to, groupBy };
  };

  router.get('/api/tenants/:id/billing/plan', async ctx => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, ...await billingProvider.entitlements(tenant.id) });
  });
  router.get('/api/tenants/:id/billing/entries', async ctx => {
    const { tenant } = tenantCtx(ctx);
    const date = new Date();
    const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const rows = await billingProvider.usage({ tenantId: tenant.id, from, to: Date.now() + 1 });
    const entries = ENTRIES.map(entry => ({ entry, usage: rows.filter(row => row.entry === entry) }));
    sendJson(ctx.res, 200, { ok: true, entries });
  });
  router.get('/api/tenants/:id/billing/usage', async ctx => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, usage: await billingProvider.usage(query(ctx, tenant.id)) });
  });
  router.get('/api/tenants/:id/billing/entries/:entry/usage', async ctx => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, usage: await billingProvider.usage(query(ctx, tenant.id, ctx.params.entry)) });
  });
  router.get('/api/admin/billing/meters', async ctx => {
    requireAdmin(ctx);
    const tenantId = ctx.url.searchParams.get('tenantId');
    const ids = tenantId ? [tenantId] : db.prepare('SELECT id FROM tenants').all().map(row => row.id);
    const usage = [];
    for (const id of ids) {
      usage.push(...(await billingProvider.usage(query(ctx, id))).map(row => ({ ...row, tenantId: id })));
    }
    sendJson(ctx.res, 200, { ok: true, usage });
  });
  router.put('/api/admin/tenants/:id/entitlements', async ctx => {
    requireAdmin(ctx);
    const body = requireObjectBody(await readBody(ctx));
    const result = await billingProvider.setEntitlements(ctx.params.id, body.entitlements);
    audit?.record({ actorUserId: ctx.auth.user.id, tenantId: ctx.params.id,
      action: 'billing.entitlements.update', ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, ...result });
  });
}
