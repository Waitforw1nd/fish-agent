import { h } from '../../lib/dom.js';
import { formatDateTime, redactText } from '../../lib/format.js';
import { createAdminPage, dataTable, labeled, queryPath, rows } from './shared.js';

export function mountAudit(root, ctx = {}) {
  const fields = [
    ['tenantId', '租户 ID'], ['actorUserId', '操作人 ID'], ['action', '操作类型']
  ].map(([key, label]) => ({ key, input: h('input', { id: `audit-${key}`, class: 'input', placeholder: label }), label }));
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, '查询');
  const filters = h('form', { class: 'workspace-filters' }, ...fields.map(({ label, input }) => labeled(label, input)), submit);
  const page = createAdminPage(root, ctx, { title: '审计日志', sub: '检索平台与租户的管理操作记录。' });
  page.load(async () => {
    const result = await ctx.api.request(queryPath('/api/admin/audit', { limit: 200, ...Object.fromEntries(fields.map(({ key, input }) => [key, input.value.trim()])) }));
    return h('div', {}, filters, dataTable([
      { label: '时间', value: (row) => formatDateTime(row.createdAt ?? row.created_at) },
      { label: '租户', value: (row) => row.tenantName || row.tenant_name || row.tenantId || row.tenant_id || '平台' },
      { label: '操作人', value: (row) => row.actorUsername || row.actor_username || row.actorUserId || row.actor_user_id || '系统' },
      { label: '动作', value: (row) => row.action },
      { label: '详情', value: (row) => h('pre', { class: 'workspace-log-detail' }, redactText(typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail || {}))) },
      { label: '来源 IP', value: (row) => row.ip || '—' }
    ], rows(result, 'entries')));
  });
  filters.addEventListener('submit', (event) => { event.preventDefault(); void page.reload(); });
  return page;
}
