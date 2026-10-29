import { h } from '../../lib/dom.js';
import { formatDateTime, redactText } from '../../lib/format.js';
import { alertBox, cardHead } from '../../lib/ui.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { confirmDialog } from '../../lib/modal.js';
import { createAdminPage, dataTable, labeled, queryPath, rows, selectInput } from './shared.js';

export function mountTenantOps(root, ctx = {}) {
  const prefix = `/api/tenants/${encodeURIComponent(ctx.tenantId)}`;
  const page = createAdminPage(root, ctx, { title: '日志、成员与备份', sub: '查询运行日志、管理协作成员和数据快照。' });
  const dialogsRoot = ctx.modalRoot || document.getElementById('modal-root') || document.body;
  const kind = selectInput('tenant-log-kind', [['all', '全部进程'], ['agent', 'Agent'], ['qq', 'QQ 协议端'], ['bili', 'B 站桥接']], 'all');
  const limit = selectInput('tenant-log-limit', [['100', '100 条'], ['300', '300 条'], ['500', '500 条']], '100');
  const live = h('input', { type: 'checkbox', id: 'tenant-log-live' });
  const logOutput = h('pre', { class: 'workspace-log', tabIndex: 0, 'aria-label': '运行日志' });
  let logVersion = 0;
  let timer = null;
  let fetchingLogs = false;
  function displayLogs(payload) {
    const value = payload.logs ?? payload.lines ?? payload.entries ?? [];
    const line = (entry) => typeof entry === 'string' ? entry : entry.line ?? entry.message ?? entry.text ?? JSON.stringify(entry);
    if (Array.isArray(value)) return value.map(line).join('\n');
    if (typeof value === 'object' && value) return Object.entries(value).map(([key, entries]) => `[${key}]\n${Array.isArray(entries) ? entries.map(line).join('\n') : String(entries ?? '')}`).join('\n');
    return String(value || '');
  }
  async function refreshLogs() {
    const request = ++logVersion;
    fetchingLogs = true;
    try {
      const result = await ctx.api.request(queryPath(`${prefix}/logs`, { kind: kind.value, limit: limit.value }));
      if (page.alive() && request === logVersion) logOutput.textContent = redactText(displayLogs(result), { maxLength: 160000 }) || '暂无日志';
    } catch (error) {
      if (page.alive() && request === logVersion) logOutput.textContent = apiErrorMessage(error);
    } finally {
      if (request === logVersion) fetchingLogs = false;
    }
  }
  kind.addEventListener('change', () => { void refreshLogs(); });
  limit.addEventListener('change', () => { void refreshLogs(); });
  live.addEventListener('change', () => {
    clearInterval(timer);
    timer = live.checked ? setInterval(() => { if (!fetchingLogs) void refreshLogs(); }, 5000) : null;
  });
  page.cleanup(() => { clearInterval(timer); logVersion++; });

  page.load(async () => {
    const results = await Promise.allSettled([
      ctx.api.request(`${prefix}/members`), ctx.api.request(`${prefix}/backups`), ctx.api.request(`${prefix}/audit`)
    ]);
    const logRefresh = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => { void refreshLogs(); } } }, '刷新日志');
    const panels = results.map((result, index) => {
      if (result.status === 'rejected') return h('section', { class: 'card card-pad' }, cardHead({ title: ['协作成员', '数据快照', '实例审计'][index] }), alertBox(apiErrorMessage(result.reason), 'danger'));
      return [membersPanel, backupsPanel, auditPanel][index](result.value);
    });
    void refreshLogs();
    return h('div', { class: 'workspace-grid' },
      h('section', { class: 'card card-pad workspace-span-all' }, cardHead({ title: '进程日志' }),
        h('div', { class: 'workspace-filters' }, labeled('进程', kind), labeled('条数', limit), h('label', { class: 'workspace-check-row', for: 'tenant-log-live' }, live, '每 5 秒刷新'), logRefresh), logOutput),
      ...panels);
  });

  function membersPanel(payload) {
    const username = h('input', { id: 'member-username', class: 'input', autocomplete: 'off', placeholder: '已有用户的用户名' });
    const role = selectInput('member-role', [['operator', '操作员'], ['viewer', '只读成员']], 'operator');
    const add = h('button', { class: 'btn btn-primary', type: 'submit' }, '添加 / 更新成员');
    const form = h('form', { class: 'workspace-filters' }, labeled('用户名', username), labeled('权限', role), add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void page.perform(add, () => {
        if (!username.value.trim()) throw new Error('请输入用户名');
        return ctx.api.request(`${prefix}/members`, { method: 'POST', body: { username: username.value.trim(), role: role.value } });
      }, '成员已更新');
    });
    return h('section', { class: 'card card-pad' }, cardHead({ title: '协作成员' }), form,
      dataTable([
        { label: '用户', value: (item) => item.username || item.userId || item.user_id },
        { label: '角色', value: (item) => ({ owner: '所有者', operator: '操作员', viewer: '只读成员' })[item.role] || item.role },
        { label: '操作', value: (item) => item.role === 'owner' ? '所有者不可移除' : h('button', { class: 'btn btn-danger btn-sm', type: 'button', on: { click: async (event) => {
          const button = event.currentTarget;
          if (await confirmDialog({ root: dialogsRoot, title: '移除协作成员', message: `移除 ${item.username || item.userId || item.user_id} 对当前实例的访问权限。`, danger: true, confirmText: '移除成员' })) {
            if (page.alive()) void page.perform(button, () => ctx.api.request(`${prefix}/members/${encodeURIComponent(item.userId || item.user_id)}`, { method: 'DELETE' }), '成员已移除');
          }
        } } }, '移除') }
      ], rows(payload, 'members')));
  }

  function backupsPanel(payload) {
    const create = h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: (event) => { void page.perform(event.currentTarget, () => ctx.api.request(`${prefix}/backup`, { method: 'POST' }), '快照已创建'); } } }, '创建快照');
    return h('section', { class: 'card card-pad' }, cardHead({ title: '数据快照', actions: create }),
      dataTable([
        { label: '时间', value: (item) => formatDateTime(item.createdAt ?? item.created_at) },
        { label: '备份 ID', value: (item) => item.id },
        { label: '操作', value: (item) => h('button', { class: 'btn btn-danger btn-sm', type: 'button', on: { click: async (event) => {
          const button = event.currentTarget;
          if (await confirmDialog({ root: dialogsRoot, title: '恢复实例快照', message: '恢复将覆盖当前实例数据，并按服务状态重启相关进程。', detail: `备份：${item.id}`, danger: true, confirmText: '恢复此快照' })) {
            if (page.alive()) void page.perform(button, () => ctx.api.request(`${prefix}/restore`, { method: 'POST', body: { backupId: item.id } }), '快照已恢复');
          }
        } } }, '恢复') }
      ], rows(payload, 'backups')));
  }

  function auditPanel(payload) {
    return h('section', { class: 'card card-pad workspace-span-all' }, cardHead({ title: '实例审计' }),
      dataTable([
        { label: '时间', value: (item) => formatDateTime(item.createdAt ?? item.created_at) },
        { label: '操作人', value: (item) => item.actorUsername || item.actorUserId || item.actor_user_id || '系统' },
        { label: '动作', value: (item) => item.action },
        { label: '详情', value: (item) => redactText(typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail || {})) }
      ], rows(payload, 'entries')));
  }
  return page;
}
