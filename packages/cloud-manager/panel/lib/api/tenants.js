export function createTenantsApi({ request, tenantPath, setCsrfToken }) {
  return {
    listTenants() {
      return request('/api/tenants');
    },
    listPlans() {
      return request('/api/plans');
    },
    getPlans() {
      return request('/api/plans');
    },
    createTenant({ name, slug, planId, ownerUserId, days } = {}) {
      const body = { name };
      if (slug) body.slug = slug;
      if (planId) body.planId = planId;
      if (ownerUserId) body.ownerUserId = ownerUserId;
      if (days !== undefined) body.days = days;
      return request('/api/tenants', { method: 'POST', body });
    },
    getTenant(tenantId) {
      return request(tenantPath(tenantId));
    },
    startTenant(tenantId) {
      return request(tenantPath(tenantId, '/start'), { method: 'POST' });
    },
    stopTenant(tenantId) {
      return request(tenantPath(tenantId, '/stop'), { method: 'POST' });
    },
    updateTenant: (id, body) => request(tenantPath(id), { method: 'PATCH', body }),
    restartTenant: (id) => request(tenantPath(id, '/restart'), { method: 'POST' }),
    renewTenant: (id, body) => request(tenantPath(id, '/renew'), { method: 'POST', body }),
    suspendTenant: (id) => request(tenantPath(id, '/suspend'), { method: 'POST' }),
    resumeTenant: (id) => request(tenantPath(id, '/resume'), { method: 'POST' }),
    getTenantLogs: (id, { kind = 'all', limit = 100 } = {}) => request(tenantPath(id, `/logs?${new URLSearchParams({ kind, limit: String(limit) })}`)),
    getTenantAudit: (id) => request(tenantPath(id, '/audit')),
    getTenantMembers: (id) => request(tenantPath(id, '/members')),
    addTenantMember: (id, body) => request(tenantPath(id, '/members'), { method: 'POST', body }),
    removeTenantMember: (id, userId) => request(tenantPath(id, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE' }),
    getTenantBackups: (id) => request(tenantPath(id, '/backups')),
    backupTenant: (id) => request(tenantPath(id, '/backup'), { method: 'POST' }),
    restoreTenant: (id, backupId) => request(tenantPath(id, '/restore'), { method: 'POST', body: { backupId } })
  };
}
