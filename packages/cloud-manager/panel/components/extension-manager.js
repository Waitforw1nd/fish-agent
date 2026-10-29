import { h, clear } from '../lib/dom.js';
import { normalizeExtensions } from '../lib/normalize.js';
import { openModal } from '../lib/modal.js';
import { button, checkbox, field, filePayload, optionalCall, panel, perform } from './common.js';

export function mountExtensionManager(root, ctx = {}) {
  let active = true, serial = 0, dialog = null;
  const canWrite = !ctx.readOnly && (ctx.admin || ctx.mode === 'admin' || ctx.user?.role === 'admin');
  const list = h('div', { class: 'workspace-stack' });
  const catalogSelect = h('select', { class: 'select', disabled: !canWrite });
  const file = h('input', { type: 'file', accept: '.zip,application/zip', disabled: !canWrite });
  const install = button('从平台插件库添加', async () => {
    if (!catalogSelect.value) return;
    if (await perform(ctx, () => ctx.api.installExtensionCatalog(ctx.tenantId, catalogSelect.value), '扩展已安装') !== undefined) void reload();
  }, !canWrite);
  const upload = button('上传并安装 ZIP', async () => {
    if (await perform(ctx, async () => ctx.api.installExtensionZip(ctx.tenantId, await filePayload(file.files?.[0])), '扩展已安装') !== undefined) void reload();
  }, !canWrite);
  const refresh = button('立即热重载', async () => {
    if (await perform(ctx, () => ctx.api.reloadExtensions(ctx.tenantId), '扩展已重载') !== undefined) void reload();
  }, !canWrite);
  root.replaceChildren(panel('实例插件与技能', h('p', { class: 'note' }, '管理员可为此实例安装扩展或屏蔽内置扩展。'),
    canWrite ? h('div', { class: 'workspace-stack' }, field('平台插件库', catalogSelect), install, field('ZIP 插件包', file), upload, refresh) : null, list));
  async function reload() {
    const current = ++serial;
    try {
      const [payload, catalog] = await Promise.all([
        optionalCall(ctx.api, 'getExtensions', ctx.tenantId),
        canWrite ? optionalCall(ctx.api, 'getExtensionCatalog') : Promise.resolve(null)
      ]);
      if (!active || current !== serial) return;
      clear(list); clear(catalogSelect);
      const options = normalizeExtensions(catalog);
      for (const item of options) catalogSelect.appendChild(h('option', { value: item.id }, `${item.name} ${item.version}`));
      const items = normalizeExtensions(payload);
      if (!items.length) list.appendChild(h('p', { class: 'note' }, '当前实例没有扩展。'));
      for (const item of items) {
        const permissions = Array.isArray(item.permissions) ? item.permissions.join('、') : '';
        list.appendChild(h('div', { class: 'workspace-item' },
          h('strong', {}, `${item.name} · ${item.version || '未标版本'}`),
          h('p', { class: 'note' }, `${item.type} · ${item.blocked ? '已屏蔽' : item.source === 'admin' ? '管理员安装' : item.source === 'builtin' ? '内置' : item.source || '可用'} · ${item.enabled === false ? '已停用' : '已启用'} · ${item.loaded ? '已加载' : '未加载'}${permissions ? ` · 权限：${permissions}` : ''}`),
          canWrite ? button(item.blocked ? '恢复内置扩展' : '从实例移除', async () => {
            if (item.blocked) {
              const result = await perform(ctx, () => ctx.api.restoreExtension(ctx.tenantId, item.id), '扩展已恢复');
              if (result !== undefined) void reload();
              return;
            }
            const clean = checkbox('同时清除该扩展的配置', false);
            const fallback = checkbox('卸载管理员版本后回退内置版本', false);
            const cancel = button('取消', () => dialog?.close('cancel'));
            const submit = button('确认移除', async () => {
              const result = await perform(ctx, () => ctx.api.removeExtension(ctx.tenantId, item.id, {
                cleanConfig: clean.control.checked,
                fallback: item.source === 'admin' && item.builtin && fallback.control.checked
              }), '扩展已移除');
              if (result !== undefined) { dialog?.close('removed'); void reload(); }
            }, false, 'danger');
            dialog = openModal({ root: ctx.modalRoot || document.getElementById('modal-root') || document.body,
              title: `移除 ${item.name}`, description: item.builtin ? '内置扩展默认只在当前实例屏蔽。' : '将移除当前实例安装的扩展。',
              content: h('div', { class: 'workspace-stack' }, clean.node, item.source === 'admin' && item.builtin ? fallback.node : null),
              footer: [cancel, submit], onClose: () => { dialog = null; } });
          }) : null));
      }
    } catch (error) { if (active && current === serial) list.textContent = error?.message || '无法读取扩展列表。'; }
  }
  void reload();
  return { reload, refresh: reload, hasUnsavedChanges: () => false, canLeave: () => true,
    destroy() { active = false; serial++; dialog?.close('destroy'); root.replaceChildren(); } };
}
