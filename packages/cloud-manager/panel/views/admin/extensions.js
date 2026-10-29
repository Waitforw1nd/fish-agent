import { h } from '../../lib/dom.js';
import { badge, alertBox } from '../../lib/ui.js';
import { confirmDialog } from '../../lib/modal.js';
import { createAdminPage, dataTable, editDialog, labeled, rows, zipPayload } from './shared.js';

export function mountExtensions(root, ctx = {}) {
  const page = createAdminPage(root, ctx, { title: '插件中心', sub: '维护平台插件库，选择实例分发、升级或移除。' });
  const dialogsRoot = ctx.modalRoot || document.getElementById('modal-root') || document.body;
  let tenants = [];
  let batchResults = [];
  const upload = h('input', { id: 'catalog-zip', class: 'input', type: 'file', accept: '.zip' });
  const uploadButton = h('button', { type: 'button', class: 'btn btn-primary' }, '上传插件包');
  uploadButton.addEventListener('click', () => {
    void page.perform(uploadButton, async () => {
      await ctx.api.request('/api/admin/extensions/catalog', { method: 'POST', body: await zipPayload(upload.files?.[0]) });
      upload.value = '';
    }, '插件包已入库');
  });
  page.load(async () => {
    const [catalog, allTenants] = await Promise.all([ctx.api.request('/api/admin/extensions/catalog'), ctx.api.listTenants()]);
    tenants = rows(allTenants, 'tenants');
    const items = rows(catalog, 'items').length ? rows(catalog, 'items') : rows(catalog, 'extensions');
    return h('div', {},
      h('div', { class: 'card card-pad workspace-filters' }, labeled('ZIP 插件包', upload, '最多 8 MiB；只导入信任的插件代码。'), uploadButton),
      batchResults.length ? h('section', { class: 'card card-pad' },
        alertBox(`最近批量操作：${batchResults.filter((item) => item.ok).length} 个成功，${batchResults.filter((item) => !item.ok).length} 个失败`, batchResults.every((item) => item.ok) ? 'info' : 'warn'),
        dataTable([
          { label: '实例', value: (item) => tenants.find((tenant) => tenant.id === item.tenantId)?.name || item.tenantId },
          { label: '结果', value: (item) => item.ok ? '完成' : item.error || item.code || '操作失败' }
        ], batchResults)) : null,
      dataTable([
        { label: '插件 / 技能', value: (item) => h('div', {}, h('strong', {}, item.name || item.id || item.extId), h('p', { class: 'note' }, item.id || item.extId)) },
        { label: '类型', value: (item) => badge(item.kind === 'skill' || item.kind === 'skills' ? '技能' : '插件') },
        { label: '版本', value: (item) => item.version || '—' },
        { label: '声明权限', value: (item) => Array.isArray(item.permissions) ? item.permissions.join('、') || '无' : '—' },
        { label: '已分发实例', value: (item) => String(item.tenantCount ?? item.deployedCount ?? item.installedTenants?.length ?? 0) },
        { label: '操作', value: (item) => h('div', { class: 'inline-buttons' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: () => distribute(item, 'deploy') } }, '分发 / 升级'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => distribute(item, 'undeploy') } }, '批量移除'),
          h('button', { class: 'btn btn-danger btn-sm', type: 'button', on: { click: (event) => { void remove(item, event.currentTarget); } } }, '删除库条目')) }
      ], items, { empty: '插件库为空，上传 ZIP 插件包后可分发给实例' }));
  });

  function distribute(item, action) {
    const name = item.name || item.id || item.extId;
    const selected = new Set();
    const installed = new Set(item.installedTenants || []);
    const list = h('div', { class: 'workspace-tenant-picker' }, ...tenants.map((tenant) => h('label', { class: 'workspace-check-row' },
      h('input', { type: 'checkbox', value: tenant.id, on: { change: (event) => { if (event.target.checked) selected.add(tenant.id); else selected.delete(tenant.id); } } }),
      h('span', {}, tenant.name || tenant.id), badge(installed.has(tenant.id) ? '已安装' : '未安装'), badge(tenant.status || '未知'))));
    const dialog = editDialog(ctx, {
      title: `${action === 'deploy' ? '分发 / 升级' : '移除'} ${name}`,
      fields: [h('p', { class: 'note' }, '每个实例独立处理；失败实例会显示原因。'), list],
      submitLabel: action === 'deploy' ? '分发到所选实例' : '从所选实例移除', danger: action !== 'deploy',
      async submit() {
        if (!selected.size) throw new Error('请至少选择一个实例');
        const result = await ctx.api.request(`/api/admin/extensions/catalog/${encodeURIComponent(item.extId || item.id)}/${action}`, { method: 'POST', body: { tenantIds: [...selected] } });
        batchResults = rows(result, 'results');
      },
      onSaved: () => page.reload()
    });
    page.cleanup(() => dialog.close('destroy'));
  }

  async function remove(item, button) {
    const confirmed = await confirmDialog({ root: dialogsRoot, title: '删除插件库条目', message: `删除 ${item.name || item.id || item.extId} 的公共库副本。已分发实例中的安装副本不受影响。`, confirmText: '删除库条目', danger: true });
    if (!confirmed || !page.alive()) return;
    void page.perform(button, () => ctx.api.request(`/api/admin/extensions/catalog/${encodeURIComponent(item.extId || item.id)}`, { method: 'DELETE' }), '库条目已删除');
  }
  return page;
}
