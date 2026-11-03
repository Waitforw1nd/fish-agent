import { randomUUID } from 'node:crypto';
import { JsonStore } from '../store/json-store.js';
import { BridgeError } from '../errors.js';

const DAY = 86400000;
const label = '【AI生成】';
const bad = (message) => new BridgeError(message, { kind: 'INPUT', code: 400, retcode: 1400 });
const defaults = () => ({ config: { enabled: false, level: 0, acknowledged: false, keywords: [], activeWindows: ['00:00-23:59'], maxVideosPerDay: 10, maxDraftsPerDay: 3 }, seen: [], journal: [], drafts: [], pendingMeters: [], riskUntil: 0, needsRiskClear: false });
const cut = (v, n) => String(v || '').slice(0, n);

/** Read-only exploration. Draft approval is a local state transition, never a platform action. */
export class ExploreWatcher {
  constructor({ dir, api, video, risk, generate, meter, canRun = () => true, runToken = () => null, now = Date.now }) {
    this.store = new JsonStore({ dir, name: 'explore.json', defaults });
    Object.assign(this, { api, video, risk, generate, meter, canRun, runToken, now });
    this.busy = false;
    this.generation = 0;
    this.unrecordedVisit = false;
  }
  async load() { await this.store.load(); }
  cancelCurrent() { this.generation++; }
  snapshot() {
    const d = this.store.data;
    return { config: d.config, journal: d.journal.slice(-200).reverse(), drafts: d.drafts.map(x => x.status === 'pending' && x.expiresAt <= this.now() ? { ...x, status: 'expired' } : x).slice(-200).reverse(), riskUntil: d.riskUntil, riskBlocked: this.risk.blocked || d.needsRiskClear };
  }
  async configure(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('配置必须是对象');
    await this.store.update(d => {
      const old = d.config;
      const level = patch.level === undefined ? old.level : Number(patch.level);
      if (![0, 1].includes(level)) throw bad('仅支持 L0 和 L1');
      const acknowledged = patch.acknowledged === undefined ? old.acknowledged : patch.acknowledged === true;
      if (level === 1 && !acknowledged) throw bad('启用 L1 前必须确认规则与风险');
      const bounded = (v, fallback, max) => v === undefined ? fallback : Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
      const activeWindows = patch.activeWindows === undefined ? (old.activeWindows || ['00:00-23:59']) : patch.activeWindows;
      if (!Array.isArray(activeWindows) || activeWindows.length > 4 || !activeWindows.every(x => /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(x))) throw bad('Invalid active windows');
      const keywords = patch.keywords === undefined ? old.keywords : (Array.isArray(patch.keywords) ? [...new Set(patch.keywords.map(x => cut(x, 40).trim()).filter(Boolean))].slice(0, 10) : []);
      d.config = { enabled: patch.enabled === undefined ? old.enabled : patch.enabled === true, level, acknowledged, keywords, activeWindows,
        maxVideosPerDay: bounded(patch.maxVideosPerDay, old.maxVideosPerDay, 30), maxDraftsPerDay: bounded(patch.maxDraftsPerDay, old.maxDraftsPerDay, 10) };
      const videos = d.journal.filter(x => x.at > this.now() - DAY).length + (this.unrecordedVisit ? 1 : 0);
      const drafts = d.drafts.filter(x => x.createdAt > this.now() - DAY).length;
      if (!this.mayExplore(d) || (old.level === 1 && (level !== 1 || !acknowledged))
          || old.keywords.some(keyword => !keywords.includes(keyword))
          || videos > d.config.maxVideosPerDay || (this.busy && drafts >= d.config.maxDraftsPerDay)) this.generation++;
    });
    return this.snapshot();
  }
  async pauseRisk() { this.generation++; await this.store.update(d => { d.needsRiskClear = true; d.riskUntil = Math.max(d.riskUntil || 0, this.now() + DAY); }); }
  async clearRisk() { this.generation++; await this.store.update(d => { if (d.needsRiskClear || this.risk.blocked) { d.needsRiskClear = false; d.riskUntil = this.now() + DAY; } }); }
  async review(id, action, text) {
    if (!['edit', 'approve', 'reject'].includes(action)) throw bad('无效操作');
    await this.store.update(d => {
      const item = d.drafts.find(x => x.id === id);
      if (!item || item.status !== 'pending' || item.expiresAt <= this.now()) throw bad('草稿不存在或已过期');
      if (action === 'edit') { const content = cut(text, 120).trim(); if (!content) throw bad('草稿不能为空'); item.text = content.startsWith(label) ? content : label + content; }
      else {
        // Draft creation order differs from review order; retain the latter even
        // when several reviews share a timestamp or old drafts are pruned.
        const history = d.recentReviews || d.drafts
          .filter(x => x.status === 'approved' || x.status === 'rejected')
          .sort((a, b) => (a.reviewedAt || a.createdAt) - (b.reviewedAt || b.createdAt))
          .slice(-3).map(x => x.status);
        item.status = action === 'approve' ? 'approved' : 'rejected';
        item.reviewedAt = this.now();
        d.recentReviews = [...history, item.status].slice(-3);
        if (d.recentReviews.length === 3 && d.recentReviews.every(status => status === 'rejected')) { d.config.level = 0; this.generation++; }
      }
    });
    return this.snapshot();
  }
  async feed(ups, keywords, generation = this.generation) {
    const result = [];
    for (const mid of ups.slice(0, 5)) {
      if (generation !== this.generation || !this.mayExplore(this.store.data)) break;
      const p = await this.api.request({ method: 'GET', service: 'api', path: '/x/space/wbi/arc/search', params: { mid, ps: 5, pn: 1, order: 'pubdate', index: 0, keyword: '' }, signed: true, allowedCodes: [0], retries: 0, shouldContinue: () => generation === this.generation && this.mayExplore(this.store.data) });
      for (const v of p?.data?.list?.vlist || []) result.push({ bvid: v.bvid, aid: String(v.aid || ''), title: cut(v.title, 300), source: 'up' });
    }
    for (const keyword of keywords.slice(0, 3)) {
      if (generation !== this.generation || !this.mayExplore(this.store.data)) break;
      if (!this.store.data.config.keywords.includes(keyword)) continue;
      const p = await this.api.request({ method: 'GET', service: 'api', path: '/x/web-interface/wbi/search/type', params: { search_type: 'video', keyword, page: 1 }, signed: true, allowedCodes: [0], retries: 0, shouldContinue: () => generation === this.generation && this.mayExplore(this.store.data) && this.store.data.config.keywords.includes(keyword) });
      for (const v of (p?.data?.result || []).slice(0, 5)) result.push({ bvid: v.bvid, aid: String(v.aid || ''), title: cut(v.title, 300), source: 'keyword' });
    }
    return result.filter(v => /^BV[0-9A-Za-z]{10}$/.test(v.bvid || '')).slice(0, 30);
  }
  async flushMeters() {
    if (this.meterFlush) return this.meterFlush;
    this.meterFlush = this.flushMetersOnce();
    try { await this.meterFlush; } finally { this.meterFlush = null; }
  }
  async flushMetersOnce() {
    if (!this.meter) return;
    while (this.store.data.pendingMeters?.length) {
      const event = this.store.data.pendingMeters[0];
      try { await this.meter(event); } catch { return; }
      await this.store.update(d => { d.pendingMeters = (d.pendingMeters || []).filter(x => x.idempotencyKey !== event.idempotencyKey); });
    }
  }
  mayExplore(state) {
    if (!this.canRun(this.currentRunToken) || !state.config.enabled || this.risk.blocked || state.needsRiskClear || state.riskUntil > this.now()) return false;
    const clock = new Date(this.now());
    const minute = clock.getHours() * 60 + clock.getMinutes();
    return (state.config.activeWindows || ['00:00-23:59']).some(window => { const [a,b] = window.split('-').map(v => Number(v.slice(0,2)) * 60 + Number(v.slice(3))); return a <= b ? minute >= a && minute <= b : minute >= a || minute <= b; });
  }
  async poll(ups = []) {
    if (this.busy) return;
    this.busy = true;
    this.currentRunToken = this.runToken();
    const generation = this.generation;
    try {
      await this.flushMeters();
      if (generation !== this.generation) return;
      if (this.risk.blocked) { await this.pauseRisk(); return; }
      if (!this.mayExplore(this.store.data)) return;
      const candidates = await this.feed(ups, this.store.data.config.keywords, generation);
      if (generation !== this.generation) return;
      for (const candidate of candidates) {
        const d = this.store.data, cfg = d.config, now = this.now();
        if (generation !== this.generation || !this.mayExplore(d)) break;
        if (d.seen.includes(candidate.bvid) || d.journal.filter(x => x.at > now - DAY).length >= cfg.maxVideosPerDay) continue;
        this.unrecordedVisit = true;
        let viewed = false, context, contextError;
        try {
          context = await this.video.context({ bvid: candidate.bvid, includeSubtitles: true, download: true, maxSubtitleChars: 6000,
            onView: () => { viewed = true; },
            shouldContinue: () => generation === this.generation && this.mayExplore(this.store.data)
              && this.store.data.journal.filter(x => x.at > this.now() - DAY).length + 1 <= this.store.data.config.maxVideosPerDay });
        } catch (error) {
          if (!viewed) throw error;
          // A successful video read is billable even if a later player or
          // subtitle request fails. Persist it before ending this round.
          contextError = error;
          context = { subtitleText: '', subtitle: { reason: 'CANCELLED' } };
        }
        const subtitles = cut(context.subtitleText, 6000);
        let summary = '';
        const withinBrowseLimit = (state, includeCurrent = false) => generation === this.generation && this.mayExplore(state)
          && state.journal.filter(x => x.at > this.now() - DAY).length + (includeCurrent ? 1 : 0) <= state.config.maxVideosPerDay;
        if (subtitles && this.generate && withinBrowseLimit(this.store.data, true)) { try { summary = cut((await this.generate({ video: candidate, subtitles, mode: 'summary' }))?.text, 2000); } catch { summary = ''; } }
        const visitId = randomUUID();
        // The remote read already happened, so always account for it even if
        // settings changed in flight. Do not retain generated content when the
        // current state no longer permits this visit.
        await this.store.update(s => { if (!withinBrowseLimit(s, true)) summary = ''; s.seen.push(candidate.bvid); s.seen = s.seen.slice(-5000); const cancelled = context.subtitle?.reason === 'CANCELLED' || context.subtitle?.downloaded?.error === 'CANCELLED'; s.journal.push({ id: visitId, at: now, video: candidate, summary, subtitleAvailable: cancelled ? null : Boolean(subtitles), evidence: subtitles.slice(0, 1000) }); s.journal = s.journal.slice(-1000); (s.pendingMeters ||= []).push({ meter: 'bili.video.browsed', idempotencyKey: `bili.video.browsed:${visitId}`, quantity: 1, unit: 'count', occurredAt: now }); });
        this.unrecordedVisit = false;
        await this.flushMeters();
        if (contextError) throw contextError;
        const canDraft = s => withinBrowseLimit(s) && s.config.level === 1 && s.config.acknowledged && s.drafts.filter(x => x.createdAt > this.now() - DAY).length < s.config.maxDraftsPerDay;
        if (subtitles && this.generate && canDraft(this.store.data)) {
          let text = '';
          try { text = cut((await this.generate({ video: candidate, subtitles, mode: 'draft' }))?.text, 120).trim(); } catch { /* Keep the diary when generation fails. */ }
          if (text) {
            const id = randomUUID();
            await this.store.update(s => { if (!canDraft(s)) return; const createdAt = this.now(); s.drafts.push({ id, video: candidate, evidence: subtitles.slice(0, 1000), text: text.startsWith(label) ? text : label + text, status: 'pending', createdAt, expiresAt: createdAt + DAY }); s.drafts = s.drafts.slice(-1000); (s.pendingMeters ||= []).push({ meter: 'bili.comment.drafted', idempotencyKey: `bili.comment.drafted:${id}`, quantity: 1, unit: 'count', occurredAt: createdAt }); });
            await this.flushMeters();
          }
        }
      }
    } finally {
      try { if (this.risk.blocked && !this.store.data.needsRiskClear) await this.pauseRisk(); }
      finally { this.unrecordedVisit = false; this.currentRunToken = undefined; this.busy = false; }
    }
  }
}
