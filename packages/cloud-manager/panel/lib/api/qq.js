export function createQqApi({ request, tenantPath, setCsrfToken }) {
  return {
    getQQDrivers() {
      return request('/api/qq/drivers');
    },
    switchQQ(tenantId, { driver, expectedRevision, idempotencyKey, uin } = {}, { signal } = {}) {
      const body = { driver, expectedRevision, idempotencyKey };
      if (uin !== undefined) body.uin = uin;
      return request(tenantPath(tenantId, '/qq/switch'), { method: 'POST', body, signal });
    },
    getQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}`), { signal });
    },
    advanceQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}/advance`), { method: 'POST', signal });
    },
    cancelQQOperation(tenantId, operationId, { signal } = {}) {
      return request(tenantPath(tenantId, `/qq/operations/${encodeURIComponent(operationId)}/cancel`), { method: 'POST', signal });
    },
    prepareQQ(tenantId, { kernel, uin } = {}) {
      return request(tenantPath(tenantId, '/qq/prepare'), {
        method: 'POST', body: qqBody(kernel, uin)
      });
    },
    prepareQQAdvanced: (tenantId, body) => request(tenantPath(tenantId, '/qq/prepare'), { method: 'POST', body }),
    startQQ(tenantId, { kernel, uin } = {}) {
      return request(tenantPath(tenantId, '/qq/start'), {
        method: 'POST', body: qqBody(kernel, uin)
      });
    },
    refreshQQQrcode(tenantId, runtimeGeneration = null) {
      return request(tenantPath(tenantId, '/qq/qrcode/refresh'), { method: 'POST', body: { runtimeGeneration } });
    },
    getQQQrcode(tenantId) {
      return request(tenantPath(tenantId, '/qq/qrcode'));
    },
    getQQStatus(tenantId) {
      return request(tenantPath(tenantId, '/qq/status'));
    },
    stopQQ: (id) => request(tenantPath(id, '/qq/stop'), { method: 'POST' }),
    setQQAuthToken: (id, token) => request(tenantPath(id, '/qq/auth-token'), { method: 'PUT', body: { token } }),
    clearQQAuthToken: (id) => request(tenantPath(id, '/qq/auth-token'), { method: 'DELETE' }),
    getQQLogs: (id) => request(tenantPath(id, '/qq/logs'))
  };
}
function qqBody(kernel, uin) {
  const body = {};
  if (kernel) body.kernel = String(kernel);
  if (uin) body.uin = String(uin).trim();
  return body;
}
