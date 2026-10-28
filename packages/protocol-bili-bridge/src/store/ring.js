import { BridgeError } from '../errors.js';
import { VIRTUAL_ID_RANGES } from '../mapping/ids.js';
import { Mutex } from './file-lock.js';

const DEFAULT_CAPACITY = 500;

function emptyState() {
  return { version: 1, counter: 0, messages: [] };
}

/**
 * 最近消息环形缓冲：OneBot 的 get_msg 与引用回复都依赖它。
 * message_id 全部落在安全整数区间，重启后 counter 继续，不会与历史记录冲突。
 */
export class MessageRing {
  constructor({ store, capacity = DEFAULT_CAPACITY, now = Date.now, logger = null }) {
    if (!store) throw new TypeError('MessageRing 需要 JsonStore');
    this.store = store;
    this.capacity = Math.max(10, Number(capacity) || DEFAULT_CAPACITY);
    this.now = now;
    this.logger = logger;
    this.mutex = new Mutex();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    await this.store.load();
    const state = this.store.data;
    if (!state || typeof state !== 'object' || !Array.isArray(state.messages)) {
      this.store.data = emptyState();
    } else {
      state.version = state.version || 1;
      state.counter = Number.isSafeInteger(state.counter) ? state.counter : 0;
      state.messages = state.messages.filter((item) => Number.isSafeInteger(item?.message_id));
    }
    this.loaded = true;
    return this;
  }

  async add({
    channel = 'bili',
    direction = 'in',
    groupId = null,
    userId = null,
    message = [],
    rawMessage = '',
    native = null,
    time = Math.floor(this.now() / 1000),
    extra = null
  } = {}) {
    return this.mutex.run(async () => {
      await this.load();
      let record = null;
      await this.store.update((draft) => {
        const range = VIRTUAL_ID_RANGES.message;
        const counter = Number.isSafeInteger(draft.counter) ? draft.counter : 0;
        const messageId = range.base + (counter % range.size);
        record = {
          message_id: messageId,
          time,
          channel,
          direction,
          group_id: groupId == null ? null : Number(groupId),
          user_id: userId == null ? null : Number(userId),
          message,
          raw_message: rawMessage,
          native,
          extra
        };
        draft.counter = counter + 1;
        draft.messages.push(record);
        if (draft.messages.length > this.capacity) {
          draft.messages.splice(0, draft.messages.length - this.capacity);
        }
      });
      return structuredClone(record);
    });
  }

  get(messageId) {
    const id = Number(messageId);
    if (!Number.isSafeInteger(id)) return null;
    const found = this.store.data.messages.find((item) => item.message_id === id);
    return found ? structuredClone(found) : null;
  }

  recent(limit = 20) {
    const count = Math.max(1, Math.min(this.capacity, Number(limit) || 20));
    return this.store.data.messages.slice(-count).map((item) => structuredClone(item));
  }

  stats() {
    return { count: this.store.data.messages.length, capacity: this.capacity, counter: this.store.data.counter };
  }

  assertSafe() {
    for (const item of this.store.data.messages) {
      if (!Number.isSafeInteger(item.message_id)) {
        throw new BridgeError('消息环形缓冲出现非安全整数 ID', { kind: 'STORAGE', code: 500, retcode: 1500 });
      }
    }
    return true;
  }
}
