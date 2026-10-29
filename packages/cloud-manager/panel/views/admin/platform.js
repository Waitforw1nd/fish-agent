import { h } from '../../lib/dom.js';
import { badge, cardHead, alertBox } from '../../lib/ui.js';
import { apiErrorMessage } from '../../lib/view-data.js';
import { confirmDialog } from '../../lib/modal.js';
import { createAdminPage, labeled, rows } from './shared.js';

export function mountPlatform(root, ctx = {}) {
  const page = createAdminPage(root, ctx, { title: '平台设置', sub: '公共模型渠道、QQ 登录授权与驱动环境检查。' });
  const dialogsRoot = ctx.modalRoot || document.getElementById('modal-root') || document.body;
  page.load(async () => {
    const results = await Promise.allSettled([
      ctx.api.request('/api/admin/upstream'), ctx.api.request('/api/admin/llbot-auth-token'), ctx.api.request('/api/qq/drivers')
    ]);
    const panels = results.map((result, index) => {
      if (result.status === 'rejected') return h('section', { class: 'card card-pad' }, cardHead({ title: ['公共模型上游', 'LLBot 登录授权', 'QQ 驱动预检'][index] }), alertBox(apiErrorMessage(result.reason), 'danger'));
      if (index === 0) return upstreamPanel(result.value.upstream || result.value);
      if (index === 1) return tokenPanel(result.value);
      const drivers = rows(result.value, 'drivers');
      return h('section', { class: 'card card-pad workspace-span-all' }, cardHead({ title: 'QQ 驱动预检', sub: '环境状态由服务器实时检查。' }),
        ...drivers.map((driver) => h('div', { class: 'workspace-driver-row' },
          h('strong', {}, driver.name || driver.label || driver.id),
          badge(driver.available === false || driver.usable === false ? '不可用' : '可用', driver.available === false || driver.usable === false ? 'warn' : 'ok'),
          h('p', { class: 'note' }, driver.reason || driver.message || (Array.isArray(driver.reasons) ? driver.reasons.join('；') : '')))));
    });
    return h('div', { class: 'workspace-grid' }, ...panels);
  });

  function upstreamPanel(data) {
    const baseUrl = h('input', { id: 'platform-upstream-url', class: 'input', type: 'url', value: data.baseUrl || '', placeholder: 'https://api.example.com/v1' });
    const key = h('input', { id: 'platform-upstream-key', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: data.configured || data.hasKey ? '已配置，留空保留' : '输入 API Key' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, '保存上游');
    const remove = h('button', { class: 'btn btn-danger', type: 'button' }, '清除上游');
    const form = h('form', { class: 'card card-pad modal-form' }, cardHead({ title: '公共模型上游' }),
      labeled('Base URL', baseUrl), labeled('API Key', key), h('div', { class: 'inline-buttons' }, save, remove));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const body = { baseUrl: baseUrl.value.trim(), ...(key.value.trim() ? { apiKey: key.value.trim() } : {}) };
      void page.perform(save, async () => { await ctx.api.request('/api/admin/upstream', { method: 'PUT', body }); key.value = ''; }, '上游已保存');
    });
    remove.addEventListener('click', async () => {
      if (await confirmDialog({ root: dialogsRoot, title: '清除公共模型上游', message: '使用平台渠道的实例将无法调用模型，直到重新配置上游。', danger: true, confirmText: '清除上游' })) {
        if (page.alive()) void page.perform(remove, () => ctx.api.request('/api/admin/upstream', { method: 'PUT', body: { clear: true } }), '上游已清除');
      }
    });
    page.cleanup(() => { key.value = ''; });
    return form;
  }

  function tokenPanel(data) {
    const token = h('input', { id: 'platform-llbot-token', class: 'input', type: 'password', autocomplete: 'new-password', placeholder: data.hasToken ? '授权已配置' : '尚未配置' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, '保存授权');
    const remove = h('button', { class: 'btn btn-ghost', type: 'button' }, '清除授权');
    const form = h('form', { class: 'card card-pad modal-form' }, cardHead({ title: 'LLBot 登录授权', badge: badge(data.hasToken ? '已配置' : '未配置', data.hasToken ? 'ok' : 'warn') }), labeled('平台 Auth Token', token), h('div', { class: 'inline-buttons' }, save, remove));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void page.perform(save, async () => {
        if (!token.value.trim()) throw new Error('请输入新的授权 Token；需要清除时使用清除授权');
        await ctx.api.request('/api/admin/llbot-auth-token', { method: 'PUT', body: { token: token.value.trim() } });
        token.value = '';
      }, '授权已保存');
    });
    remove.addEventListener('click', async () => {
      if (await confirmDialog({ root: dialogsRoot, title: '清除平台授权', message: '未配置独立授权的 LLBot 实例将需要重新提供授权。', confirmText: '清除授权', danger: true })) {
        if (page.alive()) void page.perform(remove, () => ctx.api.request('/api/admin/llbot-auth-token', { method: 'PUT', body: { token: '' } }), '授权已清除');
      }
    });
    page.cleanup(() => { token.value = ''; });
    return form;
  }
  return page;
}
