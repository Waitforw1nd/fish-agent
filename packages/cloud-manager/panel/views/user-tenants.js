import { h, clear, setBusy } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { normalizeTenantList } from '../lib/normalize.js';
import { validateTenantInput } from '../lib/validate.js';
import { apiErrorMessage } from '../lib/view-data.js';
import { alertBox, badge, emptyBlock, errorBlock, pageHead, setAlert, skeletonGrid } from '../lib/ui.js';

export function mountUserTenants(container, { api, userId, toast, modalRoot = null, onTenantsChanged } = {}) {
  let active = true;
  let modal = null;
  let sequence = 0;
  let user = null;
  const content = h('div', {});
  const heading = h('div', {});
  const refresh = h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => { void load(); } } }, '刷新');
  const create = h('button', { class: 'btn btn-primary', type: 'button', disabled: true, on: { click: () => { void openCreate(); } } }, '＋ 创建实例');
  container.replaceChildren(heading, content);

  function renderHead() {
    heading.replaceChildren(pageHead({ eyebrow: 'User Instances', title: user ? `${user.username || user.id} 的实例` : '用户实例', sub: '仅显示该用户拥有的实例。', actions: [h('a', { class: 'btn btn-ghost', href: '#/users' }, '返回用户管理'), refresh, create] }));
  }

  async function load() {
    const request = ++sequence;
    create.disabled = true;
    clear(content);
    content.appendChild(skeletonGrid(2));
    setBusy(refresh, true);
    try {
      const payload = await api.getUserTenants(userId);
      if (!active || request !== sequence) return;
      user = payload?.user || null;
      if (!user || !Array.isArray(payload?.tenants)) throw new Error('用户实例数据无效');
      const tenants = normalizeTenantList(payload.tenants);
      create.disabled = false;
      renderHead();
      clear(content);
      if (!tenants.length) {
        content.appendChild(emptyBlock({ title: '该用户还没有拥有的实例', message: '可以为该用户创建实例。', symbol: '+' }));
        return;
      }
      content.appendChild(h('div', { class: 'tenant-grid' }, ...tenants.map((tenant) => {
        const id = encodeURIComponent(tenant.id);
        return h('article', { class: 'tenant-card', dataset: { tenantId: tenant.id } },
          h('div', { class: 'tenant-card-top' }, h('strong', { class: 'tenant-card-name' }, tenant.name), badge(tenant.statusLabel, tenant.statusTone)),
          h('div', { class: 'tenant-meta' }, h('span', { class: 'tenant-meta-item' }, tenant.plan?.name || '默认套餐')),
          h('div', { class: 'tenant-card-foot' }, h('span', { class: 'tenant-expiry' }, tenant.expiry?.label || '未设置服务期'),
            h('div', { class: 'tenant-links' },
              h('a', { class: 'tenant-link', href: `#/tenants/${id}/hosting` }, 'Hosting →'),
              h('a', { class: 'tenant-link', href: `#/tenants/${id}/relay` }, 'Relay →'))));
      })));
    } catch (error) {
      if (!active || request !== sequence) return;
      user = null;
      renderHead();
      clear(content);
      content.appendChild(errorBlock({ title: '用户实例加载失败', message: apiErrorMessage(error, { fallback: '无法加载用户实例。' }), onRetry: () => { void load(); } }));
    } finally {
      if (active && request === sequence) setBusy(refresh, false);
    }
  }

  async function openCreate() {
    if (!active || !user || modal?.isOpen()) return;
    const name = h('input', { class: 'input', id: 'admin-instance-name', name: 'name', maxLength: 80, autocomplete: 'off' });
    const plan = h('select', { class: 'input', id: 'admin-instance-plan', name: 'planId', disabled: true });
    const planNote = h('p', { class: 'note' }, '正在加载套餐…');
    const error = alertBox('', 'danger', { hidden: true });
    const form = h('form', { class: 'modal-form', novalidate: true },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'admin-instance-name' }, '实例名称'), name),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'admin-instance-plan' }, '套餐'), plan, planNote), error);
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
    const submit = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, '创建实例');
    modal = openModal({ root: modalRoot || document.getElementById('modal-root') || document.body, title: '为用户创建实例', description: `所有者：${user.username || user.id}`, content: form, footer: [cancel, submit] });
    const dialog = modal;
    cancel.addEventListener('click', () => dialog.close('cancel'));
    let plans = [];
    let submitting = false;
    async function submitForm() {
      if (!active || !dialog.isOpen() || submitting) return;
      const result = validateTenantInput({ name: name.value });
      if (!result.ok) return setAlert(error, result.errors.name, 'danger');
      if (!plans.some((item) => String(item.id) === plan.value)) return setAlert(error, '请选择有效套餐', 'danger');
      submitting = true;
      setBusy(submit, true);
      setAlert(error, '', 'danger');
      try {
        await api.createTenant({ name: result.values.name, ownerUserId: userId, planId: plan.value });
        if (!active) return;
        dialog.close('created');
        toast?.show?.('实例已创建', { tone: 'success' });
        onTenantsChanged?.();
        await load();
      } catch (err) {
        if (active && dialog.isOpen()) setAlert(error, apiErrorMessage(err, { fallback: '创建实例失败。' }), 'danger');
      } finally {
        submitting = false;
        if (active) setBusy(submit, false);
      }
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); void submitForm(); });
    submit.addEventListener('click', () => { void submitForm(); });
    try {
      const payload = await api.getPlans();
      if (!active || !dialog.isOpen()) return;
      plans = Array.isArray(payload?.plans) ? payload.plans.filter((item) => item?.id) : [];
      if (!plans.length) throw new Error('没有可用套餐');
      plan.replaceChildren(...plans.map((item) => h('option', { value: String(item.id) }, `${item.name || item.id}${Number.isFinite(Number(item.maxTenants)) ? `（限额 ${item.maxTenants} 个实例）` : ''}`)));
      plan.disabled = false;
      submit.disabled = false;
      planNote.textContent = '套餐限额依平台规则执行；管理员创建遵循现有权限规则。';
    } catch (err) {
      if (active && dialog.isOpen()) {
        planNote.textContent = '套餐加载失败，请关闭后重试。';
        setAlert(error, apiErrorMessage(err, { fallback: '无法加载套餐。' }), 'danger');
      }
    }
  }

  renderHead();
  void load();
  return { destroy() { active = false; sequence++; modal?.close('destroy'); container.replaceChildren(); }, refresh: load };
}
