import { h, clear, setBusy } from '../../lib/dom.js';
import { openModal } from '../../lib/modal.js';
import { normalizeTenant } from '../../lib/normalize.js';
import { normalizeUserTenants, readinessChecklist } from './shared.js';
import { formatDate, safeLink } from '../../lib/format.js';
import { validateTenantInput } from '../../lib/validate.js';
import { alertBox, badge, emptyBlock, errorBlock, pageHead, setAlert, skeletonGrid } from '../../lib/ui.js';

export function mountUserInstances({ root, api, toast, modalRoot = null, onTenantsChanged, onSelectTenant } = {}) {
  let active = true;
  let tenants = [];
  let loading = true;
  let loadError = '';
  let busyId = '';

  const content = h('div', {});
  const createButton = h('button', { class: 'btn btn-primary', type: 'button', on: { click: openCreate } }, '＋ 创建实例');
  const refreshButton = h('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => { void load(); } } }, '刷新');
  root.replaceChildren(
    pageHead({
      eyebrow: 'My Bots',
      title: '我的鱼',
      sub: '创建并管理你的 Bot 实例。渠道配置、调用记录和余额可在对应页面查看。',
      actions: [refreshButton, createButton]
    }),
    content
  );

  function render() {
    if (!active) return;
    clear(content);
    if (loading) {
      content.appendChild(skeletonGrid(2));
      return;
    }
    if (loadError) {
      content.appendChild(errorBlock({ title: '实例加载失败', message: loadError, onRetry: () => { void load(); } }));
      return;
    }
    if (!tenants.length) {
      content.appendChild(emptyBlock({
        title: '还没有实例',
        message: '创建第一个 Bot 实例后，就可以启动服务并绑定模型渠道。',
        symbol: '+',
        actions: h('button', { class: 'btn btn-primary', type: 'button', on: { click: openCreate } }, '创建第一个实例')
      }));
      return;
    }
    content.appendChild(h('div', { class: 'tenant-grid user-instance-grid' }, ...tenants.map(instanceCard)));
  }

  function instanceCard(tenant) {
    const running = tenant.status === 'running';
    const transitional = ['starting', 'stopping', 'provisioning'].includes(tenant.status);
    const action = tenant.role === 'viewer' ? null : h('button', {
      class: `btn btn-sm ${running ? 'btn-ghost' : 'btn-soft'}`,
      type: 'button',
      disabled: transitional || busyId === tenant.id,
      on: { click: () => { void toggleTenant(tenant, action); } }
    }, transitional ? tenant.statusLabel : running ? '停止' : '启动');
    const consoleUrl = safeLink(tenant.consoleUrl);
    return h('article', { class: 'tenant-card user-instance-card', dataset: { tenantId: tenant.id } },
      h('div', { class: 'tenant-card-top' },
        h('div', { class: 'tenant-card-title' },
          h('strong', { class: 'tenant-card-name' }, tenant.name),
          h('span', { class: 'tenant-slug' }, tenant.plan?.name || '默认套餐')
        ),
        badge(tenant.statusLabel, tenant.statusTone)
      ),
      h('div', { class: 'status-list user-instance-status' },
        h('div', { class: 'status-row' },
          h('span', { class: 'status-key' }, '运行状态'),
          h('span', { class: 'status-val', dataset: { tone: tenant.statusTone } }, tenant.statusLabel)
        ),
        h('div', { class: 'status-row' },
          h('span', { class: 'status-key' }, '服务有效期'),
          h('span', { class: 'status-val muted' }, tenant.expiresAt ? formatDate(tenant.expiresAt) : '未设置')
        )
      ),
      readinessChecklist(tenant, {
        onStart: tenant.role !== 'viewer' && !running && !transitional ? () => { void toggleTenant(tenant, action); } : null,
        onSelectTenant
      }),
      h('div', { class: 'tenant-card-foot' },
        h('span', { class: 'tenant-expiry' }, tenant.expiry?.label || '未设置服务期'),
        h('div', { class: 'inline-buttons' },
          h('a', { class: 'btn btn-soft btn-sm', href: `#/user/instances/${encodeURIComponent(tenant.id)}` }, '查看详情'),
          consoleUrl && tenant.role !== 'viewer' ? h('a', { class: 'btn btn-ghost btn-sm', href: consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Bot 控制台 ↗') : null,
          action
        )
      )
    );
  }

  async function load() {
    if (!active) return;
    loading = true;
    loadError = '';
    render();
    setBusy(refreshButton, true);
    try {
      const payload = await api.listTenants();
      if (!active) return;
      tenants = normalizeUserTenants(payload);
      loading = false;
      render();
      onTenantsChanged?.(tenants);
    } catch (error) {
      if (!active) return;
      loading = false;
      loadError = '无法加载实例列表，请稍后重试。';
      render();
    } finally {
      if (active) setBusy(refreshButton, false);
    }
  }

  async function toggleTenant(tenant, button) {
    if (busyId || !active) return;
    busyId = tenant.id;
    setBusy(button, true);
    try {
      const payload = tenant.status === 'running' ? await api.stopTenant(tenant.id) : await api.startTenant(tenant.id);
      if (!active) return;
      const updated = normalizeTenant(payload?.tenant ?? payload);
      if (updated.id) tenants = tenants.map((item) => item.id === updated.id ? updated : item);
      toast?.show?.(tenant.status === 'running' ? '实例停止请求已提交' : '实例启动请求已提交', { tone: 'success' });
      await load();
    } catch (error) {
      if (active) toast?.show?.('实例操作失败，请稍后重试。', { tone: 'danger' });
    } finally {
      busyId = '';
      if (active) setBusy(button, false);
    }
  }

  function openCreate() {
    if (!active) return;
    const nameInput = h('input', {
      class: 'input', id: 'create-instance-name', name: 'name', type: 'text',
      placeholder: '例如：我的小鱼 Bot', autocomplete: 'off', maxLength: 80
    });
    const formError = alertBox('', 'danger', { hidden: true });
    const planSelect = h('select', { class: 'select', id: 'create-instance-plan', disabled: true });
    const planHint = h('p', { class: 'note' }, '正在加载套餐…');
    const form = h('form', { class: 'modal-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-instance-name' }, '实例名称'),
        nameInput
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'create-instance-plan' }, '套餐'), planSelect),
      planHint,
      formError,
      h('p', { class: 'note' }, '限额按所选套餐及你拥有的实例总数计算；选择套餐不代表已付款。')
    );
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, '创建实例');
    const modal = openModal({
      root: modalRoot || document.getElementById('modal-root') || document.body,
      kicker: 'New Bot', title: '创建实例', description: '只需填写名称，其余运行配置由平台管理。',
      content: form, footer: [cancel, submit]
    });
    cancel.addEventListener('click', () => modal.close('cancel'));
    let plans = [];
    submit.disabled = true;
    const updateHint = () => {
      const plan = plans.find((item) => item.id === planSelect.value);
      planHint.textContent = plan ? `所选套餐最多拥有 ${plan.maxTenants} 个实例。` : '暂无可用套餐。';
    };
    planSelect.addEventListener('change', updateHint);
    Promise.resolve().then(() => api.listPlans()).then((payload) => {
      if (!active || !modal.isOpen()) return;
      plans = (Array.isArray(payload?.plans) ? payload.plans : []).filter((plan) => plan.id && Number.isFinite(Number(plan.maxTenants)));
      for (const plan of plans) planSelect.appendChild(h('option', { value: plan.id }, `${plan.name}（最多 ${plan.maxTenants} 个）`));
      if (plans.length) planSelect.value = plans.find((plan) => plan.id === 'trial')?.id || plans[0].id;
      planSelect.disabled = !plans.length;
      submit.disabled = !plans.length;
      updateHint();
    }).catch(() => {
      if (active && modal.isOpen()) planHint.textContent = '套餐加载失败，请关闭后重试。';
    });
    let submitting = false;
    async function submitCreate() {
      if (submitting || !active || !plans.some((plan) => plan.id === planSelect.value)) return;
      const result = validateTenantInput({ name: nameInput.value });
      if (!result.ok) {
        setAlert(formError, result.errors.name || '请输入实例名称', 'danger');
        return;
      }
      submitting = true;
      setBusy(submit, true);
      setAlert(formError, '', 'danger');
      try {
        await api.createTenant({ name: result.values.name, planId: planSelect.value });
        if (!active) return;
        modal.close('created');
        toast?.show?.('实例已创建', { tone: 'success' });
        await load();
      } catch (error) {
        if (active) setAlert(formError, error?.code === 'TENANT_LIMIT' ? '已达到所选套餐的实例数量上限。' : '创建实例失败，请稍后重试。', 'danger');
      } finally {
        submitting = false;
        if (active) setBusy(submit, false);
      }
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); void submitCreate(); });
    submit.addEventListener('click', () => { void submitCreate(); });
    setTimeout(() => { if (modal.isOpen()) nameInput.focus?.(); }, 0);
  }

  void load();
  return {
    destroy() { active = false; root.replaceChildren(); },
    refresh: load
  };
}
