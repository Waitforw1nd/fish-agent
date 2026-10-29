export function createBiliApi({ request, tenantPath, setCsrfToken }) {
  return {
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
