import { h } from '../lib/dom.js';
import { button, checkbox, entries, field, input, lines, panel, textarea } from './common.js';

export function mountBiliExplore(root, ctx = {}) {
  let active = true, controller = null, serial = 0;
  async function reload() {
    controller?.abort(); controller = new AbortController(); const signal = controller.signal, current = ++serial;
    try {
      const state = (await ctx.api.getBiliExplore(ctx.tenantId, { signal })).explore;
      if (!active || current !== serial) return;
      const cfg = state.config, disabled = !!ctx.readOnly;
      const enabled = checkbox('启用浏览', cfg.enabled, disabled);
      const ack = checkbox('我已阅读 B 站规则与风险提示', cfg.acknowledged, disabled);
      const level = h('select', { class: 'input', disabled }, h('option', { value: '0', selected: cfg.level === 0 }, 'L0 浏览日记'), h('option', { value: '1', selected: cfg.level === 1 }, 'L1 审核草稿'));
      const windows = textarea(lines(cfg.activeWindows || ['00:00-23:59']), { disabled });
      const keywords = textarea(lines(cfg.keywords), { disabled });
      const maxVideos = input(cfg.maxVideosPerDay, { type: 'number', min: 0, max: 30, disabled });
      const maxDrafts = input(cfg.maxDraftsPerDay, { type: 'number', min: 0, max: 10, disabled });
      const action = async (fn) => { if (disabled || !active) return; try { await fn(); if (!active || current !== serial) return; ctx.toast?.show?.('已保存', { tone: 'success' }); await reload(); } catch (error) { if (active && error?.name !== 'AbortError') ctx.toast?.show?.(error?.message || '操作失败', { tone: 'danger' }); } };
      const save = button('保存', () => void action(() => ctx.api.updateBiliExplore(ctx.tenantId, { enabled: enabled.control.checked, acknowledged: ack.control.checked, level: Number(level.value), keywords: entries(keywords.value), activeWindows: entries(windows.value), maxVideosPerDay: Number(maxVideos.value), maxDraftsPerDay: Number(maxDrafts.value) }, { signal })), disabled);
      const drafts = (state.drafts || []).map(d => {
        const text = textarea(d.text, { disabled: disabled || d.status !== 'pending' });
        const act = (op) => () => void action(() => ctx.api.reviewBiliDraft(ctx.tenantId, d.id, op, text.value, { signal }));
        return h('article', {}, h('strong', {}, d.video.title || d.video.bvid), h('p', {}, `${d.status} · 过期 ${new Date(d.expiresAt).toLocaleString()}`), d.evidence ? h('p', {}, `字幕依据：${d.evidence}`) : null, text, button('保存修改', act('edit'), disabled || d.status !== 'pending'), button('批准', act('approve'), disabled || d.status !== 'pending'), button('拒绝', act('reject'), disabled || d.status !== 'pending'));
      });
      const journal = (state.journal || []).map(j => h('article', {}, h('strong', {}, j.video.title || j.video.bvid), h('p', {}, j.summary || (j.subtitleAvailable === null ? '字幕读取已停止，仅记录视频' : j.subtitleAvailable ? '摘要不可用' : '无字幕，仅记录视频')), j.evidence ? h('p', {}, `字幕依据：${j.evidence}`) : null));
      const clear = button('已完成验证，清除风控', () => void action(() => ctx.api.clearBiliExploreRisk(ctx.tenantId, { signal })), disabled || !state.riskBlocked);
      root.replaceChildren(panel('B 站探索', h('p', {}, '自动化访问可能受平台规则限制。L0 记录浏览日记；L1 生成供审核的草稿。批准只改变草稿状态，不会发送评论。'), enabled.node, ack.node, field('级别', level), field('搜索关键词', keywords), field('活动时段（主机本地时间，HH:MM-HH:MM）', windows), field('最近 24 小时视频上限', maxVideos), field('最近 24 小时草稿上限', maxDrafts), save, h('p', {}, state.riskBlocked ? '风控中' : state.riskUntil > Date.now() ? `冷却至 ${new Date(state.riskUntil).toLocaleString()}` : '无风控冷却'), clear), panel('待审草稿', ...drafts), panel('浏览日记', ...journal));
    } catch (error) { if (active && current === serial && error?.name !== 'AbortError') root.replaceChildren(panel('B 站探索', h('p', {}, error.message || '读取失败'), button('重试', reload))); }
  }
  void reload();
  return { reload, refresh: reload, destroy() { active = false; serial++; controller?.abort(); root.replaceChildren(); } };
}
