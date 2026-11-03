import { sendJson } from '../http.js';
import { requireObjectBody } from '../contracts/http.js';

export function registerEntryRoutes(router, deps) {
  const { entries, desktopDevices, desktopGateway, tenantCtx, activeTenant, readBody, hosting, qq, bili, audit } = deps;
  router.get('/api/tenants/:id/entries', async ctx => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, entries: entries.list(tenant.id) });
  });
  router.put('/api/tenants/:id/entries/:entry', async ctx => {
    const { tenant } = activeTenant(ctx);
    const { enabled } = requireObjectBody(await readBody(ctx));
    const entry = ctx.params.entry;
    qq.assertNoSwitch(tenant.id);
    const agentRunning = hosting.supervisor.status(tenant.id, 'agent').state === 'running';
    const result = entries.setEnabled(tenant, entry, enabled);
    if (!enabled) {
      if (entry === 'desktop') desktopGateway.closeTenant(tenant.id);
      else if (entry === 'bili') await bili.stop(tenant, { releasePorts: false });
      else {
        const account = qq.account(tenant.id);
        if (account && (entry === 'qq_official') === (account.driver === 'qqbot')) await qq.stop(tenant, { releasePorts: false });
      }
    } else if (entry === 'bili') {
      if (!bili.row(tenant.id) || !bili.getConfig(tenant).enabled) await bili.updateConfig(tenant, { enabled: true });
      if (agentRunning) await bili.start(tenant);
    } else if ((entry === 'qq_protocol' || entry === 'qq_official') && agentRunning) {
      await qq.start(tenant);
    }
    await hosting.handleLinksChanged(tenant, { reason: 'entry-changed' });
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'entry.update', detail: { entry: ctx.params.entry, enabled }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true, entries: result });
  });
  router.post('/api/tenants/:id/desktop/pairing-codes', async ctx => {
    const { tenant } = activeTenant(ctx);
    const pairing = await desktopDevices.createPairingCode(tenant.id, ctx.auth.user.id);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'desktop.pairing.create', ip: ctx.ip });
    sendJson(ctx.res, 201, { ok: true, ...pairing });
  });
  router.get('/api/tenants/:id/desktop/devices', async ctx => {
    const { tenant } = tenantCtx(ctx);
    sendJson(ctx.res, 200, { ok: true, devices: desktopDevices.list(tenant.id) });
  });
  router.delete('/api/tenants/:id/desktop/devices/:deviceId', async ctx => {
    const { tenant } = tenantCtx(ctx, 'operator');
    desktopDevices.revoke(tenant.id, ctx.params.deviceId);
    audit.record({ actorUserId: ctx.auth.user.id, tenantId: tenant.id, action: 'desktop.device.revoke', detail: { deviceId: ctx.params.deviceId }, ip: ctx.ip });
    sendJson(ctx.res, 200, { ok: true });
  });
}
