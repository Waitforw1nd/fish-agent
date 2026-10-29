import { h, clear, setBusy } from '../../lib/dom.js';
import { normalizeTenant, normalizeQQStatus, normalizeQQDrivers } from '../../lib/normalize.js';
import { safeLink } from '../../lib/format.js';
import { badge, errorBlock, pageHead } from '../../lib/ui.js';
import { openQrFlow } from '../qr.js';
import { createSwitchController } from '../qq-switch.js';
import { createPoller } from '../../lib/polling.js';

export function mountUserInstance({ root, api, toast, tenantId, modalRoot, onSelectTenant, timers, visibility } = {}) {
  let active = true, tenant = null, qr = null, busy = false, loadSequence = 0, statusSequence = 0;
  let drivers = { defaultDriver: '', drivers: [] }, selected = '', statusText = null, login = null, select = null, reason = null;
  const statusPoller = createPoller({ intervalMs: 5000, timers, visibility, task: async () => {
    const sequence = ++statusSequence;
    const payload = await api.getQQStatus(tenantId);
    if (!active || sequence !== statusSequence || !tenant) return;
    tenant.qq = normalizeQQStatus(payload);
    void switcher.restore(tenant.qq.activeOperationId || tenant.qq.latestOperationId);
    updateStatus();
  } });
  const switcher = createSwitchController({ api, tenantId, modalRoot, toast, timers, onChange: () => updateStatus() });
  const content = h('div', {});
  root.replaceChildren(pageHead({ title: '我的鱼', sub: '管理实例和 QQ 登录。', actions: h('a', { class: 'btn btn-ghost', href: '#/user/instances' }, '返回我的鱼') }), content);
  const chosen = () => drivers.drivers.find((driver) => driver.id === selected);
  function updateStatus() {
    if (!tenant || !statusText) return;
    const q = tenant.qq || {};
    statusText.textContent = `运行环境：${q.runtimeState || 'unknown'} · QQ 登录：${q.loginState || 'unknown'} · Agent 通道：${q.agentChannelState || 'unknown'} · ${q.canChat ? '可对话' : '尚不可确认可对话'}`;
    const driver = chosen();
    if (select) select.disabled = busy || switcher.busy;
    if (reason) reason.textContent = driver ? (driver.available ? '' : driver.reason || '此内核当前不可用') : '无法读取允许的内核，请联系管理员。';
    if (login) {
      login.disabled = busy || switcher.busy || !driver?.available || tenant.expiry?.state === 'expired' || !tenant.running;
      login.textContent = q.running ? '继续扫码登录' : '扫码登录 QQ';
    }
  }
  function render() {
    if (!active || !tenant) return;
    const writable = ['owner', 'operator', 'admin'].includes(tenant.role);
    const running = tenant.status === 'running';
    const input = h('input', { class: 'input', id: 'user-qq-uin', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '输入 QQ 号', value: tenant.qq?.expectedUin || tenant.qq?.uin || '' });
    select = h('select', { class: 'input', id: 'user-qq-driver', on: { change: () => { selected = select.value; updateStatus(); } } }, ...drivers.drivers.map((driver) => h('option', { value: driver.id }, driver.label)));
    select.value = selected;
    reason = h('p', { class: 'note' });
    login = h('button', { class: 'btn btn-primary', type: 'button' }, '扫码登录 QQ');
    const toggle = h('button', { class: 'btn btn-soft', type: 'button', disabled: ['starting', 'stopping', 'provisioning'].includes(tenant.status) || (!running && tenant.expiry?.state === 'expired') }, running ? '停止实例' : '启动实例');
    const consoleUrl = safeLink(tenant.consoleUrl);
    const actions = h('div', { class: 'inline-buttons' }, writable ? toggle : null,
      writable && consoleUrl ? h('a', { class: 'btn btn-ghost', href: consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Bot 控制台 ↗') : null,
      h('a', { class: 'btn btn-ghost', href: '#/user/channel', on: { click: () => onSelectTenant?.(tenantId) } }, '渠道配置'));
    statusText = h('p', { class: 'note', 'aria-live': 'polite' });
    const switchButton = h('button', { class: 'btn btn-soft', type: 'button' }, '切换内核');
    const qq = h('section', { class: 'card card-pad' }, h('h2', {}, 'QQ 登录'), statusText,
      writable ? h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'user-qq-driver' }, 'QQ 内核'), select, reason, h('label', { class: 'field-label', for: 'user-qq-uin' }, 'QQ 号'), input, login, switchButton) : h('p', { class: 'note' }, '当前为只读权限。'), switcher.node);
    switchButton.addEventListener('click', () => {
      if (!chosen()?.available || switcher.busy || !tenant.running || tenant.expiry?.state === 'expired') return;
      const uin = input.value.trim();
      if (!/^\d{5,12}$/.test(uin)) { toast?.show?.('请输入有效的 QQ 号。', { tone: 'danger' }); return; }
      void switcher.start({ driver: selected, expectedRevision: tenant.qq.revision, uin });
    });
    clear(content);
    content.appendChild(h('section', { class: 'card card-pad' }, h('h2', {}, tenant.name), badge(tenant.statusLabel, tenant.statusTone), actions));
    content.appendChild(qq);
    updateStatus();
    toggle.addEventListener('click', async () => {
      if (busy || !active) return;
      busy = true; setBusy(toggle, true);
      try { if (running) await api.stopTenant(tenantId); else await api.startTenant(tenantId); if (active) await load(); }
      catch { if (active) toast?.show?.('实例操作失败，请稍后重试。', { tone: 'danger' }); }
      finally { busy = false; if (active) { setBusy(toggle, false); updateStatus(); } }
    });
    login.addEventListener('click', async () => {
      if (busy || switcher.busy || !active || !chosen()?.available || tenant.expiry?.state === 'expired' || !tenant.running) return;
      const uin = input.value.trim();
      if (!/^\d{5,12}$/.test(uin)) { toast?.show?.('请输入有效的 QQ 号。', { tone: 'danger' }); return; }
      const q = tenant.qq || {};
      if (q.kernel !== 'unknown' && q.kernel !== selected) { toast?.show?.('请使用切换内核按钮。', { tone: 'danger' }); return; }
      if (q.running && ((q.kernel !== 'unknown' && q.kernel !== selected) || (q.expectedUin && q.expectedUin !== uin))) {
        toast?.show?.('QQ 正在运行，请先停止后再更改内核或账号。', { tone: 'danger' }); return;
      }
      busy = true; setBusy(login, true); updateStatus();
      try {
        if (!q.running) {
          await api.prepareQQ(tenantId, { kernel: selected, uin });
          if (!active) return;
          await api.startQQ(tenantId, { kernel: selected, uin });
          if (!active) return;
          tenant.qq = normalizeQQStatus(await api.getQQStatus(tenantId));
          if (!active) return;
        }
        qr?.close();
        qr = openQrFlow({ modalRoot, api, tenantId, toast, timers, safeMessages: true, capabilities: chosen().capabilities, runtimeGeneration: tenant.qq.runtimeGeneration, onConfirmed: () => { void statusPoller.refreshNow(); } });
      } catch { if (active) toast?.show?.('QQ 登录准备失败，请联系平台管理员检查配置。', { tone: 'danger' }); }
      finally { busy = false; if (active) { setBusy(login, false); updateStatus(); } }
    });
  }
  async function load() {
    const sequence = ++loadSequence;
    try {
      const [payload, driverPayload, statusPayload] = await Promise.all([api.getTenant(tenantId), api.getQQDrivers(), api.getQQStatus(tenantId)]);
      if (!active || sequence !== loadSequence) return;
      tenant = normalizeTenant(payload);
      tenant.role = String(payload?.role || payload?.tenant?.role || '').toLowerCase();
      tenant.qq = normalizeQQStatus(statusPayload);
      switcher.setWritable(['owner', 'operator', 'admin'].includes(tenant.role));
      void switcher.restore(tenant.qq.activeOperationId || tenant.qq.latestOperationId);
      drivers = normalizeQQDrivers(driverPayload);
      selected = tenant.qq.kernel !== 'unknown' ? tenant.qq.kernel : drivers.defaultDriver;
      render();
      if (!statusPoller.isRunning()) statusPoller.start(); else void statusPoller.refreshNow();
    } catch {
      if (active && sequence === loadSequence) content.replaceChildren(errorBlock({ title: '实例加载失败', message: '无法读取此实例或内核列表，请检查权限或稍后重试。', onRetry: () => { void load(); } }));
    }
  }
  void load();
  return { destroy() { active = false; statusSequence++; statusPoller.stop(); qr?.close(); switcher.destroy(); root.replaceChildren(); }, refresh: load };
}
