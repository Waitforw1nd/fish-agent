// 浏览器定时器必须绑定到全局调用；直接引用 window.setInterval 再以对象方法调用
// 在 Chromium 会抛 "Illegal invocation"。统一从这里取默认实现。

export function defaultTimers() {
  return {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args)
  };
}
