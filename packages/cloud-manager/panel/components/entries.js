import { h } from '../lib/dom.js';
import { button, panel } from './common.js';

const LABELS = { qq_protocol: 'QQ 协议机器人', qq_official: 'QQ 官方机器人', desktop: '桌宠', bili: 'B 站' };
const validQr = (value) => typeof value === 'string' && value.length < 2000000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);

export function mountEntries(root, ctx = {}) {
  let active = true, serial = 0, controller = null, pair = null, busy = false;
  const readonly = Boolean(ctx.readOnly);
  const notify = (error) => { if (active && error?.name !== 'AbortError') ctx.toast?.show?.(error?.message || '操作失败', { tone: 'danger' }); };
  async function reload() {
    if (!ctx.api.getEntries || !ctx.api.getBillingEntries || !ctx.api.getDesktopDevices) return;
    controller?.abort(); controller = new AbortController(); const signal = controller.signal, current = ++serial;
    try {
      const [state, billing, devices] = await Promise.all([
        ctx.api.getEntries(ctx.tenantId, { signal }), ctx.api.getBillingEntries(ctx.tenantId, { signal }), ctx.api.getDesktopDevices(ctx.tenantId, { signal })
      ]);
      if (!active || current !== serial) return;
      const entries = state.entries || {}, usage = Array.isArray(billing.entries) ? billing.entries : [];
      const refresh = async (operation) => {
        if (readonly || !active || busy) return;
        busy = true;
        try { await operation(); if (!active) return; ctx.toast?.show?.('操作已完成', { tone: 'success' }); await reload(); } catch (error) { notify(error); } finally { busy = false; }
      };
      const cards = Object.entries(LABELS).map(([key, name]) => {
        const enabled = entries[key]?.enabled === true;
        const meters = usage.find(x => x.entry === key)?.usage || [];
        const rows = meters.length ? meters.map(x => h('li', {}, `${x.meter || '用量'}: ${x.quantity ?? x.total ?? 0} ${x.unit || ''}`)) : [h('li', {}, '本期暂无用量')];
        const actions = [button(enabled ? '停用' : '启用', () => void refresh(() => ctx.api.setEntryEnabled(ctx.tenantId, key, !enabled, { signal })), readonly)];
        if (key === 'qq_protocol' || key === 'qq_official' || key === 'bili') actions.push(button('配置', () => ctx.onConfigure?.(key)));
        return panel(name, h('p', {}, enabled ? '已启用' : '未启用'), h('p', {}, '本期用量'), h('ul', {}, ...rows), h('div', { class: 'inline-buttons' }, ...actions));
      });
      const desktopEnabled = entries.desktop?.enabled === true;
      if (!desktopEnabled || (pair?.expiresAt && Number(pair.expiresAt) <= Date.now())) pair = null;
      const pairing = button('生成配对码', async () => {
        if (readonly || !desktopEnabled || !active || busy) return;
        busy = true;
        try { pair = await ctx.api.createDesktopPairingCode(ctx.tenantId, { signal }); if (active && current === serial) await reload(); } catch (error) { notify(error); } finally { busy = false; }
      }, readonly || !desktopEnabled);
      const list = (devices.devices || []).map(device => h('li', {}, h('span', {}, `${device.name || '未命名设备'} · ${device.os || '未知系统'} · ${device.revokedAt ? '已撤销' : '有效'} · 最近在线 ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '从未'}`),
        button('撤销', () => void refresh(() => ctx.api.revokeDesktopDevice(ctx.tenantId, device.id, { signal })), readonly || Boolean(device.revokedAt))));
      const qr = pair && validQr(pair.qr) ? h('img', { attrs: { src: pair.qr, alt: '桌宠配对二维码' } }) : null;
      root.replaceChildren(panel('接入方式', h('div', { class: 'workspace-grid' }, ...cards)), panel('桌宠设备', h('p', {}, desktopEnabled ? '配对设备后可连接此租户。' : '请先启用桌宠。'), pairing,
        pair ? h('div', {}, h('p', {}, `Host: ${pair.host || ''}`), h('p', {}, `配对码：${pair.code || ''}`), h('p', {}, `有效期至：${pair.expiresAt ? new Date(pair.expiresAt).toLocaleString() : '未知'}`), qr) : null,
        h('ul', {}, ...list)));
    } catch (error) { if (active && current === serial && error?.name !== 'AbortError') root.replaceChildren(panel('接入方式', h('p', {}, error?.message || '读取失败'), button('重试', reload))); }
  }
  void reload();
  return { reload, refresh: reload, destroy() { active = false; serial++; controller?.abort(); pair = null; root.replaceChildren(); } };
}
