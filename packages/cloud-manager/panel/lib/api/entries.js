export function createEntriesApi({ request, tenantPath }) {
  const entries = new Set(['qq_protocol', 'qq_official', 'desktop', 'bili']);
  const valid = (entry) => { if (!entries.has(entry)) throw new TypeError('Invalid entry'); return entry; };
  return {
    getEntries: (id, options = {}) => request(tenantPath(id, '/entries'), options),
    setEntryEnabled: (id, entry, enabled, options = {}) => request(tenantPath(id, '/entries/' + valid(entry)), { ...options, method: 'PUT', body: { enabled: enabled === true } }),
    getDesktopDevices: (id, options = {}) => request(tenantPath(id, '/desktop/devices'), options),
    createDesktopPairingCode: (id, options = {}) => request(tenantPath(id, '/desktop/pairing-codes'), { ...options, method: 'POST' }),
    revokeDesktopDevice: (id, deviceId, options = {}) => request(tenantPath(id, '/desktop/devices/' + encodeURIComponent(deviceId)), { ...options, method: 'DELETE' })
  };
}
