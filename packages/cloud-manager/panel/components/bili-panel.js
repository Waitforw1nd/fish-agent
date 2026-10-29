import { h } from '../lib/dom.js';
import { normalizeBiliConfig, normalizeBiliStatus } from '../lib/normalize.js';
import { openQrFlow } from '../views/qr.js';
import { button, checkbox, entries, field, lines, optionalCall, panel, perform, textarea } from './common.js';

export function mountBiliPanel(root, ctx = {}) {
  let active = true, qr = null, serial = 0, dirty = false;
  const readOnly = !!ctx.readOnly;
  async function reload() {
    const current = ++serial;
    try {
      const [rawConfig, rawStatus] = await Promise.all([
        optionalCall(ctx.api, 'getBiliConfig', ctx.tenantId), optionalCall(ctx.api, 'getBiliStatus', ctx.tenantId)
      ]);
      if (!active || current !== serial) return;
      if (!rawConfig && !rawStatus) { root.replaceChildren(panel('B 站桥接', h('p', { class: 'note' }, '当前服务未提供 B 站配置接口。'))); return; }
      const source = rawConfig?.config || rawConfig || {};
      const normalized = normalizeBiliConfig(rawConfig);
      const status = normalizeBiliStatus(rawStatus);
      const switches = {};
      const nodes = [['mentions', '@提及'], ['upVideos', 'UP 主视频'], ['privateMessages', '私信'], ['liveRooms', '直播间']].map(([key, label]) => {
        const choice = checkbox(label, normalized.subscriptions[key], readOnly);
        switches[key] = choice.control;
        return choice.node;
      });
      const upMids = textarea(lines(source.upMids), { disabled: readOnly });
      const videos = textarea(lines(source.videos), { disabled: readOnly });
      const liveRoomIds = textarea(lines(source.liveRoomIds), { disabled: readOnly });
      const save = button('保存 B 站配置', async () => {
        const result = await perform(ctx, () => ctx.api.updateBiliConfig(ctx.tenantId, {
          subscriptions: Object.fromEntries(Object.entries(switches).map(([key, control]) => [key, control.checked])),
          upMids: entries(upMids.value), videos: entries(videos.value), liveRoomIds: entries(liveRoomIds.value)
        }));
        if (result !== undefined) { dirty = false; void reload(); }
      }, readOnly, 'primary');
      const body = panel('B 站桥接', h('p', { class: 'note' }, `登录状态：${status.phaseLabel || '未知'} · Cookie：${status.cookieStatus || '未知'}`),
        h('div', { class: 'inline-buttons' },
          button('扫码绑定', () => {
            qr?.close();
            qr = openQrFlow({ modalRoot: ctx.modalRoot || document.getElementById('modal-root') || document.body, api: ctx.api, tenantId: ctx.tenantId, kind: 'bili', toast: ctx.toast, timers: ctx.timers, onConfirmed: () => { void reload(); } });
          }, readOnly),
          button('启动桥接', async () => { if (await perform(ctx, () => ctx.api.startBili(ctx.tenantId)) !== undefined) void reload(); }, readOnly),
          button('停止桥接', async () => { if (await perform(ctx, () => ctx.api.stopBili(ctx.tenantId)) !== undefined) void reload(); }, readOnly),
          button('退出 B 站', async () => { if (await perform(ctx, () => ctx.api.logoutBili(ctx.tenantId)) !== undefined) void reload(); }, readOnly)),
        ...nodes, field('监控 UP 主 MID', upMids), field('监控视频 BV / av', videos), field('监控直播间 ID', liveRoomIds), save);
      for (const event of ['input', 'change']) body.addEventListener(event, () => { dirty = true; });
      root.replaceChildren(body);
      dirty = false;
    } catch (error) {
      if (active && current === serial) root.replaceChildren(panel('B 站桥接', h('p', { class: 'note' }, error?.message || '无法读取 B 站配置。'), button('重试', reload)));
    }
  }
  void reload();
  return { reload, refresh: reload, hasUnsavedChanges: () => dirty,
    canLeave: () => !dirty || !globalThis.confirm || globalThis.confirm('B 站配置尚未保存，确定离开吗？'),
    destroy() { active = false; serial++; qr?.close(); root.replaceChildren(); } };
}
