import { h } from '../../lib/dom.js';
import { normalizeTenantList } from '../../lib/normalize.js';

export function normalizeUserTenants(payload) {
  const raw = Array.isArray(payload) ? payload : payload?.tenants || payload?.items || payload?.data?.tenants || [];
  const roles = new Map(Array.isArray(raw) ? raw.map((item) => [String(item.id ?? item.tenantId ?? ''), String(item.role || '').toLowerCase()]) : []);
  return normalizeTenantList(payload).map((tenant) => ({ ...tenant, role: roles.get(tenant.id) || 'viewer' }));
}
import { emptyBlock, errorBlock, pageHead } from '../../lib/ui.js';

export function resolveTenant(tenants, tenantId) {
  const list = Array.isArray(tenants) ? tenants : [];
  return tenantId ? list.find((tenant) => tenant.id === tenantId) || null : list[0] || null;
}

export function userHead({ eyebrow, title, sub, tenants, tenant, onTenantChange, refresh }) {
  const actions = [];
  if (Array.isArray(tenants) && tenants.length > 1 && tenant) {
    const select = h('select', {
      class: 'select user-tenant-select',
      id: 'user-tenant-select',
      'aria-label': '选择实例',
      on: { change: (event) => onTenantChange?.(event.target.value) }
    });
    for (const item of tenants) {
      select.appendChild(h('option', { value: item.id, selected: item.id === tenant.id }, item.name));
    }
    select.value = tenant.id;
    actions.push(select);
  }
  if (refresh) {
    actions.push(h('button', { class: 'btn btn-ghost', type: 'button', on: { click: refresh } }, '刷新'));
  }
  return pageHead({ eyebrow, title, sub, actions });
}

export function renderTenantPrerequisite(root, { tenantsError = '', retryTenants = null, tenantId = '' } = {}) {
  root.replaceChildren();
  if (tenantsError) {
    root.appendChild(errorBlock({
      title: '实例信息加载失败',
      message: tenantsError,
      onRetry: retryTenants
    }));
    return;
  }
  root.appendChild(emptyBlock({
    title: tenantId ? '所选实例不可用' : '先创建一个实例',
    message: tenantId ? '请返回我的鱼，重新选择可访问的实例。' : '创建实例后，即可绑定渠道 Key、查看调用日志并提交充值申请。',
    symbol: '+',
    actions: h('a', { class: 'btn btn-primary', href: '#/user/instances' }, '前往我的实例')
  }));
}

export function userLoading(root, head, message) {
  root.replaceChildren();
  if (head) root.appendChild(head);
  const loading = h('div', { class: 'card card-pad', 'aria-busy': 'true' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { class: 'note mt-14' }, message)
  );
  root.appendChild(loading);
}
