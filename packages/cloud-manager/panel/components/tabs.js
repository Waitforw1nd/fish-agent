import { h } from '../lib/dom.js';

// The caller controls the dirty state so navigation never silently drops edits.
export function createTabs({ tabs, selected, onSelect, isDirty = () => false, confirmDiscard = () => globalThis.confirm?.('有未保存的更改，确定切换吗？') !== false } = {}) {
  const list = h('div', { class: 'workspace-tabs', role: 'tablist' });
  let current = selected || tabs[0]?.id;
  const controls = new Map();
  function paint() {
    for (const [id, control] of controls) {
      control.setAttribute('aria-selected', id === current ? 'true' : 'false');
      control.tabIndex = id === current ? 0 : -1;
      control.classList.toggle('is-active', id === current);
    }
  }
  function select(id) {
    if (!controls.has(id) || id === current) return false;
    if (isDirty() && !confirmDiscard()) return false;
    current = id; paint(); onSelect?.(id); return true;
  }
  for (const tab of tabs) {
    const control = h('button', { type: 'button', role: 'tab', class: 'workspace-tab', on: { click: () => select(tab.id) } }, tab.label);
    controls.set(tab.id, control); list.appendChild(control);
  }
  list.addEventListener('keydown', (event) => {
    const ids = tabs.map((tab) => tab.id);
    const index = ids.indexOf(current);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const target = ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    if (select(target)) controls.get(target)?.focus?.();
  });
  paint();
  return { node: list, select, selected: () => current };
}
