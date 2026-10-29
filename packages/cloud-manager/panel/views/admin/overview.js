import { h } from '../../lib/dom.js';
import { formatMicros, formatNumber } from '../../lib/format.js';
import { alertBox, badge, cardHead } from '../../lib/ui.js';
import { createAdminPage } from './shared.js';

export function mountOverview(root, ctx = {}) {
  const page = createAdminPage(root, ctx, { title: '运营总览', sub: '从开通、使用到续费，查看平台当前运行情况。' });
  page.load(async () => {
    const payload = await ctx.api.request('/api/admin/overview');
    const data = payload.overview || payload;
    const tenants = data.tenants || {};
    const users = data.users || {};
    const recharges = data.recharges || data.pendingRecharges || {};
    const usage = data.usage || {};
    const metrics = [
      ['租户总数', tenants.total], ['运行中', tenants.running], ['对话就绪', tenants.ready ?? tenants.chatReady],
      ['三日内到期', tenants.expiring ?? tenants.expiringSoon], ['已暂停', tenants.suspended],
      ['注册用户', users.total], ['待审核充值', recharges.pendingCount ?? recharges.pending ?? recharges.count],
      ['待审金额', formatMicros(recharges.pendingAmountMicros ?? recharges.amountMicros ?? 0)]
    ];
    const today = usage.today || data.today || {};
    const week = usage.week || usage.last7Days || data.last7Days || {};
    const pending = Number(recharges.pendingCount ?? recharges.pending ?? recharges.count ?? 0);
    const health = data.health || {};
    const drivers = data.drivers || health.drivers || [];
    const upstream = data.upstream || health.upstream || {};
    return h('div', {},
      h('div', { class: 'workspace-metrics' }, ...metrics.map(([label, value]) => h('article', { class: 'stat' },
        h('div', { class: 'stat-key' }, label), h('strong', { class: 'stat-val' }, typeof value === 'string' ? value : formatNumber(value ?? 0))))),
      pending ? h('a', { href: '#/admin/recharges', class: 'workspace-notice-link' }, alertBox(`${pending} 笔充值等待审核，前往处理 →`, 'warn')) : null,
      h('div', { class: 'workspace-grid' },
        h('section', { class: 'card card-pad' }, cardHead({ title: '模型用量' }),
          h('dl', { class: 'workspace-facts' },
            h('dt', {}, '今日 Token'), h('dd', {}, formatNumber(today.totalTokens ?? today.tokens ?? 0)),
            h('dt', {}, '今日消耗'), h('dd', {}, formatMicros(today.costMicros ?? today.chargedMicros ?? 0)),
            h('dt', {}, '近 7 日 Token'), h('dd', {}, formatNumber(week.totalTokens ?? week.tokens ?? 0)),
            h('dt', {}, '近 7 日消耗'), h('dd', {}, formatMicros(week.costMicros ?? week.chargedMicros ?? 0)))),
        h('section', { class: 'card card-pad' }, cardHead({ title: '环境体检', actions: h('a', { class: 'btn btn-ghost btn-sm', href: '#/admin/platform' }, '平台设置') }),
          h('div', { class: 'workspace-driver-row' }, h('strong', {}, '公共模型上游'), badge(upstream.configured ? '已配置' : '未配置', upstream.configured ? 'ok' : 'warn')),
          ...(Array.isArray(drivers) ? drivers : drivers.drivers || []).map((driver) => h('div', { class: 'workspace-driver-row' },
            h('strong', {}, driver.label || driver.name || driver.id), badge(driver.available === false ? '不可用' : '可用', driver.available === false ? 'warn' : 'ok'),
            h('p', { class: 'note' }, driver.reason || ''))))));
  });
  return page;
}
