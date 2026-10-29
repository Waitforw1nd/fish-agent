import { h, clear } from '../../lib/dom.js';
import { normalizeAgentList } from '../../lib/normalize.js';
import { button, field, input, optionalCall, panel, perform, textarea } from '../common.js';

export function createRuntimeInspector(ctx) {
  const ro = ctx.readOnly;
  const backupReadOnly = ro || (!ctx.admin && ctx.mode !== 'admin' && ctx.user?.role !== 'admin' && ctx.tenant?.role === 'operator');
  const sessions = h('div', { class: 'workspace-stack' });
  const chats = h('div', { class: 'workspace-stack' });
  const memories = h('div', { class: 'workspace-stack' });
  const backups = h('div', { class: 'workspace-stack' });
  const status = h('p', { class: 'note' }, '正在读取运行状态…');
  const pause = button('暂停回复', async () => {
    const result = await perform(ctx, () => ctx.api.setAgentPause(ctx.tenantId, !paused), paused ? '已恢复回复' : '已暂停回复');
    if (result !== undefined) await loadStatus();
  }, ro);
  let paused = false;
  async function loadStatus() {
    try {
      const result = await optionalCall(ctx.api, 'getAgentStatus', ctx.tenantId);
      paused = Boolean(result?.paused ?? result?.status?.paused);
      status.textContent = result ? (paused ? '机器人已暂停回复。' : '机器人正在允许回复。') : '运行状态暂不可用。';
      pause.textContent = paused ? '恢复回复' : '暂停回复';
    } catch (error) { status.textContent = error?.message || '运行状态暂不可用。'; }
  }
  async function loadSessions() {
    try {
      const payload = await optionalCall(ctx.api, 'getAgentSessions', ctx.tenantId);
      clear(sessions);
      const list = normalizeAgentList(payload, 'sessions');
      if (!list.length) sessions.appendChild(h('p', { class: 'note' }, '暂无最近会话。'));
      for (const item of list) {
        const id = String(item.id ?? item.sessionId ?? '');
        const state = String(item.status ?? item.state ?? '');
        sessions.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, id || '会话'),
          h('p', { class: 'note' }, `${state || '未知状态'} · ${item.triggerReason || item.trigger || item.reason || '无触发说明'}`),
          button('重试', async () => { if (await perform(ctx, () => ctx.api.controlAgentSession(ctx.tenantId, id, 'retry')) !== undefined) void loadSessions(); }, ro || !id || !['error', 'failed'].includes(state)),
          button('中止', async () => { if (await perform(ctx, () => ctx.api.controlAgentSession(ctx.tenantId, id, 'abort')) !== undefined) void loadSessions(); }, ro || !id || !['running', 'pending', 'waiting'].includes(state)),
          button('删除', async () => { if (await perform(ctx, () => ctx.api.controlAgentSession(ctx.tenantId, id, 'delete')) !== undefined) void loadSessions(); }, ro || !id || ['running', 'pending', 'waiting'].includes(state))));
      }
    } catch (error) { sessions.textContent = error?.message || '读取会话失败。'; }
  }
  async function loadChats() {
    try {
      const payload = await optionalCall(ctx.api, 'getAgentChats', ctx.tenantId);
      clear(chats);
      const list = normalizeAgentList(payload, 'chats');
      if (!list.length) chats.appendChild(h('p', { class: 'note' }, '暂无消息存档。'));
      for (const item of list) {
        const id = String(item.key ?? item.chatId ?? item.id ?? '');
        if (!id) continue;
        const message = input('', { disabled: ro, placeholder: '输入测试消息' });
        const result = h('pre', { class: 'workspace-pre' });
        const action = (name) => async () => {
          const value = await perform(ctx, () => ctx.api.agentChatAction(ctx.tenantId, id, { action: name, ...(name === 'test-send' ? { text: message.value } : {}) }));
          if (value !== undefined && name === 'test-send') message.value = '';
        };
        chats.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, item.chatName || item.name || id),
          button('查看消息', async () => {
            const data = await perform(ctx, () => ctx.api.getAgentChatMessages(ctx.tenantId, id, { limit: 100 }), '');
            if (data !== undefined) result.textContent = normalizeAgentList(data, 'messages').map((m) => `${m.senderName || m.senderId || ''}: ${m.text || ''}`).join('\n') || '暂无消息';
          }), result, field('测试消息', message), button('发送测试消息', action('test-send'), ro),
          button('标记已读', action('mark-read'), ro), button('屏蔽未读', action('mute'), ro), button('清空存档', action('clear'), ro)));
      }
    } catch (error) { chats.textContent = error?.message || '读取存档失败。'; }
  }
  async function loadMemories() {
    try {
      const payload = await optionalCall(ctx.api, 'getAgentMemories', ctx.tenantId);
      clear(memories);
      const list = normalizeAgentList(payload, 'files', 'memories');
      if (!list.length) memories.appendChild(h('p', { class: 'note' }, '暂无记忆记录。'));
      for (const item of list) {
        const id = String(item.chatKey ?? item.chatId ?? item.id ?? '');
        if (!id) continue;
        const detail = h('div', { class: 'workspace-stack' });
        const show = async () => {
          const result = await perform(ctx, () => ctx.api.getAgentMemory(ctx.tenantId, id), '');
          if (result === undefined) return;
          clear(detail);
          const members = normalizeAgentList(result, 'members');
          if (!members.length) detail.appendChild(h('p', { class: 'note' }, '没有群友印象。'));
          for (const member of members) {
            const uid = String(member.userId ?? member.id ?? '');
            const name = input(member.name || '', { disabled: ro });
            const note = textarea(member.note || '', { disabled: ro });
            const impressions = textarea((member.impressions || []).map((entry) => typeof entry === 'string' ? entry : entry.content || '').join('\n'), { disabled: ro });
            const save = button('保存印象', async () => {
              const values = impressions.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
              if (await perform(ctx, () => ctx.api.updateAgentMemoryMember(ctx.tenantId, id, uid, { name: name.value, note: note.value, impressions: values })) !== undefined) void show();
            }, ro);
            detail.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, uid), field('昵称', name), field('备注', note), field('印象（一行一条）', impressions), save,
              button('删除成员印象', async () => { if (await perform(ctx, () => ctx.api.deleteAgentMemoryMember(ctx.tenantId, id, uid)) !== undefined) void show(); }, ro)));
          }
        };
        memories.appendChild(h('div', { class: 'workspace-item' }, h('strong', {}, id),
          h('p', { class: 'note' }, `${item.memberCount ?? 0} 位成员 · ${item.impressionCount ?? 0} 条印象`),
          button('查看与编辑', show), button('整理记忆', async () => { await perform(ctx, () => ctx.api.consolidateAgentMemory(ctx.tenantId, { chatKey: id }), '已提交记忆整理'); }, ro),
          button('清空会话记忆', async () => { if (await perform(ctx, () => ctx.api.deleteAgentMemory(ctx.tenantId, id)) !== undefined) void loadMemories(); }, ro), detail));
      }
    } catch (error) { memories.textContent = error?.message || '读取记忆失败。'; }
  }
  async function loadBackups() {
    try {
      const payload = await optionalCall(ctx.api, 'getTenantBackups', ctx.tenantId);
      clear(backups);
      const list = normalizeAgentList(payload, 'backups');
      if (!list.length) backups.appendChild(h('p', { class: 'note' }, '暂无备份。'));
      for (const item of list) {
        const id = String(item.id ?? item.backupId ?? item.name ?? '');
        backups.appendChild(h('div', { class: 'workspace-item' }, h('span', {}, `${id} ${item.createdAt || ''}`),
          button('恢复', async () => {
            if (globalThis.confirm && !globalThis.confirm('恢复备份会覆盖当前实例数据，确定继续？')) return;
            await perform(ctx, () => ctx.api.restoreTenant(ctx.tenantId, id), '备份恢复请求已提交');
          }, backupReadOnly || !id)));
      }
    } catch (error) { backups.textContent = error?.message || '读取备份失败。'; }
  }
  void loadStatus(); void loadSessions(); void loadChats(); void loadMemories(); void loadBackups();
  return h('div', { class: 'workspace-stack' },
    panel('暂停回复', status, pause),
    panel('最近会话', button('刷新', loadSessions), button('清空已结束会话', async () => { if (await perform(ctx, () => ctx.api.clearAgentSessions(ctx.tenantId)) !== undefined) void loadSessions(); }, ro), sessions),
    panel('消息存档与测试', button('刷新', loadChats), chats),
    panel('群友印象记忆', button('刷新', loadMemories), memories),
    panel('数据快照', button('创建备份', async () => { if (await perform(ctx, () => ctx.api.backupTenant(ctx.tenantId), '备份已创建') !== undefined) void loadBackups(); }, backupReadOnly), backups)
  );
}
