export class BiliContextCache {
  constructor({ now = Date.now, timeoutMs = 8000, ttlMs = 600000, maxEntries = 100 } = {}) {
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.cache = new Map();
  }

  async forWake({ onebot, kind, chatId, chatName = '', triggerEntries = [] }) {
    if (kind !== 'group' || onebot?.platformFor?.(kind, chatId) !== 'bili'
      || Number(chatId) < 2 ** 52 || Number(chatId) >= 2 ** 52 + 2 ** 49 || typeof onebot.call !== 'function') return '';
    const bvid = `${chatName} ${triggerEntries.map((entry) => entry.text || '').join(' ')}`.match(/BV[0-9A-Za-z]{10}/)?.[0];
    const key = bvid || `group:${chatId}`;
    try {
      let cached = this.cache.get(key);
      if (!cached || this.now() - cached.at > this.ttlMs) {
        let timer;
        const value = await Promise.race([
          onebot.call('bili_get_video_context', { bvid, group_id: chatId, includeSubtitles: true, includeComments: false }, this.timeoutMs),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('视频上下文超时')), this.timeoutMs); })
        ]).finally(() => clearTimeout(timer));
        if (!value || value.ok === false) throw new Error(value?.error || '视频上下文不可用');
        cached = { at: this.now(), text: JSON.stringify({ title: String(value.title || '').slice(0, 300), subtitle: { available: value.subtitle?.available ?? null, reason: value.subtitle?.reason || null, wording: String(value.subtitle?.wording || '').slice(0, 200) }, desc: String(value.desc || '').slice(0, 800), subtitleText: String(value.subtitleText || '').slice(0, 2400) }).slice(0, 4000) };
        this.cache.set(key, cached);
        if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return `\n\n【B站视频上下文】\n${cached.text}`;
    } catch (error) {
      return `\n\n【B站视频上下文不可用】${String(error?.message || error).slice(0, 120)}；请勿猜测视频内容。`;
    }
  }
}
