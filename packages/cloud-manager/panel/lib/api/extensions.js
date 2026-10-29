export function createExtensionsApi({ request, tenantPath }) {
  const part = (value) => encodeURIComponent(String(value));
  const path = (id, suffix = '') => tenantPath(id, `/extensions${suffix}`);
  const catalog = '/api/admin/extensions/catalog';
  return {
    getExtensions: (id) => request(path(id)),
    installExtensionZip: (id, body) => request(path(id, '/install-zip'), { method: 'POST', body }),
    installExtensionCatalog: (id, extId) => request(path(id, '/install-catalog'), { method: 'POST', body: { extId } }),
    removeExtension: (id, extId, { cleanConfig = false, fallback = false } = {}) => {
      const params = new URLSearchParams();
      if (cleanConfig) params.set('cleanConfig', '1');
      if (fallback) params.set('fallback', '1');
      return request(path(id, `/${part(extId)}${params.size ? `?${params}` : ''}`), { method: 'DELETE' });
    },
    restoreExtension: (id, extId) => request(path(id, `/${part(extId)}/restore`), { method: 'POST' }),
    reloadExtensions: (id) => request(path(id, '/reload'), { method: 'POST' }),
    getExtensionCatalog: () => request(catalog),
    uploadExtensionCatalog: (body) => request(catalog, { method: 'POST', body }),
    deleteExtensionCatalog: (extId) => request(`${catalog}/${part(extId)}`, { method: 'DELETE' }),
    deployExtensionCatalog: (extId, tenantIds) => request(`${catalog}/${part(extId)}/deploy`, { method: 'POST', body: { tenantIds } }),
    undeployExtensionCatalog: (extId, tenantIds) => request(`${catalog}/${part(extId)}/undeploy`, { method: 'POST', body: { tenantIds } })
  };
}
