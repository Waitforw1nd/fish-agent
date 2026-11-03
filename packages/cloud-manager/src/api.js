import { createRouter } from './http.js';
import { createRouteHelpers } from './contracts/http.js';
import { createTenantPresenter } from './presenters/tenant-presenter.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTenantsRoutes } from './routes/tenants.js';
import { registerQQRoutes } from './routes/qq.js';
import { registerBiliRoutes } from './routes/bili.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerExtensionRoutes } from './routes/extensions.js';
import { registerRelayBillingRoutes } from './routes/relay-billing.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerEntryRoutes } from './routes/entries.js';
import { LifecycleLock } from './lifecycle-lock.js';

const lifecycleRoutes = new Map([
  ['PUT /api/tenants/:id/entries/:entry', true],
  ...['start', 'stop', 'restart', 'suspend', 'resume'].map(action => [`POST /api/tenants/:id/${action}`, false]),
  ['POST /api/tenants/:id/restore', true],
  ['PUT /api/tenants/:id/relay/custom', true],
  ['DELETE /api/tenants/:id/relay/custom', false],
  ['PUT /api/tenants/:id/relay/key', true],
  ...['start', 'prepare', 'switch'].map(action => [`POST /api/tenants/:id/qq/${action}`, true]),
  ...['stop', 'operations/:operationId/advance', 'operations/:operationId/cancel'].map(action => [`POST /api/tenants/:id/qq/${action}`, false]),
  ...['start', 'stop', 'login/qr', 'logout'].map(action => [`POST /api/tenants/:id/bili/${action}`, false]),
  ['PUT /api/tenants/:id/bili/config', true]
]);

export function createApiRouter(deps) {
  const router = createRouter();
  const context = { ...deps, ...createRouteHelpers(deps, createTenantPresenter(deps)) };
  const lock = deps.lifecycleLock || new LifecycleLock();
  const bodies = new WeakMap();
  const readBody = context.readBody;
  context.readBody = (ctx, limit) => bodies.has(ctx) ? Promise.resolve(bodies.get(ctx)) : readBody(ctx, limit);
  const add = router.add;
  router.add = function (method, path, handler) {
    const key = `${String(method).toUpperCase()} ${path}`;
    if (!lifecycleRoutes.has(key)) return add.call(this, method, path, handler);
    return add.call(this, method, path, async ctx => {
      context.tenantCtx(ctx, 'operator');
      if (lifecycleRoutes.get(key)) bodies.set(ctx, await readBody(ctx));
      return lock.run(ctx.params.id, () => {
        ctx.auth = deps.auth.require(ctx.req);
        return handler(ctx);
      });
    });
  };
  for (const register of [registerAuthRoutes, registerTenantsRoutes, registerQQRoutes, registerBiliRoutes,
    registerAgentRoutes, registerExtensionRoutes, registerRelayBillingRoutes, registerAdminRoutes, registerBillingRoutes, registerEntryRoutes]) register(router, context);
  return router;
}
