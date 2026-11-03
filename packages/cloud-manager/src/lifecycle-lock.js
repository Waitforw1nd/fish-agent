// Lifecycle operations take this lock before the QQ service's internal lock.
export class LifecycleLock {
  constructor({ maxPending = 64 } = {}) { this.queues = new Map(); this.maxPending = maxPending; }
  async run(tenantId, fn, { mandatory = false } = {}) {
    const queue = this.queues.get(tenantId) || { tail: Promise.resolve(), count: 0 };
    if (!mandatory && queue.count >= this.maxPending) {
      throw Object.assign(new Error('租户操作过于频繁，请稍后重试'), { status: 429, code: 'LIFECYCLE_BUSY' });
    }
    queue.count++;
    const current = queue.tail.catch(() => {}).then(fn);
    queue.tail = current;
    this.queues.set(tenantId, queue);
    try { return await current; } finally {
      if (--queue.count === 0 && this.queues.get(tenantId) === queue) this.queues.delete(tenantId);
    }
  }
}
