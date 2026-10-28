import { BridgeError } from '../errors.js';
import { hashToOffset, isSafeInt, toSafeNumber } from '../util.js';
import { Mutex } from '../store/file-lock.js';

// QQ-agent ChannelRouter 将 B 站固定到 [2^52, 2^53-1]：
//   QQ 号/群号远达不到该量级，且 MAX_SAFE_INTEGER 内 Number(id) 精确无损。
// 五个子号段各占 2^49，互不重叠，且全部落在 ChannelRouter 的 B 站段内。
export const BILI_VIRTUAL_ID_START = 2 ** 52; // 4_503_599_627_370_496
export const BILI_VIRTUAL_ID_END = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
export const RANGE_SIZE = 2 ** 49; // 562_949_953_421_312

export const VIRTUAL_ID_RANGES = Object.freeze({
  video: Object.freeze({ base: BILI_VIRTUAL_ID_START, size: RANGE_SIZE }),
  dynamic: Object.freeze({ base: BILI_VIRTUAL_ID_START + RANGE_SIZE, size: RANGE_SIZE }),
  live: Object.freeze({ base: BILI_VIRTUAL_ID_START + 2 * RANGE_SIZE, size: RANGE_SIZE }),
  user: Object.freeze({ base: BILI_VIRTUAL_ID_START + 3 * RANGE_SIZE, size: RANGE_SIZE }),
  message: Object.freeze({ base: BILI_VIRTUAL_ID_START + 4 * RANGE_SIZE, size: RANGE_SIZE })
});

export function isBiliVirtualId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= BILI_VIRTUAL_ID_START && id <= BILI_VIRTUAL_ID_END;
}

export const GROUP_KINDS = Object.freeze(['video', 'dynamic', 'live']);

function emptyState(tenantId) {
  return {
    version: 1,
    tenantId,
    groups: {},
    users: {},
    nativeGroups: {},
    nativeUsers: {}
  };
}

function normalizeState(state, tenantId) {
  if (!state || typeof state !== 'object') return emptyState(tenantId);
  if (state.tenantId && state.tenantId !== tenantId) {
    throw new BridgeError('虚拟 ID 映射属于其他租户，拒绝加载', {
      kind: 'TENANT', code: 403, retcode: 1403, wording: '租户映射文件不匹配'
    });
  }
  const next = {
    ...emptyState(tenantId),
    ...state,
    tenantId
  };
  for (const field of ['groups', 'users', 'nativeGroups', 'nativeUsers']) {
    if (!next[field] || typeof next[field] !== 'object' || Array.isArray(next[field])) next[field] = {};
  }
  return next;
}

/**
 * 持久化数字虚拟 ID：所有对外 ID 都位于 [2^52, 2^53-1]，且在同一租户内可逆。
 * 原生字符串 ID（BVID、超精度 rpid）只出现在记录内部，绝不直接暴露给 OneBot。
 */
export class VirtualIdMapper {
  constructor({ store, tenantId = 'default', logger = null, now = Date.now }) {
    if (!store) throw new TypeError('VirtualIdMapper 需要 JsonStore');
    this.store = store;
    this.tenantId = String(tenantId || 'default');
    this.logger = logger;
    this.now = now;
    this.mutex = new Mutex();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    await this.store.load();
    this.store.data = normalizeState(this.store.data, this.tenantId);
    this.#assertState();
    this.loaded = true;
    return this;
  }

  #assertState() {
    const state = this.store.data;
    for (const [id, record] of Object.entries(state.groups)) {
      if (!isSafeInt(Number(id)) || !isBiliVirtualId(record?.id)) {
        throw new BridgeError('虚拟群 ID 不在 B 站 [2^52, 2^53-1] 号段内，请清理旧映射后重新扫码', {
          kind: 'STORAGE', code: 500, retcode: 1500, wording: 'B 站映射号段已升级，请删除旧映射数据后重启'
        });
      }
    }
    for (const [id, record] of Object.entries(state.users)) {
      if (!isSafeInt(Number(id)) || !isBiliVirtualId(record?.id)) {
        throw new BridgeError('虚拟用户 ID 不在 B 站 [2^52, 2^53-1] 号段内，请清理旧映射后重新扫码', {
          kind: 'STORAGE', code: 500, retcode: 1500, wording: 'B 站映射号段已升级，请删除旧映射数据后重启'
        });
      }
    }
  }

  #config(kind) {
    const config = VIRTUAL_ID_RANGES[kind];
    if (!config || kind === 'message') throw new BridgeError(`不支持的映射类型: ${kind}`, { kind: 'INPUT', code: 400 });
    return config;
  }

  #nativeKey(kind, native) {
    if (kind === 'video') {
      if (native?.bvid) return `bvid:${native.bvid}`;
      if (native?.aid) return `aid:${native.aid}`;
    } else if (kind === 'dynamic') {
      if (native?.dynamicId) return `dynamic:${native.dynamicId}`;
    } else if (kind === 'live') {
      if (native?.roomId) return `room:${native.roomId}`;
    } else if (kind === 'user') {
      if (native?.mid) return `mid:${native.mid}`;
    }
    throw new BridgeError('缺少映射所需的原生 ID', { kind: 'INPUT', code: 400, retcode: 1400 });
  }

  #lookup(state, kind, native) {
    const table = kind === 'user' ? state.nativeUsers : state.nativeGroups;
    const records = kind === 'user' ? state.users : state.groups;
    const keys = [];
    if (kind === 'video') {
      if (native?.bvid) keys.push(`bvid:${native.bvid}`);
      if (native?.aid) keys.push(`aid:${native.aid}`);
    } else {
      keys.push(this.#nativeKey(kind, native));
    }
    for (const key of keys) {
      const id = table[key];
      if (id != null && records[id]) return records[id];
    }
    return null;
  }

  #allocate(state, kind, native, meta) {
    const table = kind === 'user' ? state.nativeUsers : state.nativeGroups;
    const records = kind === 'user' ? state.users : state.groups;
    const config = this.#config(kind);
    const key = this.#nativeKey(kind, native);
    let offset = hashToOffset(`${this.tenantId}:${kind}:${key}`, config.size);
    for (let probe = 0; probe < config.size; probe += 1) {
      const id = config.base + ((offset + probe) % config.size);
      if (!records[id]) {
        const record = {
          id,
          kind,
          nativeKey: key,
          native: { ...native },
          title: meta?.title || '',
          name: meta?.name || '',
          cover: meta?.cover || '',
          ownerMid: meta?.ownerMid ? String(meta.ownerMid) : '',
          createdAt: this.now(),
          updatedAt: this.now()
        };
        records[id] = record;
        table[key] = id;
        if (kind === 'video') {
          if (native?.bvid) table[`bvid:${native.bvid}`] = id;
          if (native?.aid) table[`aid:${native.aid}`] = id;
        }
        if (kind === 'user' && meta?.name) table[`name:${meta.name}`] = id;
        return record;
      }
    }
    throw new BridgeError('虚拟 ID 空间已耗尽', { kind: 'MAPPING', code: 507, retcode: 1507 });
  }

  async #ensure(kind, native, meta) {
    return this.mutex.run(async () => {
      await this.load();
      const state = this.store.data;
      const existing = this.#lookup(state, kind, native);
      if (existing) {
        let changed = false;
        if (meta?.title && meta.title !== existing.title) { existing.title = meta.title; changed = true; }
        if (meta?.name && meta.name !== existing.name) { existing.name = meta.name; changed = true; }
        if (meta?.cover && meta.cover !== existing.cover) { existing.cover = meta.cover; changed = true; }
        if (meta?.ownerMid && String(meta.ownerMid) !== existing.ownerMid) { existing.ownerMid = String(meta.ownerMid); changed = true; }
        if (kind === 'video') {
          if (native?.bvid && native.bvid !== existing.native?.bvid) {
            existing.native = { ...existing.native, bvid: native.bvid };
            state.nativeGroups[`bvid:${native.bvid}`] = existing.id;
            changed = true;
          }
          if (native?.aid && String(native.aid) !== String(existing.native?.aid)) {
            existing.native = { ...existing.native, aid: native.aid };
            state.nativeGroups[`aid:${native.aid}`] = existing.id;
            changed = true;
          }
        }
        if (kind === 'user' && meta?.name) {
          state.nativeUsers[`name:${meta.name}`] = existing.id;
        }
        if (changed) {
          existing.updatedAt = this.now();
          await this.store.save();
        }
        return { ...existing, native: { ...existing.native } };
      }
      let record = null;
      await this.store.update((draft) => {
        record = this.#allocate(draft, kind, native, meta);
      });
      this.logger?.debug?.('分配虚拟 ID', { kind, id: record.id, nativeKey: record.nativeKey });
      return { ...record, native: { ...record.native } };
    });
  }

  groupForVideo({ bvid, aid, title = '', cover = '', ownerMid = '' } = {}) {
    return this.#ensure('video', { bvid: bvid ? String(bvid) : '', aid: aid ? String(aid) : '' }, { title, cover, ownerMid });
  }

  groupForDynamic({ dynamicId, title = '', cover = '', ownerMid = '' } = {}) {
    return this.#ensure('dynamic', { dynamicId: String(dynamicId) }, { title, cover, ownerMid });
  }

  groupForLive({ roomId, title = '', cover = '', ownerMid = '' } = {}) {
    return this.#ensure('live', { roomId: String(roomId) }, { title, cover, ownerMid });
  }

  userFor({ mid, name = '', avatar = '' } = {}) {
    return this.#ensure('user', { mid: String(mid) }, { name, avatar });
  }

  resolveGroup(id) {
    const numeric = toSafeNumber(id);
    if (numeric == null) return null;
    const record = this.store.data.groups?.[numeric];
    return record ? { ...record, native: { ...record.native } } : null;
  }

  resolveUser(id) {
    const numeric = toSafeNumber(id);
    if (numeric == null) return null;
    const record = this.store.data.users?.[numeric];
    return record ? { ...record, native: { ...record.native } } : null;
  }

  resolveGroupByNative(kind, native) {
    const record = this.#lookup(this.store.data, kind, native);
    return record ? { ...record, native: { ...record.native } } : null;
  }

  groups() {
    return Object.values(this.store.data.groups || {}).map((record) => ({ ...record, native: { ...record.native } }));
  }

  users() {
    return Object.values(this.store.data.users || {}).map((record) => ({ ...record, native: { ...record.native } }));
  }

  async updateGroupMeta(id, meta = {}) {
    const numeric = toSafeNumber(id);
    if (numeric == null) return null;
    return this.mutex.run(async () => {
      await this.load();
      const record = this.store.data.groups?.[numeric];
      if (!record) return null;
      let changed = false;
      for (const field of ['title', 'cover', 'ownerMid']) {
        if (meta[field] != null && String(meta[field]) !== String(record[field] ?? '')) {
          record[field] = String(meta[field]);
          changed = true;
        }
      }
      if (changed) {
        record.updatedAt = this.now();
        await this.store.save();
      }
      return { ...record, native: { ...record.native } };
    });
  }

  stats() {
    return {
      groups: Object.keys(this.store.data.groups || {}).length,
      users: Object.keys(this.store.data.users || {}).length
    };
  }
}
