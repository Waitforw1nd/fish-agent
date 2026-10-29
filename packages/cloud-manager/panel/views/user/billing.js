import { h, clear, setBusy } from '../../lib/dom.js';
import { normalizeRecharges } from '../../lib/user-data.js';
import { formatDateTime, formatMicros, redactText } from '../../lib/format.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { alertBox, badge, cardHead, emptyBlock, errorBlock, setAlert } from '../../lib/ui.js';
import { renderTenantPrerequisite, resolveTenant, userHead } from './shared.js';

export function mountUserBilling({ root, api, toast, tenants = [], tenantId = '', tenantsError = '', retryTenants, onTenantChange } = {}) {
  let active = true;
  let loading = true;
  let loadError = '';
  let data = normalizeRecharges(null);
  let transactions = [];
  let submitting = false;
  const tenant = resolveTenant(tenants, tenantId);
  if (!tenant) {
    renderTenantPrerequisite(root, { tenantsError, retryTenants, tenantId });
    return { destroy() { active = false; root.replaceChildren(); } };
  }

  const head = userHead({
    eyebrow: 'Wallet & Recharge', title: '钱包与充值',
    sub: '查看钱包余额并提交充值申请。充值不会即时到账，管理员审核通过后才会计入余额。',
    tenants, tenant, onTenantChange, refresh: () => { void load(); }
  });
  const wallet = h('div', { class: 'overview-strip user-wallet-strip' });
  const amountInput = h('input', {
    class: 'input', id: 'recharge-amount', name: 'amount', type: 'number',
    min: '0.01', step: '0.01', inputMode: 'decimal', placeholder: '例如：50', required: true
  });
  const formAlert = alertBox('', 'danger', { hidden: true });
  const readOnly = ['viewer', 'operator'].includes(tenant.role);
  const submitButton = h('button', { class: 'btn btn-primary', type: 'submit', disabled: readOnly }, '提交充值申请');
  amountInput.disabled = readOnly;
  const form = h('form', { class: 'relay-form', novalidate: true },
    h('div', { class: 'field' },
      h('div', { class: 'label-row' },
        h('label', { class: 'field-label', for: 'recharge-amount' }, '充值金额（元）'),
        h('span', { class: 'field-hint' }, '管理员审核后到账')
      ),
      amountInput
    ),
    formAlert,
    h('div', { class: 'inline-buttons' }, submitButton),
    h('p', { class: 'note' }, '这里只创建待审核订单，不代表支付成功，也不会自动扣款。')
  );
  const rechargeCard = h('section', { class: 'card card-pad' },
    cardHead({ kicker: 'Recharge Request', title: '申请充值', sub: '提交后请等待管理员审核，审核结果会显示在下方订单中。' }),
    form
  );
  const orders = h('div', {});
  const ledger = h('div', {});
  const planSelect = h('select', { class: 'select', id: 'renew-plan', disabled: readOnly }, h('option', { value: '' }, '沿用当前套餐'));
  const renewDays = h('input', { class: 'input', id: 'renew-days', type: 'number', min: 1, max: 3650, placeholder: '留空使用套餐默认天数', disabled: readOnly });
  const renewButton = h('button', { class: 'btn btn-soft', type: 'button', disabled: readOnly || typeof api.renewTenant !== 'function' }, '续费套餐');
  const renewal = h('section', { class: 'card card-pad mt-18' },
    cardHead({ title: '套餐续费', sub: '按所选套餐延长服务期，套餐赠送额度按平台规则入账。' }),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'renew-plan' }, '套餐'), planSelect),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'renew-days' }, '续费天数'), renewDays),
    renewButton);
  const result = h('div', {});
  root.replaceChildren(head, result);

  function renderWallet() {
    clear(wallet);
    const info = data.wallet;
    wallet.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-key' }, '可用余额'),
      h('div', { class: 'stat-val' }, info.available ? formatMicros(info.availableMicros, info.currency) : '—'),
      h('div', { class: 'stat-meta' }, '审核到账后可用于平台调用')
    ));
    wallet.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-key' }, '账面余额'),
      h('div', { class: 'stat-val' }, info.available ? formatMicros(info.balanceMicros, info.currency) : '—'),
      h('div', { class: 'stat-meta' }, `冻结 ${info.available ? formatMicros(info.heldMicros, info.currency) : '—'}`)
    ));
    wallet.appendChild(h('div', { class: 'stat' },
      h('div', { class: 'stat-key' }, '待审核订单'),
      h('div', { class: 'stat-val' }, String(data.recharges.filter((item) => item.pending).length)),
      h('div', { class: 'stat-meta' }, '未到账，不代表支付成功')
    ));
  }

  function renderOrders() {
    clear(orders);
    if (!data.recharges.length) {
      orders.appendChild(emptyBlock({ title: '暂无充值订单', message: '提交充值申请后，可在这里查看 pending 与审核状态。', symbol: '—' }));
      return;
    }
    const rows = data.recharges.map((order) => h('tr', { dataset: { status: order.pending ? 'pending' : order.status } },
      h('td', { class: 'mono' }, order.id || '—'),
      h('td', { class: 'cell-cost' }, formatMicros(order.amountMicros, order.currency)),
      h('td', {}, badge(order.statusLabel, order.statusTone, { dot: false })),
      h('td', {}, formatDateTime(order.createdAt)),
      h('td', {}, order.reviewedAt ? formatDateTime(order.reviewedAt) : '—'),
      h('td', { class: 'user-recharge-note' }, order.note ? redactText(order.note, { maxLength: 240 }) : '—')
    ));
    orders.appendChild(h('div', { class: 'table-wrap' },
      h('table', { class: 'billing-table user-recharge-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '订单号'), h('th', {}, '金额'), h('th', {}, '审核状态'),
          h('th', {}, '申请时间'), h('th', {}, '审核时间'), h('th', {}, '备注')
        )),
        h('tbody', {}, ...rows)
      )
    ));
  }

  function renderLedger() {
    clear(ledger);
    if (!transactions.length) {
      ledger.appendChild(h('p', { class: 'note' }, '暂无钱包流水。'));
      return;
    }
    const rows = transactions.map((item) => h('tr', {},
      h('td', {}, formatDateTime(item.createdAt)),
      h('td', {}, String(item.kind || '—')),
      h('td', {}, formatMicros(Number(item.amountMicros) || 0, item.currency || 'CNY')),
      h('td', {}, redactText(String(item.note || '—'), { maxLength: 240 }))));
    ledger.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'billing-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '类型'), h('th', {}, '金额'), h('th', {}, '备注'))),
      h('tbody', {}, ...rows))));
  }

  function render() {
    if (!active) return;
    clear(result);
    if (loading) {
      result.appendChild(h('div', { class: 'card card-pad', 'aria-busy': 'true' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'note mt-14' }, '正在读取钱包和充值订单…')));
      return;
    }
    if (loadError) {
      result.appendChild(errorBlock({ title: '充值信息加载失败', message: loadError, onRetry: () => { void load(); } }));
      return;
    }
    renderWallet();
    renderOrders();
    renderLedger();
    result.append(wallet, rechargeCard,
      h('section', { class: 'card card-pad mt-18' },
        cardHead({ kicker: 'Review Status', title: '充值订单', sub: 'pending 表示等待管理员审核；只有显示“已到账”才会增加余额。' }),
        orders
      ),
      h('section', { class: 'card card-pad mt-18' }, cardHead({ title: '钱包流水', sub: '查看充值到账、套餐赠送及余额调整。' }), ledger),
      renewal
    );
  }

  async function load() {
    if (!active) return;
    loading = true;
    loadError = '';
    render();
    const refresh = head.querySelector('button');
    setBusy(refresh, true);
    try {
      const [payload, overview, ledgerResult, plansResult] = await Promise.all([
        api.getRecharges(tenant.id), api.getRelayOverview(tenant.id),
        typeof api.getTransactions === 'function' ? api.getTransactions(tenant.id).catch(() => null) : Promise.resolve(null),
        typeof api.listPlans === 'function' ? api.listPlans().catch(() => null) : Promise.resolve(null)
      ]);
      if (!active) return;
      data = normalizeRecharges({ ...payload, wallet: overview?.wallet ?? overview?.billing });
      transactions = Array.isArray(ledgerResult?.transactions) ? ledgerResult.transactions : [];
      if (Array.isArray(plansResult?.plans)) {
        planSelect.replaceChildren(h('option', { value: '' }, '沿用当前套餐'), ...plansResult.plans.map((plan) => h('option', { value: plan.id }, plan.name || plan.id)));
      }
      loading = false;
      render();
    } catch (error) {
      if (!active) return;
      loading = false;
      loadError = apiErrorMessage(error, { fallback: '无法加载钱包与充值订单。' });
      render();
    } finally {
      if (active) setBusy(refresh, false);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitRecharge();
  });

  async function submitRecharge() {
    if (readOnly || submitting || !active) return;
    const amount = Number(amountInput.value);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
      setAlert(formAlert, '请输入 0.01 至 1,000,000 元之间的充值金额', 'danger');
      return;
    }
    submitting = true;
    setBusy(submitButton, true);
    setAlert(formAlert, '', 'danger');
    try {
      await api.createRecharge(tenant.id, { amount: Math.round(amount * 100) / 100 });
      if (!active) return;
      amountInput.value = '';
      toast?.show?.('充值申请已提交，管理员审核后到账', { tone: 'success' });
      await load();
    } catch (error) {
      if (active) setAlert(formAlert, apiErrorMessage(error, { fallback: '提交充值申请失败。' }), 'danger');
    } finally {
      submitting = false;
      if (active) setBusy(submitButton, false);
    }
  }

  amountInput.addEventListener('input', () => setAlert(formAlert, '', 'danger'));
  renewButton.addEventListener('click', async () => {
    if (readOnly || !active || typeof api.renewTenant !== 'function') return;
    const days = renewDays.value.trim();
    if (days && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 3650)) {
      toast?.show?.('续费天数应为 1 至 3650 的整数。', { tone: 'danger' }); return;
    }
    if (globalThis.confirm && !globalThis.confirm('确认延长实例服务期限并按套餐规则发放额度？')) return;
    const body = {};
    if (days) body.days = Number(days);
    if (planSelect.value) body.planId = planSelect.value;
    setBusy(renewButton, true);
    try {
      await api.renewTenant(tenant.id, body);
      if (active) { toast?.show?.('套餐续费已完成', { tone: 'success' }); await load(); }
    } catch (error) { if (active) toast?.show?.(apiErrorMessage(error, { fallback: '套餐续费失败。' }), { tone: 'danger' }); }
    finally { if (active) setBusy(renewButton, false); }
  });
  void load();
  return {
    destroy() { active = false; root.replaceChildren(); },
    refresh: load
  };
}
