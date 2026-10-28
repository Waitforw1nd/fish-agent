import { Mutex } from './file-lock.js';

const MAX_KEY_LEN = 200;
const DEFAULT_CAPACITY = 5000;
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

function emptyState() {
  return { version: 1, cursors: {}, seen: {} };
}

/**
 * 轮询游标 + 去重集合，共用一份原子 JSON。
 * claimMany 在互斥锁内“检查并占用”，避免 msgfeed/视频评论两个 watcher 重复发同一条事件。
 */
export class PollState {
  constructor({ store, now = Date.now, capacity = DEFAULT_CAPACITY, ttlMs = DEFAULT_TTL, logger = null }) {
    if (!store) throw new TypeError('PollState 需要 JsonStore');
    this.store = store;
    this.now = now;
    this.capacity = Math.max(100, Number(capacity) || DEFAULT_CAPACITY);
    this.ttlMs = Math.max(60_000, Number(ttlMs) || DEFAULT_TTL);
    this.logger = logger;
    this.mutex = new Mutex();
    this.inflight = new Set();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    await this.store.load();
    const state = this.store.data;
    if (!state || typeof state !== 'object' || typeof state.seen !== 'object' || state.seen === null) {
      this.store.data = emptyState();
    } else {
      state.version = state.version || 1;
      if (!state.cursors || typeof state.cursors !== 'object') state.cursors = {};
      this.#pruneState(state);
    }
    this.loaded = true;
    return this;
  }

  #pruneState(state) {
    const cutoff = this.now() - this.ttlMs;
    const entries = Object.entries(state.seen)
      .filter(([key, at]) => key.length <= MAX_KEY_LEN * 2 && Number(at) >= cutoff)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const keep = entries.slice(-this.capacity);
    state.seen = Object.fromEntries(keep);
    return state;
  }

  getCursor(key, fallback = null) {
    const value = this.store.data.cursors?.[String(key)];
    return value === undefined ? fallback : structuredClone(value);
  }

  async setCursor(key, value) {
    return this.mutex.run(async () => {
      await this.load();
      await this.store.update((draft) => {
        if (!draft.cursors) draft.cursors = {};
        draft.cursors[String(key)] = value;
      });
      return value;
    });
  }

  hasSeen(scope, key) {
    const full = `${scope}:${String(key)}`.slice(0, MAX_KEY_LEN * 2);
    return Object.hasOwn(this.store.data.seen || {}, full);
  }

  async deliverOnce(scope, key, deliver) {
    const full = `${scope}:${String(key)}`.slice(0, MAX_KEY_LEN * 2);
    if (this.inflight.has(full) || this.hasSeen(scope, key)) return false;
    this.inflight.add(full);
    try {
      await deliver();
      await this.claim(scope, key);
      return true;
    } finally {
      this.inflight.delete(full);
    }
  }

  /** 返回本次真正新增（未见过）的 key；写入一次磁盘。 */
  async claimMany(scope, keys) {
    const list = (Array.isArray(keys) ? keys : [keys])
      .filter((key) => key !== undefined && key !== null && String(key) !== '')
      .map((key) => String(key));
    if (!list.length) return [];
    return this.mutex.run(async () => {
      await this.load();
      const prefix = `${scope}:`;
      const now = this.now();
      const preview = [];
      const seen = this.store.data.seen || {};
      for (const key of list) {
        const full = `${prefix}${key}`.slice(0, MAX_KEY_LEN * 2);
        if (!Object.hasOwn(seen, full)) preview.push(key);
      }
      if (!preview.length) return [];
      const fresh = [];
      await this.store.update((draft) => {
        for (const key of preview) {
          const full = `${prefix}${key}`.slice(0, MAX_KEY_LEN * 2);
          if (Object.hasOwn(draft.seen, full)) continue;
          draft.seen[full] = now;
          fresh.push(key);
        }
        this.#pruneState(draft);
      });
      return fresh;
    });
  }

  async claim(scope, key) {
    const fresh = await this.claimMany(scope, [key]);
    return fresh.length > 0;
  }

  async forget(scope, key) {
    return this.mutex.run(async () => {
      await this.load();
      const full = `${scope}:${String(key)}`.slice(0, MAX_KEY_LEN * 2);
      if (!Object.hasOwn(this.store.data.seen, full)) return false;
      await this.store.update((draft) => { delete draft.seen[full]; });
      return true;
    });
  }

  snapshot() {
    return {
      cursors: Object.keys(this.store.data.cursors || {}).length,
      seen: Object.keys(this.store.data.seen || {}).length,
      capacity: this.capacity,
      ttlMs: this.ttlMs
    };
  }

  cursorSnapshot() {
    return structuredClone(this.store.data.cursors || {});
  }
}
