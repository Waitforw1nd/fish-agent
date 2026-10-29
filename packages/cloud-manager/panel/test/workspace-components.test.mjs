import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/api.js';
import { parseRoute, routeToHash, defaultRouteForUser, canAccessRoute } from '../lib/router.js';
import { mountAgentStudio } from '../components/agent-studio/index.js';
import { mountBiliPanel } from '../components/bili-panel.js';
import { mountExtensionManager } from '../components/extension-manager.js';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const setup = () => appendRoot(installDom());
const toast = { show() {} };

test('新路由与客户端保留转义、CSRF 和分组接口', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } };
  } });
  api.setCsrfToken('csrf');
  await api.agent.updateAgentConfig('a/b', { allow: { groups: ['123'] } });
  await api.extensions.removeExtension('a/b', 'x/y', { cleanConfig: true });
  await api.getAgentChatMessages('a/b', 'group:123', { limit: 10 });
  await api.changePassword({ currentPassword: 'old', newPassword: 'new' });
  await api.setQQAuthToken('a/b', 'token-value');
  assert.deepEqual(calls.map(({ path, init }) => [path, init.method]), [
    ['/api/tenants/a%2Fb/agent/config', 'PATCH'],
    ['/api/tenants/a%2Fb/extensions/x%2Fy?cleanConfig=1', 'DELETE'],
    ['/api/tenants/a%2Fb/agent/chats/group%3A123/messages?limit=10', 'GET'],
    ['/api/auth/password', 'PUT'], ['/api/tenants/a%2Fb/qq/auth-token', 'PUT']
  ]);
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf');
  assert.deepEqual(JSON.parse(calls[4].init.body), { token: 'token-value' });
  assert.equal(defaultRouteForUser({ role: 'admin' }), '#/admin/overview');
  assert.equal(parseRoute('#/tenants/a%2Fb/agent').tenantId, 'a/b');
  assert.equal(routeToHash({ name: 'tenantExtensions', tenantId: 'a/b' }), '#/tenants/a%2Fb/extensions');
  assert.equal(canAccessRoute(parseRoute('#/admin/recharges'), { role: 'user' }), false);
  assert.equal(canAccessRoute(parseRoute('#/user/agent'), { role: 'user' }), true);
});

test('离线手动白名单与群员屏蔽保存为安全配置补丁，viewer 不可写', async () => {
  const { root } = setup();
  let patch;
  const api = {
    getAgentConfig: async () => ({ agentRunning: false, config: { allow: { groups: ['123'], private: [] }, blocklist: {} } }),
    getAgentContacts: async () => ({ online: false, groups: [], friends: [] }),
    updateAgentConfig: async (_id, body) => { patch = body; return {}; }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, section: 'whitelist' });
  await settle();
  assert.match(root.textContent, /离线/);
  const textareas = root.querySelectorAll('textarea');
  textareas[0].value = '123, 456\n789';
  textareas[5].value = '123: 22, 33';
  fire(textareas[0], 'input');
  assert.equal(view.hasUnsavedChanges(), true);
  findByText(root, 'button', '保存白名单').click();
  await settle();
  assert.deepEqual(patch.allow.groups, ['123', '456', '789']);
  assert.deepEqual(patch.blocklist, { __replace__: { '123': ['22', '33'] } });
  assert.equal(view.hasUnsavedChanges(), false);
  view.destroy();
  const other = setup();
  const viewer = mountAgentStudio(other.root, { api, tenantId: 't', toast, section: 'whitelist', readOnly: true });
  await settle();
  assert.equal(findByText(other.root, 'button', '保存白名单').disabled, true);
  assert.equal(other.root.querySelector('textarea').disabled, true);
  viewer.destroy();
});

test('在线联系人名称作为文本显示，搜索后勾选并保存', async () => {
  const { root } = setup();
  let patch;
  const api = {
    getAgentConfig: async () => ({ config: { allow: { groups: [], private: [] } } }),
    getAgentContacts: async () => ({ online: true, groups: [{ group_id: 42, group_name: '<img src=x>' }], friends: [{ user_id: 55, nickname: '朋友' }] }),
    updateAgentConfig: async (_id, body) => { patch = body; return {}; }
  };
  const view = mountAgentStudio(root, { api, tenantId: 't', toast, section: 'whitelist' });
  await settle(); findByText(root, 'button', '拉取 QQ 联系人').click(); await settle();
  assert.match(root.textContent, /<img src=x>/);
  assert.equal(root.querySelector('img'), null);
  const search = root.querySelector('input[aria-label="搜索联系人"]');
  search.value = '42'; fire(search, 'input');
  const checkbox = root.querySelector('input[type="checkbox"]');
  checkbox.checked = true; fire(checkbox, 'change');
  findByText(root, 'button', '保存白名单').click(); await settle();
  assert.deepEqual(patch.allow.groups, ['42']);
  view.destroy();
});

test('B 站配置保留四种订阅与监控目标', async () => {
  const { root } = setup(); let saved;
  const api = {
    getBiliConfig: async () => ({ config: { subscriptions: { mentions: true, upVideos: false, privateMessages: true, liveRoom: false }, upMids: ['12'], videos: ['BV1234567890'], liveRoomIds: ['34'] } }),
    getBiliStatus: async () => ({}),
    updateBiliConfig: async (_id, body) => { saved = body; return {}; }
  };
  const view = mountBiliPanel(root, { api, tenantId: 't', toast }); await settle();
  const boxes = root.querySelectorAll('input[type="checkbox"]');
  boxes[3].checked = true;
  findByText(root, 'button', '保存 B 站配置').click(); await settle();
  assert.deepEqual(saved.upMids, ['12']);
  assert.deepEqual(saved.liveRoomIds, ['34']);
  assert.equal(saved.subscriptions.liveRooms, true);
  view.destroy();
});

test('扩展显示外部名称为文本，管理员可恢复屏蔽项', async () => {
  const { root } = setup(); let restored = '';
  const api = {
    getExtensions: async () => ({ extensions: [{ id: 'x', name: '<script>bad</script>', blocked: true }] }),
    getExtensionCatalog: async () => ({ items: [] }),
    restoreExtension: async (_id, extId) => { restored = extId; return {}; }
  };
  const view = mountExtensionManager(root, { api, tenantId: 't', admin: true, toast });
  await settle();
  assert.equal(root.querySelector('script'), null);
  assert.match(root.textContent, /<script>bad<\/script>/);
  findByText(root, 'button', '恢复内置扩展').click(); await settle();
  assert.equal(restored, 'x');
  view.destroy();
});

test('卸载覆盖内置扩展时可选择回退与清理配置', async () => {
  const { root, modalRoot } = setup(); let removed;
  const api = {
    getExtensions: async () => ({ extensions: [{ id: 'x', name: '扩展', source: 'admin', builtin: true }] }),
    getExtensionCatalog: async () => ({ items: [] }),
    removeExtension: async (...args) => { removed = args; return {}; }
  };
  const view = mountExtensionManager(root, { api, tenantId: 't', admin: true, modalRoot, toast });
  await settle(); findByText(root, 'button', '从实例移除').click();
  const options = modalRoot.querySelectorAll('input[type="checkbox"]');
  assert.equal(options.length, 2);
  options[0].checked = true; options[1].checked = true;
  findByText(modalRoot, 'button', '确认移除').click(); await settle();
  assert.deepEqual(removed, ['t', 'x', { cleanConfig: true, fallback: true }]);
  view.destroy();
});
