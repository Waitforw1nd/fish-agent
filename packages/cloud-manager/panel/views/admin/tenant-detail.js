import { h, setBusy } from '../../lib/dom.js';
import { normalizeTenant } from '../../lib/normalize.js';
import { formatDateTime, formatMicros } from '../../lib/format.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { pageHead, badge, alertBox, setAlert, cardHead } from '../../lib/ui.js';
import { confirmDialog } from '../../lib/modal.js';
import { mountRelay } from '../relay.js';
import { mountQQPanel } from '../../components/qq-panel.js';
import { mountBiliPanel } from '../../components/bili-panel.js';
import { mountAgentStudio } from '../../components/agent-studio/index.js';
import { mountExtensionManager } from '../../components/extension-manager.js';
import { mountTenantOps } from './tenant-ops.js';
import { dataTable, editDialog, labeled, rows, selectInput } from './shared.js';

const SECTIONS = [
  ['hosting', '通道托管'], ['agent', 'QQ Agent 配置'], ['extensions', '插件与技能'],
  ['relay', '中转与计费'], ['ops', '日志、成员与备份']
];

export function mountTenantDetail(root, ctx = {}) {
  let active = true;
  let child = null;
  let tenant = null;
  const dialogs = new Set();
  const prefix = `/api/tenants/${encodeURIComponent(ctx.tenantId)}`;
  const section = ctx.section || 'hosting';
  const head = h('div', {});
  const notice = alertBox('', 'danger', { hidden: true });
  const body = h('div', { class: 'tenant-detail-content' });
  const tabs = h('nav', { class: 'workspace-tabs', 'aria-label': '租户管理分区' }, ...SECTIONS.map(([key, label]) => h('a', {
    href: `#/tenants/${encodeURIComponent(ctx.tenantId)}/${key}`, class: `workspace-tab${key === section ? ' active' : ''}`,
    ...(key === section ? { 'aria-current': 'page' } : {})
  }, label)));
  root.replaceChildren(head, notice, tabs, body);

  async function action(button, name, requestBody) {
    if (!active || button.disabled) return;
    setBusy(button, true);
    setAlert(notice, '', 'danger');
    try {
      await ctx.api.request(`${prefix}/${name}`, { method: 'POST', ...(requestBody ? { body: requestBody } : {}) });
      if (!active) return;
      ctx.toast?.show?.('操作已完成', { tone: 'success' });
      await loadHeader();
      await (child?.reload?.() ?? child?.refresh?.());
      ctx.refreshTenants?.();
    } catch (error) {
      if (active) setAlert(notice, apiErrorMessage(error), 'danger');
    } finally {
      if (active) setBusy(button, false);
    }
  }

  function renew() {
    const days = h('input', { id: 'tenant-renew-days', type: 'number', min: 1, max: 3650, value: '30', class: 'input' });
    const plan = selectInput('tenant-renew-plan', [['trial', '体验版'], ['starter', '入门版'], ['pro', '专业版']], tenant?.planId || tenant?.plan?.id || 'trial');
    const dialog = editDialog(ctx, {
      title: '续费与更换套餐', fields: [labeled('延长天数', days), labeled('套餐', plan)],
      submitLabel: '确认续费',
      async submit() {
        const value = Number(days.value);
        if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error('天数必须为 1–3650 的整数');
        await ctx.api.request(`${prefix}/renew`, { method: 'POST', body: { days: value, planId: plan.value } });
      },
      onSaved: async () => { await loadHeader(); ctx.refreshTenants?.(); }
    });
    dialogs.add(dialog);
  }

  async function loadHeader() {
    try {
      const result = await ctx.api.getTenant(ctx.tenantId);
      if (!active) return;
      tenant = normalizeTenant(result.tenant || result);
      const controls = [];
      for (const [name, label] of [['start', '启动'], ['stop', '停止'], ['restart', '重启']]) {
        controls.push(h('button', { class: `btn ${name === 'start' ? 'btn-primary' : 'btn-ghost'} btn-sm`, type: 'button', on: { click: (event) => { void action(event.currentTarget, name); } } }, label));
      }
      controls.push(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: renew } }, '续费 / 改套餐'));
      const suspended = tenant.subscriptionStatus === 'suspended' || tenant.status === 'suspended';
      controls.push(h('button', { class: `btn ${suspended ? 'btn-ghost' : 'btn-danger'} btn-sm`, type: 'button', on: { click: async (event) => {
        const button = event.currentTarget;
        const confirmed = await confirmDialog({ root: ctx.modalRoot || document.getElementById('modal-root') || document.body,
          title: suspended ? '恢复实例资格' : '暂停实例资格', message: suspended ? '恢复后可重新启动实例。' : '暂停资格会停止当前实例进程。', confirmText: suspended ? '恢复资格' : '暂停资格', danger: !suspended });
        if (confirmed && active) void action(button, suspended ? 'resume' : 'suspend');
      } } }, suspended ? '恢复资格' : '暂停资格'));
      head.replaceChildren(pageHead({
        eyebrow: '租户管理中心', title: tenant.name,
        sub: `${tenant.plan?.name || tenant.planId || '体验版'} · 服务至 ${formatDateTime(tenant.expiresAt)}`,
        actions: [badge(tenant.statusLabel, tenant.statusTone), ...controls]
      }));
    } catch (error) {
      if (active) setAlert(notice, apiErrorMessage(error), 'danger');
    }
  }

  function mountSection() {
    const options = { ...ctx, root: body, tenant, admin: true, readOnly: false, mode: 'admin' };
    if (section === 'hosting') {
      const qqRoot = h('div', {});
      const biliRoot = h('div', {});
      body.replaceChildren(h('h3', { class: 'workspace-subtitle' }, 'QQ 内核托管与 B 站接入'), h('div', { class: 'workspace-grid' }, qqRoot, biliRoot));
      const qqPanel = mountQQPanel(qqRoot, options);
      const biliPanel = mountBiliPanel(biliRoot, options);
      child = {
        destroy() { qqPanel.destroy(); biliPanel.destroy(); },
        reload: () => Promise.all([qqPanel.reload(), biliPanel.reload()]),
        canLeave: () => qqPanel.canLeave() && biliPanel.canLeave(),
        hasUnsavedChanges: () => qqPanel.hasUnsavedChanges() || biliPanel.hasUnsavedChanges()
      };
    } else if (section === 'relay') {
      const extra = h('div', {});
      const relayRoot = h('div', {});
      body.replaceChildren(extra, relayRoot);
      child = mountRelay({ ...options, root: relayRoot });
      void loadWallet(extra);
    } else if (section === 'agent') child = mountAgentStudio(body, options);
    else if (section === 'extensions') child = mountExtensionManager(body, options);
    else child = mountTenantOps(body, options);
  }

  async function loadWallet(target) {
    try {
      const payload = await ctx.api.request(`${prefix}/billing/transactions`);
      if (!active) return;
      const topup = h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: () => {
        const amount = h('input', { id: 'tenant-topup-amount', class: 'input', type: 'number', step: '0.01', placeholder: '正数充值，负数扣款' });
        const note = h('input', { id: 'tenant-topup-note', class: 'input', maxLength: 500 });
        const dialog = editDialog(ctx, {
          title: '人工充值 / 扣款',
          fields: [labeled('金额（元）', amount), labeled('操作备注', note)],
          submitLabel: '确认调整',
          async submit() {
            const amountMicros = Math.round(Number(amount.value) * 1_000_000);
            if (!Number.isSafeInteger(amountMicros) || amountMicros === 0) throw new Error('请输入非零的有效金额');
            if (!note.value.trim()) throw new Error('请填写调整原因');
            await ctx.api.request(`${prefix}/relay/topup`, { method: 'POST', body: { amountMicros, note: note.value.trim() } });
          },
          onSaved: async () => { await loadWallet(target); await child?.refresh?.(); }
        });
        dialogs.add(dialog);
      } } }, '人工充值 / 扣款');
      target.replaceChildren(h('section', { class: 'card card-pad' }, cardHead({ title: '钱包流水', actions: topup }),
        dataTable([
          { label: '时间', value: (item) => formatDateTime(item.createdAt ?? item.created_at) },
          { label: '金额', value: (item) => formatMicros(item.amountMicros ?? item.amount_micros) },
          { label: '原因', value: (item) => item.note || item.reason || item.type || '—' }
        ], rows(payload, 'transactions'))));
    } catch (error) {
      if (active) target.replaceChildren(alertBox(apiErrorMessage(error), 'danger'));
    }
  }

  void loadHeader();
  mountSection();
  return {
    destroy() { active = false; child?.destroy?.(); for (const dialog of dialogs) dialog.close('destroy'); root.replaceChildren(); },
    refresh: loadHeader,
    canLeave: () => child?.canLeave?.() ?? true,
    hasUnsavedChanges: () => child?.hasUnsavedChanges?.() ?? false
  };
}
