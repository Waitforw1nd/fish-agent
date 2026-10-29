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

export function createApiRouter(deps) {
  const router = createRouter();
  const context = { ...deps, ...createRouteHelpers(deps, createTenantPresenter(deps)) };
  for (const register of [registerAuthRoutes, registerTenantsRoutes, registerQQRoutes, registerBiliRoutes,
    registerAgentRoutes, registerExtensionRoutes, registerRelayBillingRoutes, registerAdminRoutes]) register(router, context);
  return router;
}
