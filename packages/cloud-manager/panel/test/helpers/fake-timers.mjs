// 可注入轮询器的假时钟：支持 setTimeout/setInterval、异步 tick 与待执行计数。

export function createFakeTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();

  function schedule(fn, delay, args, interval) {
    const id = nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, {
      id,
      fn,
      args,
      interval: interval ? Math.max(1, ms) : null,
      due: now + ms
    });
    return id;
  }

  const api = {
    setTimeout(fn, delay = 0, ...args) {
      return schedule(fn, delay, args, false);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, delay = 0, ...args) {
      return schedule(fn, delay, args, true);
    },
    clearInterval(id) {
      timers.delete(id);
    },
    now: () => now,
    pending: () => timers.size,
    async tick(ms = 0) {
      const target = now + Math.max(0, Number(ms) || 0);
      let guard = 0;
      while (true) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.due <= target && (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id))) {
            next = timer;
          }
        }
        if (!next) break;
        now = Math.max(now, next.due);
        if (next.interval) {
          next.due = now + next.interval;
        } else {
          timers.delete(next.id);
        }
        next.fn(...next.args);
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.resolve();
        guard += 1;
        if (guard > 10_000) throw new Error('假时钟 tick 次数过多，可能存在自旋定时器');
      }
      now = target;
    }
  };

  return api;
}
