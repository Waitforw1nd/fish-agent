// 可暂停的轮询器：页面隐藏时停表，恢复可见时立即补拉；失败指数退避。
// 计时器与可见性均可注入，测试使用假时钟，不依赖真实等待。

import { defaultTimers } from './timers.js';

function defaultVisibility() {
  const doc = typeof document !== 'undefined' ? document : null;
  return {
    isHidden: () => Boolean(doc && doc.hidden),
    subscribe: (listener) => {
      if (!doc) return () => {};
      doc.addEventListener('visibilitychange', listener);
      return () => doc.removeEventListener('visibilitychange', listener);
    }
  };
}

export function createPoller({
  task,
  intervalMs = 5000,
  maxIntervalMs = 30_000,
  backoffFactor = 2,
  immediate = true,
  timers = defaultTimers(),
  visibility = defaultVisibility(),
  onError = null,
  onSuccess = null
} = {}) {
  if (typeof task !== 'function') throw new TypeError('task 必须是函数');
  const baseInterval = Math.max(250, Number(intervalMs) || 5000);
  const maxInterval = Math.max(baseInterval, Number(maxIntervalMs) || baseInterval * 6);
  let timer = null;
  let running = false;
  let inFlight = false;
  let pending = false;
  let failures = 0;
  let currentInterval = baseInterval;
  let unsubscribe = null;

  function clearTimer() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay) {
    clearTimer();
    if (!running || visibility.isHidden()) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run(false);
    }, Math.max(0, delay));
  }

  async function run(manual) {
    if (!running) return;
    if (inFlight) {
      pending = true;
      return;
    }
    if (!manual && visibility.isHidden()) return;
    inFlight = true;
    try {
      await task();
      failures = 0;
      currentInterval = baseInterval;
      if (typeof onSuccess === 'function') onSuccess();
    } catch (error) {
      failures += 1;
      currentInterval = Math.min(maxInterval, Math.round(baseInterval * Math.pow(backoffFactor, failures)));
      if (typeof onError === 'function') onError(error);
    } finally {
      inFlight = false;
      if (!running) return;
      if (pending) {
        pending = false;
        schedule(0);
      } else {
        schedule(currentInterval);
      }
    }
  }

  function handleVisibilityChange() {
    if (!running) return;
    if (visibility.isHidden()) {
      clearTimer();
      return;
    }
    currentInterval = baseInterval;
    clearTimer();
    schedule(0);
  }

  function start() {
    if (running) return;
    running = true;
    failures = 0;
    currentInterval = baseInterval;
    if (visibility.subscribe) unsubscribe = visibility.subscribe(handleVisibilityChange);
    if (immediate) schedule(0);
    else schedule(currentInterval);
  }

  function stop() {
    if (!running) return;
    running = false;
    pending = false;
    clearTimer();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function refreshNow() {
    if (!running) return Promise.resolve();
    if (inFlight) {
      pending = true;
      return Promise.resolve();
    }
    clearTimer();
    return run(true);
  }

  return {
    start,
    stop,
    destroy: stop,
    refreshNow,
    isRunning: () => running,
    getInterval: () => currentInterval,
    isInFlight: () => inFlight
  };
}
