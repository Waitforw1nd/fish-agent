// 租户总览：统计条、租户卡片、创建弹窗。列表操作后通过 onTenantsChanged 同步侧栏。

import { h, setBusy, setHidden, clear } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { normalizeTenant, normalizeTenantList } from '../lib/normalize.js';
import { formatDate } from '../lib/format.js';
import { apiErrorMessage, tenantSummary } from '../lib/view-data.js';
import { validateTenantInput, suggestSlug } from '../lib/validate.js';
import {
  badge,
  emptyBlock,
  errorBlock,
  pageHead,
  skeletonGrid,
  alertBox,
  setAlert
} from '../lib/ui.js';

export function mountTenants({ root, api, toast, navigate, onTenantsChanged, modalRoot = null, now = Date.now() } = {}) {
  let active = true;
  let current = [];
  let owners = new Map();
  let sequence = 0;
  let loading = true;
  let loadError = null;

  root.replaceChildren();
  const content = h('div', {});
  const createButton = h('button', { class: 'btn btn-primary', type: 'button' }, '＋ 创建租户');
  const refreshButton = h('button', { class: 'btn btn-ghost', type: 'button' }, '刷新');

  const head = pageHead({
    eyebrow: 'Tenants',
    title: '租户总览',
    sub: '每个租户拥有独立的 QQ/B 站进程、数据目录、端口租约与 Relay Key。',
    actions: [refreshButton, createButton]
  });
  root.appendChild(h('div', {},
    head,
    content
  ));

  function render() {
    if (!active) return;
    clear(content);
    if (loading) {
      content.appendChild(h('div', { class: 'overview-strip' },
        ...Array.from({ length: 3 }, () => h('div', { class: 'skeleton', style: { height: '88px', borderRadius: '14px' } }))
      ));
      content.appendChild(skeletonGrid(3));
      return;
    }
    if (loadError) {
      content.appendChild(errorBlock({
        title: '租户列表加载失败',
        message: loadError,
        onRetry: () => { void load(); }
      }));
      return;
    }

    const summary = tenantSummary(current, now);
    content.appendChild(h('div', { class: 'overview-strip' },
      statCard('租户总数', summary.total, current.length ? '全部托管实例' : '尚未创建'),
      statCard('运行中', summary.running, summary.running ? '进程健康' : '暂无运行实例'),
      statCard('即将到期', summary.expiring, summary.expired ? `另有 ${summary.expired} 个已到期` : '3 天内到期')
    ));

    if (!current.length) {
      content.appendChild(emptyBlock({
        title: '还没有租户',
        message: '创建第一个租户后，即可配置 QQ 内核、绑定 B 站并接入 Relay 计费。',
        symbol: '+',
        actions: h('button', {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: openCreate }
        }, '创建第一个租户')
      }));
      return;
    }

    const grid = h('div', { class: 'tenant-grid' });
    for (const tenant of current) grid.appendChild(tenantCard(tenant));
    content.appendChild(grid);
  }

  function statCard(key, value, meta) {
    return h('div', { class: 'stat' },
      h('div', { class: 'stat-key' }, key),
      h('div', { class: 'stat-val' }, String(value)),
      h('div', { class: 'stat-meta' }, meta)
    );
  }

  function tenantCard(tenant) {
    const expiryState = tenant.expiry?.state || 'none';
    const expiryLabel = tenant.expiry?.label || '未设置到期';
    const qqLabel = tenant.qq?.available ? tenant.qq.phaseLabel : '—';
    const qqTone = tenant.qq?.available ? tenant.qq.tone : 'neutral';
    const biliLabel = tenant.bili?.available ? tenant.bili.phaseLabel : '—';
    const biliTone = tenant.bili?.available ? tenant.bili.tone : 'neutral';
    const relayLabel = tenant.relay ? tenant.relay.keyStatusLabel : '—';
    const relayTone = tenant.relay ? tenant.relay.keyStatusTone : 'neutral';

    return h('article', { class: 'tenant-card', dataset: { tenantId: tenant.id } },
      h('div', { class: 'tenant-card-top' },
        h('div', { class: 'tenant-card-title' },
          h('a', { class: 'tenant-card-name', href: `#/tenants/${encodeURIComponent(tenant.id)}/hosting` }, tenant.name),
          h('span', { class: 'tenant-slug' }, tenant.slug ? `@${tenant.slug}` : '未分配子域')
        ),
        badge(tenant.statusLabel, tenant.statusTone)
      ),
      h('div', { class: 'tenant-meta' },
        h('span', { class: 'tenant-meta-item' }, tenant.plan?.name || '默认套餐'),
        h('span', { class: 'tenant-meta-item' }, expiryLabel),
        tenant.ownerUserId
          ? h('a', { class: 'tenant-meta-item', href: `#/users/${encodeURIComponent(tenant.ownerUserId)}/instances` }, `所属用户：${owners.get(tenant.ownerUserId) || tenant.ownerUserId}`)
          : h('span', { class: 'tenant-meta-item' }, '所属用户：未知')
      ),
      h('div', { class: 'tenant-mini-status' },
        miniStatus('QQ', qqLabel, qqTone),
        miniStatus('B 站', biliLabel, biliTone),
        miniStatus('Relay', relayLabel, relayTone)
      ),
      h('div', { class: 'tenant-card-foot' },
        h('span', { class: 'tenant-expiry', dataset: { state: expiryState } },
          tenant.expiresAt ? `服务至 ${formatDate(tenant.expiresAt)}` : '未设置服务期'
        ),
        h('div', { class: 'tenant-links' },
          h('a', { class: 'tenant-link', href: `#/tenants/${encodeURIComponent(tenant.id)}/hosting` }, 'Hosting →'),
          h('a', { class: 'tenant-link', href: `#/tenants/${encodeURIComponent(tenant.id)}/relay` }, 'Relay →')
        )
      )
    );
  }

  function miniStatus(key, value, tone) {
    return h('div', { class: 'mini-status' },
      h('span', { class: 'mini-status-key' }, key),
      h('span', { class: 'mini-status-val' },
        h('span', { class: 'status-dot', dataset: { tone }, 'aria-hidden': 'true' }),
        value
      )
    );
  }

  async function load() {
    if (!active) return;
    const request = ++sequence;
    loading = true;
    loadError = null;
    render();
    setBusy(refreshButton, true);
    try {
      const payload = await api.listTenants();
      if (!active || request !== sequence) return;
      current = normalizeTenantList(payload);
      owners = new Map();
      loading = false;
      render();
      onTenantsChanged?.(current);
      try {
        const result = await api.getUsers();
        if (!active || request !== sequence) return;
        owners = new Map((Array.isArray(result?.users) ? result.users : []).map((user) => [String(user.id), String(user.username || user.id)]));
        render();
      } catch {
        // Keep owner IDs visible when user lookup fails.
      }
    } catch (error) {
      if (!active || request !== sequence) return;
      loading = false;
      loadError = apiErrorMessage(error, { fallback: '无法加载租户列表。' });
      render();
    } finally {
      if (active && request === sequence) setBusy(refreshButton, false);
    }
  }

  function openCreate() {
    if (!active) return;
    const nameInput = h('input', {
      class: 'input',
      id: 'create-tenant-name',
      name: 'name',
      type: 'text',
      placeholder: '例如：小鱼的机器人',
      autocomplete: 'off',
      maxLength: 80
    });
    const slugInput = h('input', {
      class: 'input',
      id: 'create-tenant-slug',
      name: 'slug',
      type: 'text',
      placeholder: '留空由平台分配，例如 fish-bot',
      autocomplete: 'off',
      maxLength: 32,
      spellcheck: false
    });
    const formError = alertBox('', 'danger', { hidden: true });
    const nameError = h('p', { class: 'form-error', hidden: true });
    const slugError = h('p', { class: 'form-error', hidden: true });
    let slugTouched = false;
    let submitting = false;

    const form = h('form', { class: 'modal-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'create-tenant-name' }, '租户名称'),
        nameInput,
        nameError
      ),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' },
          h('label', { class: 'field-label', for: 'create-tenant-slug' }, '子域名（可选）'),
          h('span', { class: 'field-hint' }, '小写字母、数字与中划线')
        ),
        slugInput,
        slugError
      ),
      formError,
      h('p', { class: 'note' }, '创建后平台会分配独立数据目录与端口；套餐和 Relay Key 可在租户内继续配置。')
    );

    nameInput.addEventListener('input', () => {
      if (!slugTouched) slugInput.value = suggestSlug(nameInput.value);
    });
    slugInput.addEventListener('input', () => {
      slugTouched = true;
    });

    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, '创建租户');
    const modal = openModal({
      root: modalRoot || document.getElementById('modal-root') || document.body,
      kicker: 'New Tenant',
      title: '创建租户',
      description: '一个租户对应一套独立的 Bot 运行环境。',
      content: form,
      footer: [cancel, submit]
    });

    cancel.addEventListener('click', () => modal.close('cancel'));

    function clearFieldErrors() {
      setHidden(nameError, true);
      setHidden(slugError, true);
      nameInput.setAttribute('aria-invalid', 'false');
      slugInput.setAttribute('aria-invalid', 'false');
      setAlert(formError, '', 'danger');
    }

    async function submitCreate() {
      if (submitting || !active) return;
      clearFieldErrors();
      const result = validateTenantInput({ name: nameInput.value, slug: slugInput.value });
      if (!result.ok) {
        if (result.errors.name) {
          nameError.textContent = result.errors.name;
          setHidden(nameError, false);
          nameInput.setAttribute('aria-invalid', 'true');
        }
        if (result.errors.slug) {
          slugError.textContent = result.errors.slug;
          setHidden(slugError, false);
          slugInput.setAttribute('aria-invalid', 'true');
        }
        return;
      }
      submitting = true;
      setBusy(submit, true);
      try {
        const payload = await api.createTenant(result.values);
        const created = normalizeTenant(payload?.tenant ?? payload);
        toast?.show?.('租户已创建', { tone: 'success' });
        modal.close('created');
        await load();
        if (created.id) navigate?.('#/tenants/' + encodeURIComponent(created.id) + '/hosting');
      } catch (error) {
        if (!active) return;
        const message = apiErrorMessage(error, { fallback: '创建租户失败。' });
        if (error?.status === 409) {
          slugError.textContent = message;
          setHidden(slugError, false);
          slugInput.setAttribute('aria-invalid', 'true');
        } else if (error?.status === 400 && /slug|子域/i.test(message)) {
          slugError.textContent = message;
          setHidden(slugError, false);
        } else {
          setAlert(formError, message, 'danger');
        }
      } finally {
        submitting = false;
        if (active) setBusy(submit, false);
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitCreate();
    });
    submit.addEventListener('click', () => { void submitCreate(); });
    setTimeout(() => { if (modal.isOpen()) nameInput.focus?.(); }, 0);
  }

  createButton.addEventListener('click', openCreate);
  refreshButton.addEventListener('click', () => { void load(); });

  void load();

  return {
    destroy() {
      active = false;
      root.replaceChildren();
    },
    refresh: load
  };
}
