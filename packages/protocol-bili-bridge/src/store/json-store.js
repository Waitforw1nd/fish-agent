import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../errors.js';
import { clone, randomHex, safeJsonStringify } from '../util.js';

function storageError(message, cause) {
  return new BridgeError(message, { kind: 'STORAGE', code: 500, retcode: 1500, cause });
}

export class JsonStore {
  #queue = Promise.resolve();
  #loaded = false;

  constructor({ dir, name = 'state.json', defaults = () => ({}), logger = null }) {
    if (!dir) throw new TypeError('JsonStore 需要 dir');
    if (!/^[A-Za-z0-9._-]+$/.test(String(name))) throw new TypeError(`非法的存储文件名: ${name}`);
    this.dir = path.resolve(dir);
    this.name = name;
    this.file = path.join(this.dir, name);
    this.defaults = defaults;
    this.logger = logger;
    this.data = defaults();
  }

  async load() {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw storageError(`无法创建数据目录 ${this.dir}`, error);
    }
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.data = this.defaults();
        this.#loaded = true;
        return this.data;
      }
      throw storageError(`无法读取 ${this.file}`, error);
    }
    try {
      const parsed = JSON.parse(text);
      this.data = parsed === null || typeof parsed !== 'object' ? this.defaults() : parsed;
    } catch (error) {
      // 损坏的持久化状态不能静默清空：调用方需要人工处理，避免重复补发历史。
      throw storageError(`存储文件损坏，拒绝覆盖：${this.file}`, error);
    }
    this.#loaded = true;
    return this.data;
  }

  async #writeSnapshot(snapshot) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${this.name}.${process.pid}.${randomHex(4)}.tmp`);
    const body = `${safeJsonStringify(snapshot, '{}')}\n`;
    let handle = null;
    try {
      handle = await fs.open(tmp, 'w', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tmp, this.file);
    } catch (error) {
      try { if (handle) await handle.close(); } catch { /* ignore */ }
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw storageError(`写入 ${this.file} 失败`, error);
    }
  }

  /** 串行化所有写操作；mutator 可修改 data 或返回新 data。 */
  async update(mutator) {
    const run = this.#queue.then(async () => {
      if (!this.#loaded) await this.load();
      const draft = clone(this.data);
      const result = await mutator(draft);
      const next = result === undefined ? draft : result;
      if (next === null || typeof next !== 'object') throw storageError('update 必须返回对象或原位修改');
      const previous = this.data;
      this.data = next;
      try {
        await this.#writeSnapshot(this.data);
      } catch (error) {
        this.data = previous;
        throw error;
      }
      return this.data;
    });
    // 让失败不毒化后续队列，但调用方仍然收到拒绝。
    this.#queue = run.catch(() => {});
    return run;
  }

  async save() {
    return this.update(() => {});
  }
}
