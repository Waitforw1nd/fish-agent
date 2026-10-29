import { h, setBusy } from '../../lib/dom.js';
import { normalizeTenant } from '../../lib/normalize.js';
import { safeLink } from '../../lib/format.js';
import { badge, errorBlock, pageHead } from '../../lib/ui.js';
import { createTabs } from '../../components/tabs.js';
import { mountQQPanel } from '../../components/qq-panel.js';
import { mountBiliPanel } from '../../components/bili-panel.js';
import { mountAgentStudio } from '../../components/agent-studio/index.js';
import { readinessChecklist } from './shared.js';

export function mountUserInstance({ root, api, toast, tenantId, modalRoot, onSelectTenant, timers, visibility, section = 'overview', user } = {}) {
  let active = true, tenant = null, rawTenant = null, serial = 0, children = [], tabs = null, busy = false;
  let current = ['overview', 'whitelist', 'persona', 'behavior', 'runtime'].includes(section) ? section : 'overview';
  const content = h('div', { class: 'workspace-stack' });
  root.replaceChildren(pageHead({ title: '我的鱼', sub: '管理实例、接入和机器人设置。', actions: h('a', { class: 'btn btn-ghost', href: '#/user/instances' }, '返回我的鱼') }), content);
  const writable = () => ['owner', 'operator', 'admin'].includes(tenant?.role) || user?.role === 'admin';
  const hasUnsavedChanges = () => children.some((view) => view.hasUnsavedChanges?.());
  function clearChildren() { for (const view of children) view.destroy?.(); children = []; }
  function renderSection() {
    if (!active || !tenant) return;
    clearChildren();
    const body = content.querySelector('.user-workspace-body');
    if (!body) return;
    body.replaceChildren();
    const context = { api, tenantId, tenant: rawTenant, toast, modalRoot, timers, visibility, user, readOnly: !writable() };
    if (current === 'overview') {
      const qqRoot = h('div', {}); body.appendChild(qqRoot);
      children.push(mountQQPanel(qqRoot, context));
      if (typeof api.getBiliConfig === 'function' || typeof api.getBiliStatus === 'function') {
        const biliRoot = h('div', {}); body.appendChild(biliRoot); children.push(mountBiliPanel(biliRoot, context));
      }
      if (typeof api.getAgentStatus === 'function') {
        const status = h('p', { class: 'note' }, '正在读取机器人状态…');
        const pause = h('button', { class: 'btn btn-soft', type: 'button', disabled: !writable() }, '暂停回复');
        const card = h('section', { class: 'card card-pad workspace-section' }, h('h3', {}, '机器人回复'), status, pause);
        body.appendChild(card);
        let paused = false;
        const readStatus = async () => {
          try {
            const result = await api.getAgentStatus(tenantId);
            if (!active || !body.contains(card)) return;
            paused = Boolean(result?.paused ?? result?.status?.paused);
            status.textContent = paused ? '机器人已暂停回复。' : '机器人允许回复。';
            pause.textContent = paused ? '恢复回复' : '暂停回复';
          } catch { if (active && body.contains(card)) status.textContent = '运行状态暂不可用。'; }
        };
        pause.addEventListener('click', async () => {
          if (!writable()) return;
          setBusy(pause, true);
          try { await api.setAgentPause(tenantId, !paused); await readStatus(); }
          catch (error) { toast?.show?.(error?.message || '无法更新暂停状态。', { tone: 'danger' }); }
          finally { if (active) setBusy(pause, false); }
        });
        void readStatus();
      }
    } else {
      children.push(mountAgentStudio(body, { ...context, section: current }));
    }
  }
  function render() {
    if (!active || !tenant) return;
    const running = tenant.status === 'running';
    const transitional = ['starting', 'stopping', 'provisioning'].includes(tenant.status);
    const toggle = h('button', { class: 'btn btn-soft', type: 'button', disabled: !writable() || transitional || (!running && tenant.expiry?.state === 'expired') }, running ? '停止实例' : '启动实例');
    toggle.addEventListener('click', async () => {
      if (!active || busy || !writable()) return;
      busy = true; setBusy(toggle, true);
      try { if (running) await api.stopTenant(tenantId); else await api.startTenant(tenantId); if (active) await load(); }
      catch (error) { if (active) toast?.show?.(error?.message || '实例操作失败。', { tone: 'danger' }); }
      finally { busy = false; if (active) setBusy(toggle, false); }
    });
    const restart = h('button', { class: 'btn btn-ghost', type: 'button', disabled: !writable() || transitional || !running || typeof api.restartTenant !== 'function', on: { click: async () => {
      if (!writable() || busy) return;
      busy = true; setBusy(restart, true);
      try { await api.restartTenant(tenantId); if (active) await load(); }
      catch (error) { if (active) toast?.show?.(error?.message || '实例重启失败。', { tone: 'danger' }); }
      finally { busy = false; if (active) setBusy(restart, false); }
    } } }, '重启实例');
    const consoleUrl = safeLink(tenant.consoleUrl);
    tabs = createTabs({ tabs: [
      { id: 'overview', label: '概览与扫码接入' }, { id: 'whitelist', label: '群聊与白名单' },
      { id: 'persona', label: '人设与角色卡' }, { id: 'behavior', label: '响应档位与能力' },
      { id: 'runtime', label: '会话、记忆与备份' }
    ], selected: current, isDirty: hasUnsavedChanges, onSelect: (next) => { current = next; renderSection(); } });
    const summary = h('section', { class: 'card card-pad' }, h('h2', {}, tenant.name), badge(tenant.statusLabel, tenant.statusTone),
      h('div', { class: 'inline-buttons' }, writable() ? toggle : null, writable() && typeof api.restartTenant === 'function' ? restart : null,
        writable() && consoleUrl ? h('a', { class: 'btn btn-ghost', href: consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Bot 控制台 ↗') : null,
        h('a', { class: 'btn btn-ghost', href: '#/user/channel', on: { click: () => onSelectTenant?.(tenantId) } }, '渠道配置')),
      readinessChecklist(tenant, { onStart: writable() && !running ? () => toggle.click() : null, onSection: (next) => tabs.select(next), onSelectTenant }));
    content.replaceChildren(summary, tabs.node, h('div', { class: 'user-workspace-body workspace-stack', role: 'tabpanel' }));
    renderSection();
  }
  async function load() {
    const sequence = ++serial;
    try {
      const payload = await api.getTenant(tenantId);
      if (!active || sequence !== serial) return;
      clearChildren();
      rawTenant = payload?.tenant || payload;
      tenant = normalizeTenant(payload);
      tenant.role = String(payload?.role || rawTenant?.role || (user?.role === 'admin' ? 'admin' : '')).toLowerCase();
      rawTenant = { ...rawTenant, role: tenant.role };
      render();
    } catch (error) {
      if (active && sequence === serial) content.replaceChildren(errorBlock({ title: '实例加载失败', message: error?.message || '无法读取此实例，请检查权限或稍后重试。', onRetry: () => { void load(); } }));
    }
  }
  void load();
  return {
    refresh: load, reload: load, hasUnsavedChanges,
    canLeave: () => !hasUnsavedChanges() || !globalThis.confirm || globalThis.confirm('有未保存的更改，确定离开吗？'),
    destroy() { active = false; serial++; clearChildren(); root.replaceChildren(); }
  };
}
