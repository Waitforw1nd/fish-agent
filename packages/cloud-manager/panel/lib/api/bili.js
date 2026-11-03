export function createBiliApi({ request, tenantPath, setCsrfToken }) {
  return {
    clearBiliExploreRisk: (id, options = {}) => request(tenantPath(id, '/bili/explore/risk/clear'), { ...options, method: 'POST' }),
    getBiliExplore: (id, options = {}) => request(tenantPath(id, '/bili/explore'), options),
    updateBiliExplore: (id, body, options = {}) => request(tenantPath(id, '/bili/explore'), { ...options, method: 'PUT', body }),
    reviewBiliDraft: (id, draftId, action, text, options = {}) => request(tenantPath(id, '/bili/explore/drafts/' + encodeURIComponent(draftId) + '/' + action), { ...options, method: 'POST', body: { text } }),
    biliLoginQr(tenantId) {
      return request(tenantPath(tenantId, '/bili/login/qr'), { method: 'POST' });
    },
    getBiliLoginStatus(tenantId) {
      return request(tenantPath(tenantId, '/bili/login/status'));
    },
    getBiliStatus(tenantId) {
      return request(tenantPath(tenantId, '/bili/status'));
    },
    getBiliConfig(tenantId) {
      return request(tenantPath(tenantId, '/bili/config'));
    },
    updateBiliConfig(tenantId, subscriptions) {
      const source = subscriptions?.subscriptions || subscriptions || {};
      return request(tenantPath(tenantId, '/bili/config'), {
        method: 'PUT',
        body: {
          ...(subscriptions?.subscriptions ? subscriptions : {}),
          subscriptions: {
            mentions: Boolean(source.mentions),
            upVideos: Boolean(source.upVideos),
            privateMessages: Boolean(source.privateMessages),
            liveRoom: Boolean(source.liveRooms ?? source.liveRoom)
          }
        }
      });
    },
    startBili: (id) => request(tenantPath(id, '/bili/start'), { method: 'POST' }),
    stopBili: (id) => request(tenantPath(id, '/bili/stop'), { method: 'POST' }),
    logoutBili: (id) => request(tenantPath(id, '/bili/logout'), { method: 'POST' }),
    getBiliLogs: (id) => request(tenantPath(id, '/bili/logs'))
  };
}
