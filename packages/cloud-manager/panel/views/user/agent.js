import { h } from '../../lib/dom.js';
import { mountAgentStudio } from '../../components/agent-studio/index.js';
import { renderTenantPrerequisite, resolveTenant, userHead } from './shared.js';

export function mountUserAgent({ root, api, toast, modalRoot, tenants = [], tenantId = '', tenantsError = '', retryTenants, onTenantChange, user } = {}) {
  const tenant = resolveTenant(tenants, tenantId);
  if (!tenant) {
    renderTenantPrerequisite(root, { tenantsError, retryTenants, tenantId });
    return { destroy() { root.replaceChildren(); }, hasUnsavedChanges: () => false, canLeave: () => true };
  }
  let studio;
  const head = userHead({
    title: 'QQ Agent 设置', eyebrow: 'Agent Studio',
    sub: '在同一工作台配置互动对象、人设、响应方式和记忆。',
    tenants, tenant,
    onTenantChange: (next) => {
      if (studio?.canLeave?.() === false) {
        const select = head.querySelector('select');
        if (select) select.value = tenant.id;
        return;
      }
      onTenantChange?.(next);
    },
    refresh: () => { if (studio?.canLeave?.() !== false) void studio?.reload?.(); }
  });
  const body = h('div', {});
  root.replaceChildren(head, body);
  studio = mountAgentStudio(body, {
    api, tenantId: tenant.id, tenant, toast, modalRoot, user,
    readOnly: tenant.role === 'viewer' && user?.role !== 'admin'
  });
  return { reload: () => studio.reload(), refresh: () => studio.reload(),
    hasUnsavedChanges: () => studio.hasUnsavedChanges(), canLeave: () => studio.canLeave(),
    destroy() { studio.destroy(); root.replaceChildren(); } };
}
