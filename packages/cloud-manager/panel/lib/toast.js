// 轻量提示条：自动消失、最多保留 4 条，错误信息先脱敏。

import { redactText } from './format.js';
import { h } from './dom.js';
import { defaultTimers } from './timers.js';

export function createToast(root, { timers = defaultTimers(), max = 4 } = {}) {
  if (!root) throw new TypeError('缺少 toast 容器');
  const entries = [];

  function dismiss(entry) {
    if (!entry || entry.removed) return;
    entry.removed = true;
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.node.remove?.();
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  }

  function show(message, { tone = 'info', timeout = 4200 } = {}) {
    const text = redactText(message, { maxLength: 400 }).trim();
    if (!text) return null;
    const node = h('div', { class: 'toast', dataset: { tone } }, text);
    root.appendChild(node);
    const entry = { node, timer: null, removed: false };
    entries.push(entry);
    while (entries.length > max) dismiss(entries[0]);
    if (timeout > 0) {
      entry.timer = timers.setTimeout(() => {
        if (entry.removed) return;
        node.classList.add('is-leaving');
        entry.timer = timers.setTimeout(() => dismiss(entry), 180);
      }, timeout);
    }
    return node;
  }

  function clearAll() {
    for (const entry of [...entries]) dismiss(entry);
  }

  return { show, dismiss, clear: clearAll, entries: () => [...entries] };
}
