export function createAuthApi({ request, tenantPath, setCsrfToken }) {
  return {
    login(username, password) {
      return request('/api/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false
      });
    },
    logout() {
      return request('/api/auth/logout', { method: 'POST', auth: false }).finally(() => { setCsrfToken(''); });
    },
    me() {
      return request('/api/me');
    },
    changePassword(body) { return request('/api/auth/password', { method: 'PUT', body }); }
  };
}
