export function createAdminApi({ request, tenantPath, setCsrfToken }) {
  return {
    getUsers() {
      return request('/api/admin/users');
    },
    createUser({ username, password, role } = {}) {
      return request('/api/admin/users', { method: 'POST', body: { username, password, role } });
    },
    getUserTenants(userId) {
      const id = encodeURIComponent(String(userId ?? ''));
      if (!id) throw new TypeError('缺少用户 ID');
      return request(`/api/admin/users/${id}/tenants`);
    },
    updateUser: (id, body) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    getAdminOverview: () => request('/api/admin/overview'),
    getAdminRecharges: (filters = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) query.set(key, String(value));
      return request(`/api/admin/recharges${query.size ? `?${query}` : ''}`);
    },
    confirmRecharge: (id, note = '') => request(`/api/admin/recharges/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: { note } }),
    rejectRecharge: (id, note) => request(`/api/admin/recharges/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note } }),
    getAdminUpstream: () => request('/api/admin/upstream'),
    updateAdminUpstream: (body) => request('/api/admin/upstream', { method: 'PUT', body }),
    getAdminLLBotAuthToken: () => request('/api/admin/llbot-auth-token'),
    updateAdminLLBotAuthToken: (body) => request('/api/admin/llbot-auth-token', { method: 'PUT', body }),
    getAdminAudit: (filters = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value !== '' && value != null) query.set(key, String(value));
      return request(`/api/admin/audit${query.size ? `?${query}` : ''}`);
    }
  };
}
