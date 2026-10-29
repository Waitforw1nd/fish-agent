export function createRelayApi({ request, tenantPath, setCsrfToken }) {
  return {
    getRelayOverview(tenantId) {
      return request(tenantPath(tenantId, '/relay/overview'));
    },
    getRelayModels(tenantId) {
      return request(tenantPath(tenantId, '/relay/models'));
    },
    updateRelayKey(tenantId, { key, model } = {}) {
      const body = {};
      if (key) body.key = String(key).trim();
      if (model) body.model = String(model).trim();
      return request(tenantPath(tenantId, '/relay/key'), { method: 'PUT', body });
    },
    getRelayCustom(tenantId) {
      return request(tenantPath(tenantId, '/relay/custom'));
    },
    updateRelayCustom(tenantId, { baseUrl, apiKey, model } = {}) {
      const body = {
        baseUrl: String(baseUrl ?? '').trim(),
        model: String(model ?? '').trim()
      };
      if (apiKey) body.apiKey = String(apiKey).trim();
      return request(tenantPath(tenantId, '/relay/custom'), { method: 'PUT', body });
    },
    deleteRelayCustom(tenantId) {
      return request(tenantPath(tenantId, '/relay/custom'), { method: 'DELETE' });
    },
    testRelayCustom: (id, body = {}) => request(tenantPath(id, '/relay/custom/test'), { method: 'POST', body }),
    topupRelay: (id, body) => request(tenantPath(id, '/relay/topup'), { method: 'POST', body }),
    getRelayLogs(tenantId, { days, limit, model, status } = {}) {
      const query = new URLSearchParams();
      if (days !== undefined && days !== null && days !== '') query.set('days', String(days));
      if (limit !== undefined && limit !== null && limit !== '') query.set('limit', String(limit));
      if (model) query.set('model', String(model).trim());
      if (status) query.set('status', String(status).trim());
      const suffix = query.size ? `?${query.toString()}` : '';
      return request(tenantPath(tenantId, `/relay/logs${suffix}`));
    }
  };
}
