import { sleep } from '../util.js';

/**
 * 低频轮询调度器：每任务独立定时器、完成后计算下一次间隔、失败指数退避。
 * 首次启动默认立即跑一次（watcher 用它建立“不回补历史”的基线）。
 */
export class PollScheduler {
  constructor({ now = Date.now, random = Math.random, logger = null, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.tasks = new Map();
    this.running = false;
  }

  register({ name, intervalMs, jitterMs = 0, initialDelayMs = 0, run, enabled = true, maxBackoffMs = 30 * 60 * 1000 }) {
    if (!name || typeof run !== 'function') throw new TypeError('调度任务需要 name 和 run');
    if (this.tasks.has(name)) throw new Error(`调度任务重复: ${name}`);
    const task = {
      name,
      intervalMs: Math.max(10, Number(intervalMs) || 10_000),
      jitterMs: Math.max(0, Number(jitterMs) || 0),
      initialDelayMs: Math.max(0, Number(initialDelayMs) || 0),
      maxBackoffMs: Math.max(Number(intervalMs) || 1000, Number(maxBackoffMs) || 30 * 60 * 1000),
      run,
      enabled: Boolean(enabled),
      timer: null,
      running: false,
      currentPromise: null,
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastRunAt: 0,
      lastFinishedAt: 0,
      lastError: '',
      lastDurationMs: 0,
      nextAt: 0
    };
    this.tasks.set(name, task);
    if (this.running) this.#schedule(task, task.initialDelayMs);
    return task;
  }

  #delayFor(task) {
    const jitter = task.jitterMs > 0 ? Math.floor(this.random() * task.jitterMs) : 0;
    if (task.consecutiveFailures > 0) {
      const base = Math.min(task.maxBackoffMs, task.intervalMs * 2 ** Math.min(task.consecutiveFailures, 8));
      return base + jitter;
    }
    return task.intervalMs + jitter;
  }

  #schedule(task, delay = null) {
    if (!this.running || !task.enabled) return;
    if (task.timer) this.clearTimeoutImpl(task.timer);
    const wait = delay == null ? this.#delayFor(task) : delay;
    task.nextAt = this.now() + wait;
    task.timer = this.setTimeoutImpl(() => {
      task.timer = null;
      this.#execute(task);
    }, wait);
    task.timer?.unref?.();
  }

  #execute(task) {
    if (!this.running || !task.enabled) return Promise.resolve();
    if (task.running) return task.currentPromise || Promise.resolve();
    task.running = true;
    task.runs += 1;
    task.lastRunAt = this.now();
    const started = this.now();
    task.currentPromise = (async () => {
      try {
        await task.run();
        task.consecutiveFailures = 0;
        task.lastError = '';
      } catch (error) {
        task.failures += 1;
        task.consecutiveFailures += 1;
        task.lastError = String(error?.wording || error?.message || error);
        this.logger?.warn?.(`轮询任务失败: ${task.name}`, error);
      } finally {
        task.lastDurationMs = this.now() - started;
        task.lastFinishedAt = this.now();
        task.running = false;
        task.currentPromise = null;
        this.#schedule(task);
      }
    })();
    return task.currentPromise;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    for (const task of this.tasks.values()) {
      if (task.enabled) this.#schedule(task, task.initialDelayMs);
    }
    return this;
  }

  async stop() {
    this.running = false;
    for (const task of this.tasks.values()) {
      if (task.timer) {
        this.clearTimeoutImpl(task.timer);
        task.timer = null;
      }
    }
  }

  enable(name, enabled) {
    const task = this.tasks.get(name);
    if (!task) return false;
    task.enabled = Boolean(enabled);
    if (!task.enabled && task.timer) {
      this.clearTimeoutImpl(task.timer);
      task.timer = null;
    } else if (task.enabled && this.running && !task.timer) {
      this.#schedule(task, 0);
    }
    return true;
  }

  async trigger(name) {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`未知调度任务: ${name}`);
    if (task.timer) {
      this.clearTimeoutImpl(task.timer);
      task.timer = null;
    }
    if (task.running) return task.currentPromise;
    if (!this.running) this.running = true;
    return this.#execute(task);
  }

  stats() {
    const out = {};
    for (const [name, task] of this.tasks) {
      out[name] = {
        enabled: task.enabled,
        running: task.running,
        intervalMs: task.intervalMs,
        jitterMs: task.jitterMs,
        runs: task.runs,
        failures: task.failures,
        consecutiveFailures: task.consecutiveFailures,
        lastRunAt: task.lastRunAt || null,
        lastFinishedAt: task.lastFinishedAt || null,
        lastDurationMs: task.lastDurationMs || null,
        lastError: task.lastError || null,
        nextAt: task.nextAt || null
      };
    }
    return out;
  }
}

/**
 * 低频出站队列：串行执行，保证两次发送之间至少 minInterval + 抖动。
 * 评论、直播弹幕、私信各用一个实例，互不阻塞，也绝不把一条回复拆成多条刷屏。
 */
export class LowFrequencyQueue {
  constructor({ name = 'queue', minIntervalMs = 15_000, jitterMs = 0, now = Date.now, random = Math.random, sleepFn = sleep, logger = null } = {}) {
    this.name = name;
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.now = now;
    this.random = random;
    this.sleepFn = sleepFn;
    this.logger = logger;
    this.chain = Promise.resolve();
    this.nextAt = 0;
    this.pending = 0;
    this.runs = 0;
    this.failures = 0;
    this.lastStartedAt = 0;
    this.lastFinishedAt = 0;
    this.lastError = '';
  }

  enqueue(fn, meta = null) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('LowFrequencyQueue 需要函数'));
    this.pending += 1;
    const run = (async () => {
      await this.chain.catch(() => {});
      const wait = Math.max(0, this.nextAt - this.now());
      if (wait > 0) await this.sleepFn(wait);
      this.runs += 1;
      this.lastStartedAt = this.now();
      try {
        return await fn();
      } catch (error) {
        this.failures += 1;
        this.lastError = String(error?.wording || error?.message || error);
        this.logger?.warn?.(`出站队列失败: ${this.name}`, { meta, error: this.lastError });
        throw error;
      } finally {
        this.lastFinishedAt = this.now();
        const gap = this.minIntervalMs + (this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0);
        this.nextAt = this.lastFinishedAt + gap;
        this.pending -= 1;
      }
    })();
    this.chain = run.catch(() => {});
    return run;
  }

  stats() {
    return {
      name: this.name,
      minIntervalMs: this.minIntervalMs,
      jitterMs: this.jitterMs,
      pending: this.pending,
      runs: this.runs,
      failures: this.failures,
      lastStartedAt: this.lastStartedAt || null,
      lastFinishedAt: this.lastFinishedAt || null,
      nextAt: this.nextAt || null,
      lastError: this.lastError || null
    };
  }
}
