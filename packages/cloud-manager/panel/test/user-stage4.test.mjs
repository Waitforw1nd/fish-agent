import test from 'node:test';
import assert from 'node:assert/strict';
import { mountUserInstances } from '../views/user/instances.js';
import { mountUserInstance } from '../views/user/instance.js';
import { mountUserChannel } from '../views/user/channel.js';
import { mountUserBilling } from '../views/user/billing.js';
import { mountAgentStudio } from '../components/agent-studio/index.js';
import { parseRoute } from '../lib/router.js';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';
import { createFakeTimers } from './helpers/fake-timers.mjs';

const setup = () => appendRoot(installDom());
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const toast = { show() {} };
const readiness = {
  steps: [{ id: 'agent', label: '启动实例', ready: false }, { id: 'qq', label: '扫码登录 QQ', ready: false },
    { id: 'channel', label: '配置模型渠道', ready: false }, { id: 'whitelist', label: '选择互动白名单', ready: false }],
  completed: 0, total: 4
};

test('四步向导识别后端步骤并直达白名单', async () => {
  const { root } = setup();
  const api = { listTenants: async () => ({ tenants: [{ id: 't/1', role: 'owner', status: 'stopped', readiness }] }) };
  const view = mountUserInstances({ root, api, toast }); await settle();
  assert.match(root.textContent, /开通进度 0\/4/);
  assert.match(root.textContent, /白名单为空/);
  const link = findByText(root, 'a', '选择白名单');
  assert.equal(link.getAttribute('href'), '#/user/instances/t%2F1?tab=whitelist');
  assert.equal(parseRoute(link.getAttribute('href')).section, 'whitelist');
  view.destroy();
});

test('实例工作台可从向导切换到离线白名单配置', async () => {
  const { root, modalRoot } = setup(); const timers = createFakeTimers();
  const api = {
    getTenant: async () => ({ tenant: { id: 't1', role: 'owner', status: 'stopped', readiness } }),
    getQQDrivers: async () => ({ drivers: [] }), getQQStatus: async () => ({}),
    getAgentConfig: async () => ({ config: { allow: { groups: [], private: [] } }, agentRunning: false }),
    updateAgentConfig: async () => ({})
  };
  const view = mountUserInstance({ root, modalRoot, api, tenantId: 't1', toast, timers }); await settle();
  findByText(root, 'button', '选择白名单').click(); await settle();
  assert.match(root.textContent, /允许的群号/);
  assert.match(root.textContent, /实例离线/);
  assert.equal(root.querySelectorAll('[role="tab"]').length, 5);
  view.destroy();
});

test('渠道选择套餐模型并用未保存输入探测自定义上游', async () => {
  const { root } = setup(); let probe, bound;
  const api = {
    getRelayOverview: async () => ({ configured: true, model: 'm1' }),
    getRelayCustom: async () => ({ configured: false }),
    getRelayModels: async () => ({ models: [{ id: 'm1' }, { id: 'm2' }] }),
    updateRelayKey: async (_id, body) => { bound = body; return {}; },
    testRelayCustom: async (_id, body) => { probe = body; return { connected: true, latencyMs: 23, models: ['remote-1'] }; }
  };
  const view = mountUserChannel({ root, api, toast, tenants: [{ id: 't', role: 'owner' }] }); await settle();
  root.querySelector('#user-relay-model').value = 'm2';
  findByText(root, 'button', '绑定平台 Key').click(); await settle();
  assert.deepEqual(bound, { model: 'm2' });
  root.querySelector('#custom-base-url').value = 'https://example.test/v1';
  root.querySelector('#custom-api-key').value = 'abc-secret';
  findByText(root, 'button', '测试连接并拉取模型').click(); await settle();
  assert.deepEqual(probe, { baseUrl: 'https://example.test/v1', apiKey: 'abc-secret' });
  assert.equal(root.querySelector('#custom-model').value, 'remote-1');
  assert.match(root.textContent, /连接成功.*23 ms/);
  assert.doesNotMatch(root.textContent, /abc-secret/);
  view.destroy();
});

test('钱包显示驳回说明与流水，续费提交套餐和天数，operator 无权写入', async () => {
  const { root } = setup(); let renewed;
  const api = {
    getRecharges: async () => ({ recharges: [{ id: 'r', status: 'rejected', amountMicros: 2000000, reviewNote: '请核对付款' }] }),
    getRelayOverview: async () => ({ wallet: { balanceMicros: 0, availableMicros: 0 } }),
    getTransactions: async () => ({ transactions: [{ id: 'x', kind: 'topup', amountMicros: 3000000, note: '人工调整' }] }),
    listPlans: async () => ({ plans: [{ id: 'pro', name: '专业' }] }),
    renewTenant: async (_id, body) => { renewed = body; }
  };
  const view = mountUserBilling({ root, api, toast, tenants: [{ id: 't', role: 'owner' }] }); await settle();
  assert.match(root.textContent, /已驳回.*请核对付款/);
  assert.match(root.textContent, /钱包流水.*人工调整/);
  root.querySelector('#renew-plan').value = 'pro';
  root.querySelector('#renew-days').value = '30';
  findByText(root, 'button', '续费套餐').click(); await settle();
  assert.deepEqual(renewed, { days: 30, planId: 'pro' }); view.destroy();
  const other = setup();
  const readonly = mountUserBilling({ root: other.root, api, toast, tenants: [{ id: 't', role: 'operator' }] }); await settle();
  assert.equal(findByText(other.root, 'button', '续费套餐').disabled, true);
  assert.equal(findByText(other.root, 'button', '提交充值申请').disabled, true);
  readonly.destroy();
});

test('四档与安全扩展参数保存，危险 schema 字段不会提交', async () => {
  const { root } = setup(); let behavior, skillPatch;
  const api = {
    getAgentConfig: async () => ({ config: { store: { contextTier: 2 }, skills: { ext: { enabled: false, count: 2 } } } }),
    updateAgentConfig: async (_id, patch) => { behavior = patch; return {}; },
    getAgentSkills: async () => ({ skills: [{ id: 'ext', name: '扩展', enabledByDefault: true,
      configSchema: { count: { type: 'number' }, endpoint: { type: 'string' }, apiKey: { type: 'string', secret: true } } }] }),
    updateAgentSkill: async (_id, _skill, patch) => { skillPatch = patch; return {}; }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, section: 'behavior' }); await settle();
  assert.equal(root.querySelectorAll('.workspace-tier-card').length, 4);
  const radios = root.querySelectorAll('input[type="radio"]');
  radios[2].checked = true; fire(radios[2], 'change');
  const range = root.querySelector('input[type="range"]'); range.value = '35'; fire(range, 'input');
  findByText(root, 'button', '保存响应与互动').click(); await settle();
  assert.equal(behavior.store.contextTier, 3);
  assert.equal(behavior.store.randomPercent, 35);
  const boxes = root.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes[boxes.length - 1].checked, false);
  findByText(root, 'button', '保存扩展设置').click(); await settle();
  assert.deepEqual(skillPatch, { enabled: false, settings: { count: 2 } });
  assert.doesNotMatch(root.textContent, /endpoint|apiKey/);
  view.destroy();
});

test('角色卡先预览过滤说明，确认后携带原文件导入', async () => {
  const { root, modalRoot } = setup(); let preview, imported;
  const api = {
    getAgentConfig: async () => ({ config: { persona: { roleText: '原人设' } } }),
    getAgentPersonas: async () => ({ templates: [{ id: 'default', name: '默认', text: '小鲸鱼', builtin: true }] }),
    previewAgentPersonaCard: async (_id, body) => { preview = body; return { card: { name: '<角色>', description: '角色描述', warnings: ['系统提示已过滤'] } }; },
    importAgentPersonaCard: async (_id, body) => { imported = body; return {}; }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, modalRoot, section: 'persona' });
  await settle(); findByText(root, 'button', '套用').click();
  assert.equal(view.hasUnsavedChanges(), true);
  const file = root.querySelector('input[type="file"]');
  file.files = [new File(['{"name":"fish"}'], 'fish.json', { type: 'application/json' })];
  findByText(root, 'button', '预览角色卡').click(); await settle();
  assert.equal(preview.name, 'fish.json');
  assert.match(modalRoot.textContent, /系统提示已过滤/);
  assert.match(modalRoot.textContent, /<角色>/);
  assert.equal(modalRoot.querySelector('角色'), null);
  findByText(modalRoot, 'button', '导入角色卡').click(); await settle();
  assert.deepEqual(imported, { ...preview, applyNow: true });
  view.destroy();
});

test('运行记录、白名单测试消息与群友印象使用真实接口', async () => {
  const { root } = setup(); const calls = [];
  const api = {
    getAgentConfig: async () => ({ config: {} }),
    getAgentStatus: async () => ({ paused: false }),
    getAgentSessions: async () => ({ sessions: [{ id: 's1', status: 'error', trigger: '关键词' }] }),
    getAgentChats: async () => ({ chats: [{ key: 'group:123', chatName: '测试群' }] }),
    getAgentMemories: async () => ({ files: [{ chatKey: 'group:123', memberCount: 1, impressionCount: 1 }] }),
    getTenantBackups: async () => ({ backups: [] }),
    controlAgentSession: async (...args) => { calls.push(['session', ...args]); return {}; },
    agentChatAction: async (...args) => { calls.push(['chat', ...args]); return {}; },
    getAgentMemory: async () => ({ members: [{ userId: '456', name: '朋友', impressions: [{ content: '喜欢钓鱼', createdAt: 123 }] }] }),
    updateAgentMemoryMember: async (...args) => { calls.push(['memory', ...args]); return {}; }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, section: 'runtime' }); await settle();
  findByText(root, 'button', '重试').click(); await settle();
  assert.deepEqual(calls[0], ['session', 't', 's1', 'retry']);
  const text = root.querySelector('input[placeholder="输入测试消息"]'); text.value = '你好';
  findByText(root, 'button', '发送测试消息').click(); await settle();
  assert.deepEqual(calls[1], ['chat', 't', 'group:123', { action: 'test-send', text: '你好' }]);
  findByText(root, 'button', '查看与编辑').click(); await settle();
  const areas = root.querySelectorAll('textarea');
  assert.equal(areas[1].value, '喜欢钓鱼');
  areas[1].value = '喜欢钓鱼\n周末徒步';
  findByText(root, 'button', '保存印象').click(); await settle();
  assert.deepEqual(calls[2], ['memory', 't', 'group:123', '456', { name: '朋友', note: '', impressions: ['喜欢钓鱼', '周末徒步'] }]);
  view.destroy();
});

test('能力诊断展示真实工具分类、可用状态和原因，离线明确未知', async () => {
  const { root } = setup();
  let online = true;
  const api = {
    getAgentConfig: async () => ({ config: {} }),
    getAgentSkills: async () => online
      ? { availabilityKnown: true, agentRunning: true, skills: [], categories: { web: { name: '联网搜索' } },
        tools: [{ id: 'web_search', name: '网页检索', category: 'web', enabled: false, reason: '搜索未启用 <disabled>' }] }
      : { availabilityKnown: false, agentRunning: false, skills: [], tools: [] }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, section: 'capabilities' });
  await settle();
  assert.match(root.textContent, /网页检索.*联网搜索.*不可用.*搜索未启用 <disabled>/);
  assert.equal(root.querySelector('disabled'), null);
  online = false; await view.reload(); await settle();
  assert.match(root.textContent, /实例离线，工具可用性尚未检测/);
  view.destroy();
});
