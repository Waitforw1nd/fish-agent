import { createTransport } from './api/request.js';
export { ApiError, unwrapPayload } from './api/request.js';
import { createAuthApi } from './api/auth.js';
import { createTenantsApi } from './api/tenants.js';
import { createQqApi } from './api/qq.js';
import { createBiliApi } from './api/bili.js';
import { createRelayApi } from './api/relay.js';
import { createBillingApi } from './api/billing.js';
import { createAdminApi } from './api/admin.js';
import { createAgentApi } from './api/agent.js';
import { createExtensionsApi } from './api/extensions.js';

export function createApi(options = {}) {
  const transport = createTransport(options);
  const tenantPath = (id, suffix = '') => {
    if (id === undefined || id === null || String(id) === '') throw new TypeError('Missing tenant ID');
    return `/api/tenants/${encodeURIComponent(id)}${suffix}`;
  };
  const context = { ...transport, tenantPath };
  const groups = {
    auth: createAuthApi(context),
    tenants: createTenantsApi(context),
    qq: createQqApi(context),
    bili: createBiliApi(context),
    relay: createRelayApi(context),
    billing: createBillingApi(context),
    admin: createAdminApi(context),
    agent: createAgentApi(context),
    extensions: createExtensionsApi(context)
  };
  return Object.assign({}, transport, ...Object.values(groups), groups);
}
