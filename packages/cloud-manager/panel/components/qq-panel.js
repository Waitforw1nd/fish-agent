import { h, setBusy } from '../lib/dom.js';
import { normalizeTenant, normalizeQQStatus, normalizeQQDrivers } from '../lib/normalize.js';
import { createPoller } from '../lib/polling.js';
import { openQrFlow } from '../views/qr.js';
import { createSwitchController } from '../views/qq-switch.js';
import { button, field, input, panel, perform } from './common.js';

export function mountQQPanel(root, ctx = {}) {
  const { api, tenantId, toast, modalRoot, timers, visibility } = ctx;
  let active = true, qr = null, busy = false, serial = 0, tenant = ctx.tenant || null;
  let drivers = { defaultDriver: '', drivers: [] }, selected = '', statusNode, driverSelect, login, reason, switchButton;
  const switcher = createSwitchController({ api, tenantId, modalRoot, toast, timers, onChange: updateStatus });
  const poller = createPoller({ intervalMs: 5000, timers, visibility, task: async () => {
    const value = await api.getQQStatus(tenantId);
    if (!active || !tenant) return;
    tenant.qq = normalizeQQStatus(value);
    void switcher.restore(tenant.qq.activeOperationId || tenant.qq.latestOperationId);
    updateStatus();
  } });
  const writable = () => !ctx.readOnly && (ctx.admin || ctx.mode === 'admin' || ['owner', 'operator', 'admin'].includes(tenant?.role));
  const chosen = () => drivers.drivers.find((driver) => driver.id === selected);
  function updateStatus() {
    if (!active || !tenant || !statusNode) return;
    const qq = tenant.qq || {};
    statusNode.textContent = `运行环境：${qq.runtimeState || 'unknown'} · QQ 登录：${qq.loginState || 'unknown'} · Agent 通道：${qq.agentChannelState || 'unknown'} · ${qq.canChat ? '可对话' : '尚不可确认可对话'}`;
    const driver = chosen();
    if (driverSelect) driverSelect.disabled = !writable() || busy || switcher.busy;
    if (reason) reason.textContent = driver ? (driver.available ? '' : driver.reason || '此内核当前不可用') : '无法读取允许的内核，请联系管理员。';
    if (login) {
      login.disabled = !writable() || busy || switcher.busy || !driver?.available || tenant.expiry?.state === 'expired' || !tenant.running;
      login.textContent = qq.running ? '继续扫码登录' : '扫码登录 QQ';
    }
    if (switchButton) switchButton.disabled = !writable() || busy || switcher.busy || !driver?.available || !tenant.running;
  }
  function render() {
    if (!active || !tenant) return;
    const qq = tenant.qq || {};
    const uin = input(qq.expectedUin || qq.uin || '', { id: 'user-qq-uin', inputMode: 'numeric', placeholder: '输入 QQ 号', disabled: !writable() });
    driverSelect = h('select', { class: 'select', id: 'user-qq-driver', disabled: !writable(), on: { change: () => { selected = driverSelect.value; updateStatus(); } } },
      ...drivers.drivers.map((driver) => h('option', { value: driver.id }, driver.label)));
    driverSelect.value = selected;
    reason = h('p', { class: 'note' });
    statusNode = h('p', { class: 'note', 'aria-live': 'polite' });
    login = button('扫码登录 QQ', async () => {
      if (!active || !writable() || busy || switcher.busy || !chosen()?.available || tenant.expiry?.state === 'expired' || !tenant.running) return;
      const account = uin.value.trim();
      if (!/^\d{5,12}$/.test(account)) { toast?.show?.('请输入有效的 QQ 号。', { tone: 'danger' }); return; }
      const q = tenant.qq || {};
      if (q.kernel !== 'unknown' && q.kernel !== selected) { toast?.show?.('请使用切换内核按钮。', { tone: 'danger' }); return; }
      if (q.running && q.expectedUin && q.expectedUin !== account) { toast?.show?.('QQ 正在运行，请先停止后再更改账号。', { tone: 'danger' }); return; }
      busy = true; setBusy(login, true); updateStatus();
      try {
        if (!q.running) {
          await api.prepareQQ(tenantId, { kernel: selected, uin: account });
          if (!active) return;
          await api.startQQ(tenantId, { kernel: selected, uin: account });
          if (!active) return;
          tenant.qq = normalizeQQStatus(await api.getQQStatus(tenantId));
          if (!active) return;
        }
        qr?.close();
        qr = openQrFlow({ modalRoot, api, tenantId, toast, timers, safeMessages: ctx.mode !== 'admin', capabilities: chosen().capabilities, runtimeGeneration: tenant.qq.runtimeGeneration, onConfirmed: () => { void poller.refreshNow(); } });
      } catch (error) { if (active) toast?.show?.(error?.message || 'QQ 登录准备失败。', { tone: 'danger' }); }
      finally { busy = false; if (active) { setBusy(login, false); updateStatus(); } }
    }, !writable(), 'primary');
    switchButton = button('切换内核', () => {
      if (!active || !writable() || !chosen()?.available || switcher.busy || !tenant.running || tenant.expiry?.state === 'expired') return;
      const account = uin.value.trim();
      if (!/^\d{5,12}$/.test(account)) { toast?.show?.('请输入有效的 QQ 号。', { tone: 'danger' }); return; }
      void switcher.start({ driver: selected, expectedRevision: tenant.qq.revision, uin: account });
    }, !writable());
    const advanced = ctx.admin || ctx.mode === 'admin' ? h('div', { class: 'workspace-stack' }) : null;
    if (advanced) {
      const mode = input('', { placeholder: 'direct 或 desktop', disabled: !writable() });
      const port = input('', { type: 'number', placeholder: 'PMHQ 端口（可选）', disabled: !writable() });
      const token = input('', { type: 'password', placeholder: '不回显，留空保留', disabled: !writable() });
      advanced.append(field('LLBot 模式', mode), field('PMHQ 端口', port), field('实例 Auth Token', token),
        button('准备高级配置', async () => { await perform(ctx, () => api.prepareQQAdvanced(tenantId, { kernel: selected, uin: uin.value.trim(), mode: mode.value.trim(), pmhqPort: port.value ? Number(port.value) : undefined })); }, !writable()),
        button('设置 Auth Token', async () => { if (!token.value) return; if (await perform(ctx, () => api.setQQAuthToken(tenantId, token.value)) !== undefined) token.value = ''; }, !writable()),
        button('清除 Auth Token', async () => { await perform(ctx, () => api.clearQQAuthToken(tenantId)); }, !writable()));
    }
    const driverControls = h('div', { class: 'workspace-stack' }, field('QQ 内核', driverSelect), reason, switchButton, advanced);
    const driverDetails = ctx.admin || ctx.mode === 'admin' ? driverControls
      : h('details', { class: 'workspace-details' }, h('summary', {}, '高级：切换 QQ 内核'), driverControls);
    root.replaceChildren(panel('QQ 登录', statusNode, writable()
      ? h('div', { class: 'workspace-stack' }, field('QQ 号', uin), login, driverDetails)
      : h('p', { class: 'note' }, '当前为只读权限。'), switcher.node));
    updateStatus();
  }
  async function reload() {
    const current = ++serial;
    try {
      const [tenantPayload, driverPayload, statusPayload] = await Promise.all([
        ctx.tenant ? Promise.resolve(ctx.tenant) : api.getTenant(tenantId),
        api.getQQDrivers(), api.getQQStatus(tenantId)
      ]);
      if (!active || current !== serial) return;
      tenant = normalizeTenant(tenantPayload);
      tenant.role = String(tenantPayload?.role || tenantPayload?.tenant?.role || ctx.tenant?.role || (ctx.admin ? 'admin' : '')).toLowerCase();
      tenant.qq = normalizeQQStatus(statusPayload);
      switcher.setWritable(writable());
      void switcher.restore(tenant.qq.activeOperationId || tenant.qq.latestOperationId);
      drivers = normalizeQQDrivers(driverPayload);
      selected = tenant.qq.kernel !== 'unknown' ? tenant.qq.kernel : drivers.defaultDriver;
      render();
      if (!poller.isRunning()) poller.start(); else void poller.refreshNow();
    } catch (error) {
      if (active && current === serial) root.replaceChildren(panel('QQ 登录', h('p', { class: 'note' }, error?.message || '无法读取 QQ 配置。'), button('重试', reload)));
    }
  }
  void reload();
  return { reload, refresh: reload, hasUnsavedChanges: () => false, canLeave: () => true,
    destroy() { active = false; serial++; poller.stop(); qr?.close(); switcher.destroy(); root.replaceChildren(); } };
}
