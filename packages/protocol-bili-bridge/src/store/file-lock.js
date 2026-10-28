import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BridgeError } from '../errors.js';
import { randomHex, sleep } from '../util.js';

/** 进程内互斥：把并发调用串成一条链，共享同一个结果。 */
export class Mutex {
  #chain = Promise.resolve();

  run(fn) {
    const task = this.#chain.then(() => fn());
    this.#chain = task.catch(() => {});
    return task;
  }
}

/**
 * 账号级文件锁：同一账号的 cookie 保活必须在跨进程范围内串行，
 * 否则两个进程各自 refresh 会互相踢掉对方的新 token。
 */
export class FileLock {
  constructor({ path: lockPath, staleMs = 60_000, timeoutMs = 15_000, retryMs = 40, now = Date.now, logger = null } = {}) {
    if (!lockPath) throw new TypeError('FileLock 需要 path');
    this.path = path.resolve(lockPath);
    this.staleMs = Math.max(1000, Number(staleMs) || 60_000);
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0);
    this.retryMs = Math.max(5, Number(retryMs) || 40);
    this.now = now;
    this.logger = logger;
    this.token = randomHex(12);
    this.#held = false;
  }

  #held;

  get held() { return this.#held; }

  async #readInfo() {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      const stat = await fs.stat(this.path);
      let info = null;
      try { info = JSON.parse(text); } catch { /* 半截写入 */ }
      return { info, mtimeMs: stat.mtimeMs };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #trySteal(staleInfo) {
    if (!staleInfo) return false;
    if (this.now() - staleInfo.mtimeMs < this.staleMs) return false;
    // 二次确认：真正删除前再读一次，避免误删刚被替换的新锁。
    const again = await this.#readInfo();
    if (!again || this.now() - again.mtimeMs < this.staleMs) return false;
    try {
      await fs.unlink(this.path);
      this.logger?.warn?.('清理过期的账号文件锁', { path: this.path, previousPid: again.info?.pid });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(this.path, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({
            token: this.token,
            pid: process.pid,
            host: os.hostname(),
            createdAt: this.now()
          }), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#held = true;
        return this;
      } catch (error) {
        if (error?.code === 'EEXIST') {
          // 落进下面的等待/抢占逻辑
        } else if (!this.#held) {
          await fs.unlink(this.path).catch(() => {});
          throw new BridgeError(`无法获取账号锁 ${this.path}`, {
            kind: 'LOCK', code: 500, retcode: 1500, cause: error
          });
        }
        if (error?.code === 'EEXIST') { /* noop, fallthrough */ }
      }
      {
        const existing = await this.#readInfo();
        if (await this.#trySteal(existing)) continue;
        if (this.now() >= deadline) {
          throw new BridgeError('账号正在被另一个进程使用（cookie 保活锁占用）', {
            kind: 'LOCK',
            code: 409,
            retcode: 1409,
            wording: '账号正在被另一个进程保活，请稍后重试',
            retryable: true,
            details: { holderPid: existing?.info?.pid ?? null }
          });
        }
        await sleep(Math.min(this.retryMs, Math.max(1, deadline - this.now())));
      }
    }
  }

  async release() {
    if (!this.#held) return;
    this.#held = false;
    try {
      const info = await this.#readInfo();
      if (info?.info?.token === this.token) await fs.unlink(this.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('释放账号文件锁失败', error);
    }
  }

  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }
}
