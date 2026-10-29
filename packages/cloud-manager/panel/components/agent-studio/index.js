import { h } from '../../lib/dom.js';
import { normalizeAgentConfig } from '../../lib/normalize.js';
import { createTabs } from '../tabs.js';
import { createWhitelistEditor } from './whitelist-editor.js';
import { createPersonaEditor } from './persona-editor.js';
import { createBehaviorEditor } from './behavior-editor.js';
import { createCapabilitiesEditor } from './capabilities-editor.js';
import { createRuntimeInspector } from './runtime-inspector.js';

export function mountAgentStudio(root, context = {}) {
  const ctx = { ...context };
  let active = true, config = {}, dirty = false, serial = 0;
  ctx.isActive = () => active;
  let section = ctx.section || 'whitelist';
  const body = h('div', { class: 'workspace-stack' });
  const tabs = createTabs({
    tabs: [
      { id: 'whitelist', label: '群聊与白名单' }, { id: 'persona', label: '人设与角色卡' },
      { id: 'behavior', label: '响应档位' }, { id: 'capabilities', label: '工具与能力' },
      { id: 'runtime', label: '会话与记忆' }
    ], selected: section, isDirty: () => dirty,
    onSelect: (next) => { dirty = false; section = next; renderEditor(); }
  });
  const warning = h('p', { class: 'note', 'aria-live': 'polite' });
  root.replaceChildren(h('div', { class: 'agent-studio workspace-stack' }, ctx.section ? null : tabs.node, warning, body));

  function renderEditor() {
    if (!active) return;
    const refresh = () => { dirty = false; void reload(); };
    let editor;
    if (section === 'persona') editor = createPersonaEditor(ctx, config, refresh);
    else if (section === 'behavior') {
      editor = h('div', { class: 'workspace-stack' }, createBehaviorEditor(ctx, config, refresh),
        ctx.section ? createCapabilitiesEditor(ctx, config, refresh) : null);
    } else if (section === 'capabilities') editor = createCapabilitiesEditor(ctx, config, refresh);
    else if (section === 'runtime') editor = createRuntimeInspector(ctx);
    else editor = createWhitelistEditor(ctx, config, refresh);
    body.replaceChildren(editor);
    for (const event of ['input', 'change']) editor.addEventListener(event, (event) => {
      const target = event.target;
      if (target?.localName === 'input' || target?.localName === 'textarea' || target?.localName === 'select') dirty = true;
    });
  }
  async function reload() {
    if (!active) return;
    const current = ++serial;
    if (typeof ctx.api?.getAgentConfig !== 'function') {
      warning.textContent = '当前服务未提供 QQ Agent 设置接口。';
      body.replaceChildren();
      return;
    }
    warning.textContent = '正在加载 QQ Agent 设置…';
    try {
      const result = await ctx.api.getAgentConfig(ctx.tenantId);
      if (!active || current !== serial) return;
      const data = normalizeAgentConfig(result);
      config = data.config;
      dirty = false;
      warning.textContent = data.agentRunning ? '实例在线，保存后即时生效。' : '实例离线，设置将在下次启动时生效。';
      renderEditor();
    } catch (error) {
      if (!active || current !== serial) return;
      warning.textContent = error?.message || '无法读取 QQ Agent 设置，请刷新重试。';
      body.replaceChildren(h('button', { class: 'btn btn-soft', type: 'button', on: { click: reload } }, '重试'));
    }
  }
  void reload();
  return {
    reload, refresh: reload,
    hasUnsavedChanges: () => dirty,
    canLeave: () => !dirty || !globalThis.confirm || globalThis.confirm('有未保存的更改，确定离开吗？'),
    destroy() { active = false; serial += 1; root.replaceChildren(); }
  };
}
