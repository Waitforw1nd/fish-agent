import { h, clear } from '../../lib/dom.js';
import { normalizeAgentList } from '../../lib/normalize.js';
import { button, checkbox, field, input, optionalCall, panel, perform } from '../common.js';

const CATEGORIES = {
  messaging: '消息发送', sticker: '表情管理', query: '消息查询', memory: '记忆系统',
  web: '联网搜索', knowledge: '知识库', media: '媒体理解', system: '系统反馈'
};

export function createCapabilitiesEditor(ctx, config, refresh) {
  const ro = ctx.readOnly;
  const search = checkbox('启用联网搜索', config.webSearch?.enabled !== false, ro);
  const memory = checkbox('自动整理记忆', config.memory?.consolidateEnabled !== false, ro);
  const tools = checkbox('启用工具', config.tools?.enabled !== false, ro);
  const categories = {};
  const categoryNodes = Object.entries(CATEGORIES).map(([key, label]) => {
    const item = checkbox(label, config.tools?.categories?.[key] !== false, ro);
    categories[key] = item.control;
    return item.node;
  });
  const save = button('保存能力开关', async () => {
    const result = await perform(ctx, () => ctx.api.updateAgentConfig(ctx.tenantId, {
      webSearch: { enabled: search.control.checked }, memory: { consolidateEnabled: memory.control.checked },
      tools: { enabled: tools.control.checked, categories: Object.fromEntries(Object.entries(categories).map(([key, control]) => [key, control.checked])) }
    }));
    if (result !== undefined) refresh();
  }, ro, 'primary');
  const skillList = h('div', { class: 'workspace-stack' }, h('p', { class: 'note' }, '正在加载可用能力…'));
  const diagnostics = h('div', { class: 'workspace-stack' }, h('p', { class: 'note' }, '正在读取工具诊断…'));
  async function loadSkills() {
    let payload;
    try { payload = await optionalCall(ctx.api, 'getAgentSkills', ctx.tenantId); }
    catch (error) {
      skillList.textContent = error?.message || '无法读取能力列表。';
      diagnostics.textContent = '暂时无法读取工具诊断。';
      return;
    }
    clear(skillList);
    clear(diagnostics);
    if (payload?.availabilityKnown === false || payload?.agentRunning === false) {
      diagnostics.appendChild(h('p', { class: 'note' }, '实例离线，工具可用性尚未检测。'));
    } else if (payload?.availabilityKnown !== true) {
      diagnostics.appendChild(h('p', { class: 'note' }, '当前服务未提供工具可用性诊断。'));
    } else {
      const toolItems = normalizeAgentList(payload, 'tools');
      if (!toolItems.length) diagnostics.appendChild(h('p', { class: 'note' }, '当前没有可检测的工具。'));
      for (const tool of toolItems) {
        const category = payload.categories?.[tool.category]?.name || CATEGORIES[tool.category] || tool.category || '其他';
        const available = tool.enabled === true;
        diagnostics.appendChild(h('div', { class: 'workspace-item' },
          h('strong', {}, tool.name || tool.id || '未命名工具'),
          h('p', { class: 'note' }, `${category} · ${available ? '可用' : '不可用'}${!available && tool.reason ? ` · ${tool.reason}` : ''}`)));
      }
    }
    const skills = normalizeAgentList(payload, 'skills', 'extensions');
    if (!skills.length) skillList.appendChild(h('p', { class: 'note' }, '该实例当前没有可配置的扩展。'));
    for (const skill of skills) {
      if (skill.blocked) continue;
      const id = String(skill.id || skill.name || '');
      if (!id) continue;
      const configuredEnabled = config.skills?.[id]?.enabled;
      const enabled = checkbox('启用', Boolean(configuredEnabled ?? skill.enabled ?? skill.enabledByDefault ?? true), ro);
      const settings = {};
      const schema = skill.configSchema || skill.manifest?.configSchema || {};
      const current = { ...(skill.defaults || {}), ...(skill.settings || {}), ...(config.skills?.[id] || {}) };
      const fields = [];
      for (const [key, descriptorValue] of Object.entries(schema)) {
        if (!descriptorValue || typeof descriptorValue !== 'object' || Array.isArray(descriptorValue)) continue;
        const descriptor = descriptorValue;
        if (descriptor.secret || /url|endpoint|host|proxy|path|command|script|exec|token|key|cookie|secret|password/i.test(key)
          || !['boolean', 'number', 'integer', 'string', 'select', 'enum'].includes(descriptor.type)) continue;
        const label = descriptor.label || descriptor.title || key;
        let control;
        if (descriptor.type === 'boolean' || typeof current[key] === 'boolean') {
          const check = checkbox(label, Boolean(current[key]), ro); control = check.control; fields.push(check.node);
        } else if (Array.isArray(descriptor.enum) || Array.isArray(descriptor.options)) {
          const options = descriptor.enum || descriptor.options;
          control = h('select', { class: 'select', disabled: ro }, ...options.map((value) => {
            const v = typeof value === 'object' ? value.value : value;
            return h('option', { value: v }, typeof value === 'object' ? value.label || v : v);
          }));
          control.value = String(current[key] ?? descriptor.default ?? '');
          fields.push(field(label, control));
        } else {
          control = input(current[key] ?? descriptor.default ?? '', { disabled: ro, type: descriptor.type === 'number' || descriptor.type === 'integer' ? 'number' : 'text', min: descriptor.min, max: descriptor.max });
          fields.push(field(label, control));
        }
        settings[key] = { control, descriptor };
      }
      const apply = button('保存扩展设置', async () => {
        const values = {};
        for (const [key, { control, descriptor }] of Object.entries(settings)) {
          values[key] = descriptor.type === 'boolean' ? control.checked
            : ['number', 'integer'].includes(descriptor.type) ? Number(control.value) : control.value;
        }
        const result = await perform(ctx, () => ctx.api.updateAgentSkill(ctx.tenantId, id, { enabled: enabled.control.checked, settings: values }));
        if (result !== undefined) void loadSkills();
      }, ro);
      skillList.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, skill.name || id),
        h('p', { class: 'note' }, skill.description || ''), enabled.node, ...fields, apply));
    }
  }
  const prompt = h('pre', { class: 'workspace-pre' });
  const preview = button('生成系统提示词预览', async () => {
    const result = await perform(ctx, () => ctx.api.previewAgentPrompt(ctx.tenantId, {}), '');
    if (result !== undefined) prompt.textContent = typeof result === 'string' ? result : String(result?.prompt ?? result?.systemPrompt ?? JSON.stringify(result, null, 2));
  });
  void loadSkills();
  return h('div', { class: 'workspace-stack' },
    panel('工具与记忆', search.node, memory.node, tools.node, ...categoryNodes, save),
    panel('工具可用性诊断', diagnostics),
    panel('可用插件与技能', skillList),
    panel('系统提示词预览', preview, prompt)
  );
}
