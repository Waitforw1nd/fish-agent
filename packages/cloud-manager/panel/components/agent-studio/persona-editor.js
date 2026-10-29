import { h, clear } from '../../lib/dom.js';
import { openModal } from '../../lib/modal.js';
import { normalizeAgentList } from '../../lib/normalize.js';
import { button, checkbox, field, filePayload, input, optionalCall, panel, perform, textarea } from '../common.js';

export function createPersonaEditor(ctx, config, refresh) {
  const ro = ctx.readOnly;
  const persona = config.persona || {};
  const name = input(persona.botName || '', { disabled: ro });
  const nickname = input(persona.selfNickname || '', { disabled: ro });
  const participation = h('select', { class: 'select', disabled: ro }, ...[['low', '低'], ['medium', '中'], ['high', '高']].map(([v, label]) => h('option', { value: v }, label)));
  participation.value = persona.participation || 'medium';
  const text = textarea(persona.roleText || '', { disabled: ro, rows: 8 });
  const rules = textarea(persona.customRules || '', { disabled: ro });
  const unified = checkbox('所有会话使用同一人设', config.personaUnified !== false, ro);
  const groupFields = h('div', { class: 'workspace-stack' });
  const byChat = config.personaByChat || {};
  const groupEditors = new Map();
  const chatIds = [...new Set([...(config.allow?.groups || []), ...Object.keys(byChat)].map(String))];
  for (const id of chatIds) {
    const override = byChat[id] || {};
    const roleText = textarea(override.roleText || '', { disabled: ro });
    const customRules = textarea(override.customRules || '', { disabled: ro });
    groupEditors.set(id, { roleText, customRules });
    groupFields.appendChild(panel(`群 ${id}`, field('独立人设（留空沿用全局）', roleText), field('独立追加规则', customRules)));
  }
  const syncUnified = () => { groupFields.hidden = unified.control.checked; };
  unified.control.addEventListener('change', syncUnified); syncUnified();
  const list = h('div', { class: 'workspace-stack' }, h('p', { class: 'note' }, '正在加载模板…'));
  async function loadTemplates() {
    const payload = await optionalCall(ctx.api, 'getAgentPersonas', ctx.tenantId).catch(() => null);
    clear(list);
    const templates = normalizeAgentList(payload, 'templates', 'personas');
    if (!templates.length) list.appendChild(h('p', { class: 'note' }, '暂无可用模板。'));
    for (const item of templates) {
      list.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, item.name || item.id),
        h('p', { class: 'note' }, String(item.text || '').slice(0, 150)),
        button('套用', () => {
          text.value = item.text || ''; rules.value = item.customRules || '';
          text.dispatchEvent(new Event('input', { bubbles: true }));
        }, ro),
        item.builtin || !String(item.id).startsWith('custom_') ? null : button('删除', async () => {
          const result = await perform(ctx, () => ctx.api.deleteAgentPersona(ctx.tenantId, item.id), '模板已删除');
          if (result !== undefined) void loadTemplates();
        }, ro)));
    }
  }
  const save = button('保存人设', async () => {
    const next = { ...byChat };
    for (const [id, values] of groupEditors) {
      next[id] = { ...next[id], roleText: values.roleText.value, customRules: values.customRules.value };
    }
    const result = await perform(ctx, () => ctx.api.updateAgentConfig(ctx.tenantId, {
      persona: { botName: name.value.trim(), selfNickname: nickname.value.trim(), participation: participation.value, roleText: text.value, customRules: rules.value },
      personaUnified: unified.control.checked, personaByChat: { __replace__: next }
    }));
    if (result !== undefined) refresh();
  }, ro, 'primary');
  const templateName = input('', { disabled: ro, placeholder: '新模板名称' });
  const saveTemplate = button('另存为模板', async () => {
    if (!templateName.value.trim() || !text.value.trim()) { ctx.toast?.show?.('请填写模板名称和人设正文。', { tone: 'danger' }); return; }
    const result = await perform(ctx, () => ctx.api.createAgentPersona(ctx.tenantId, { name: templateName.value.trim(), text: text.value, customRules: rules.value }), '模板已保存');
    if (result !== undefined) { templateName.value = ''; void loadTemplates(); }
  }, ro);
  const file = h('input', { type: 'file', accept: '.json,.png,application/json,image/png', disabled: ro });
  const preview = button('预览角色卡', async () => {
    const payload = await perform(ctx, async () => {
      const encoded = await filePayload(file.files?.[0]);
      const result = await ctx.api.previewAgentPersonaCard(ctx.tenantId, encoded);
      return { encoded, card: result?.card || result };
    }, '');
    if (!payload) return;
    const card = payload.card || {};
    const warnings = Array.isArray(card.warnings) ? card.warnings : [];
    const details = h('div', { class: 'workspace-stack' },
      h('strong', {}, card.name || '角色卡'),
      h('p', {}, card.description || card.text || card.summary || '角色卡解析成功。'),
      h('p', { class: 'note' }, '导入时会过滤系统提示词、世界书和资源。'),
      ...warnings.map((warning) => h('p', { class: 'note' }, String(warning))));
    const apply = checkbox('导入后立即应用', true);
    details.appendChild(apply.node);
    const close = button('取消', () => modal.close('cancel'));
    const submit = button('导入角色卡', async () => {
      const result = await perform(ctx, () => ctx.api.importAgentPersonaCard(ctx.tenantId, { ...payload.encoded, applyNow: apply.control.checked }), '角色卡已导入');
      if (result !== undefined) { modal.close('import'); refresh(); }
    }, false, 'primary');
    const modal = openModal({ root: ctx.modalRoot || document.getElementById('modal-root') || document.body, title: '预览角色卡', content: details, footer: [close, submit], wide: true });
  }, ro);
  void loadTemplates();
  return h('div', { class: 'workspace-stack' },
    panel('基础人设', field('机器人名字', name), field('群内展示昵称', nickname), field('发言参与度', participation),
      field('人设正文', text), field('追加规则', rules), unified.node, groupFields, save),
    panel('人设模板', list, field('模板名称', templateName), saveTemplate),
    panel('导入 SillyTavern 角色卡', h('p', { class: 'note' }, '支持 JSON 或 PNG，最大 8 MiB。先预览，确认后导入。'), file, preview)
  );
}
