import { h } from '../../lib/dom.js';
import { formatDateTime, formatMicros } from '../../lib/format.js';
import { badge } from '../../lib/ui.js';
import { createAdminPage, dataTable, editDialog, labeled, queryPath, rows, selectInput } from './shared.js';

export function mountRecharges(root, ctx = {}) {
  const status = selectInput('recharge-status', [['pending', '待审核'], ['confirmed', '已到账'], ['rejected', '已驳回'], ['all', '全部']], 'pending');
  const tenant = h('input', { id: 'recharge-tenant', class: 'input', placeholder: '按租户 ID 筛选' });
  const filter = h('button', { class: 'btn btn-ghost', type: 'button' }, '查询');
  const filters = h('div', { class: 'workspace-filters' }, labeled('状态', status), labeled('租户', tenant), filter);
  const page = createAdminPage(root, ctx, { title: '充值审核', sub: '核对收款后确认到账，驳回原因会显示在用户钱包中。' });
  const labels = { pending: '待审核', confirmed: '已到账', rejected: '已驳回' };
  function review(item, action) {
    const note = h('textarea', { id: 'recharge-review-note', class: 'input', rows: 3, maxLength: 500 });
    const confirm = action === 'confirm';
    const dialog = editDialog(ctx, {
      title: `${confirm ? '确认到账' : '驳回申请'} · ${formatMicros(item.amountMicros ?? item.amount_micros)}`,
      fields: [labeled(confirm ? '审核备注（可选）' : '驳回原因（必填）', note)],
      submitLabel: confirm ? '确认到账' : '驳回申请', danger: !confirm,
      async submit() {
        if (!confirm && !note.value.trim()) throw new Error('请填写驳回原因');
        await ctx.api.request(`/api/admin/recharges/${encodeURIComponent(item.id)}/${action}`, { method: 'POST', body: { note: note.value.trim() } });
      },
      onSaved: () => { ctx.toast?.show?.(confirm ? '充值已到账' : '申请已驳回', { tone: 'success' }); return page.reload(); }
    });
    page.cleanup(() => dialog.close('destroy'));
  }
  page.load(async () => {
    const result = await ctx.api.request(queryPath('/api/admin/recharges', { status: status.value, tenantId: tenant.value.trim(), limit: 100 }));
    return h('div', {}, filters, dataTable([
      { label: '租户 / 申请人', value: (item) => h('div', {}, h('a', { href: `#/tenants/${encodeURIComponent(item.tenantId ?? item.tenant_id)}/relay` }, item.tenantName || item.tenant_name || item.tenantId || item.tenant_id), h('p', { class: 'note' }, item.createdByUsername || item.created_by_username || item.username || item.createdByUserId || '')) },
      { label: '金额', value: (item) => formatMicros(item.amountMicros ?? item.amount_micros) },
      { label: '状态', value: (item) => badge(labels[item.status] || item.status, item.status === 'confirmed' ? 'ok' : item.status === 'pending' ? 'warn' : 'danger') },
      { label: '申请 / 审核时间', value: (item) => h('div', {}, formatDateTime(item.createdAt ?? item.created_at), h('p', { class: 'note' }, formatDateTime(item.reviewedAt ?? item.reviewed_at))) },
      { label: '审核备注', value: (item) => item.reviewNote || item.review_note || '—' },
      { label: '操作', value: (item) => item.status === 'pending' ? h('div', { class: 'inline-buttons' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: () => review(item, 'confirm') } }, '确认到账'),
        h('button', { class: 'btn btn-danger btn-sm', type: 'button', on: { click: () => review(item, 'reject') } }, '驳回')) : '已审核' }
    ], rows(result, 'recharges'), { empty: '没有符合条件的充值申请' }));
  });
  status.addEventListener('change', () => { void page.reload(); });
  filter.addEventListener('click', () => { void page.reload(); });
  return page;
}
