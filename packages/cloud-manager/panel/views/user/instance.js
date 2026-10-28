import { h, clear, setBusy } from '../../lib/dom.js';
import { normalizeTenant, normalizeQQStatus } from '../../lib/normalize.js';
import { safeLink } from '../../lib/format.js';
import { badge, errorBlock, pageHead } from '../../lib/ui.js';
import { openQrFlow } from '../qr.js';
import { createPoller } from '../../lib/polling.js';

export function mountUserInstance({ root, api, toast, tenantId, modalRoot, onSelectTenant, timers, visibility } = {}) {
  let active = true;
  let tenant = null;
  let qr = null;
  let busy = false;
  let loadSequence = 0;
  let statusSequence = 0;
  let statusText = null;
  const statusPoller = createPoller({
    intervalMs: 5000, timers, visibility,
    task: async () => {
      const sequence = ++statusSequence;
      const payload = await api.getQQStatus(tenantId);
      if (!active || sequence !== statusSequence || !tenant) return;
      tenant.qq = normalizeQQStatus(payload);
      if (statusText) statusText.textContent = `状态：${tenant.qq.phaseLabel}`;
    }
  });
  const content = h('div', {});
  root.replaceChildren(pageHead({ title: '我的鱼', sub: '管理实例和 QQ 登录。', actions: h('a', { class: 'btn btn-ghost', href: '#/user/instances' }, '返回我的鱼') }), content);

  function render() {
    if (!active || !tenant) return;
    const writable = ['owner', 'operator', 'admin'].includes(tenant.role);
    const running = tenant.status === 'running';
    const input = h('input', { class: 'input', id: 'user-qq-uin', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '输入 QQ 号' });
    const login = h('button', { class: 'btn btn-primary', type: 'button' }, '扫码登录 QQ');
    const toggle = h('button', { class: 'btn btn-soft', type: 'button', disabled: ['starting', 'stopping', 'provisioning'].includes(tenant.status) }, running ? '停止实例' : '启动实例');
    const consoleUrl = safeLink(tenant.consoleUrl);
    const actions = h('div', { class: 'inline-buttons' },
      writable ? toggle : null,
      writable && consoleUrl ? h('a', { class: 'btn btn-ghost', href: consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Bot 控制台 ↗') : null,
      h('a', { class: 'btn btn-ghost', href: '#/user/channel', on: { click: () => onSelectTenant?.(tenantId) } }, '渠道配置')
    );
    statusText = h('p', { class: 'note', 'aria-live': 'polite' }, `状态：${tenant.qq?.phaseLabel || '未知'}`);
    const qq = h('section', { class: 'card card-pad' }, h('h2', {}, 'QQ 登录'), statusText,
      writable ? h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'user-qq-uin' }, 'QQ 号'), input, login) : h('p', { class: 'note' }, '当前为只读权限。'));
    clear(content);
    content.appendChild(h('section', { class: 'card card-pad' }, h('h2', {}, tenant.name), badge(tenant.statusLabel, tenant.statusTone), actions));
    content.appendChild(qq);
    toggle.addEventListener('click', async () => {
      if (busy || !active) return;
      busy = true; setBusy(toggle, true);
      try {
        if (running) await api.stopTenant(tenantId); else await api.startTenant(tenantId);
        if (active) await load();
      } catch { if (active) toast?.show?.('实例操作失败，请稍后重试。', { tone: 'danger' }); }
      finally { busy = false; if (active) setBusy(toggle, false); }
    });
    login.addEventListener('click', async () => {
      if (busy || !active) return;
      const uin = input.value.trim();
      if (!/^\d{5,12}$/.test(uin)) { toast?.show?.('请输入有效的 QQ 号。', { tone: 'danger' }); return; }
      busy = true; setBusy(login, true);
      try {
        await api.prepareQQ(tenantId, { kernel: 'llbot', uin });
        if (!active) return;
        await api.startQQ(tenantId, { kernel: 'llbot', uin });
        if (!active) return;
        qr = openQrFlow({ modalRoot, api, tenantId, toast, safeMessages: true, onConfirmed: () => { void statusPoller.refreshNow(); } });
      } catch { if (active) toast?.show?.('QQ 登录准备失败，请联系平台管理员检查配置。', { tone: 'danger' }); }
      finally { busy = false; if (active) setBusy(login, false); }
    });
  }

  async function load() {
    const sequence = ++loadSequence;
    try {
      const payload = await api.getTenant(tenantId);
      if (!active || sequence !== loadSequence) return;
      const previousQQ = tenant?.qq;
      tenant = normalizeTenant(payload);
      tenant.role = String(payload?.role || payload?.tenant?.role || '').toLowerCase();
      if (previousQQ) tenant.qq = previousQQ;
      else if (payload?.qq) tenant.qq = normalizeQQStatus(payload.qq);
      render();
      if (!statusPoller.isRunning()) statusPoller.start();
      else void statusPoller.refreshNow();
    } catch {
      if (active && sequence === loadSequence) content.replaceChildren(errorBlock({ title: '实例加载失败', message: '无法读取此实例，请检查权限或稍后重试。', onRetry: () => { void load(); } }));
    }
  }
  void load();
  return { destroy() { active = false; statusSequence++; statusPoller.stop(); qr?.close(); root.replaceChildren(); }, refresh: load };
}
