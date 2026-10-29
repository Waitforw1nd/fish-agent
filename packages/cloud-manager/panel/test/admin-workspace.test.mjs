import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRoot, findByText, fire, flush, installDom } from './helpers/dom-stub.mjs';
import { mountRecharges } from '../views/admin/recharges.js';
import { mountPlatform } from '../views/admin/platform.js';
import { mountAudit } from '../views/admin/audit.js';
import { mountOverview } from '../views/admin/overview.js';
import { mountExtensions } from '../views/admin/extensions.js';
import { mountUsers } from '../views/users.js';
import { mountTenants } from '../views/tenants.js';

const settle = async () => { for (let index = 0; index < 5; index++) await flush(); };
const setup = () => appendRoot(installDom());

test('充值审核要求驳回说明、确认携带备注，外部内容只作为文本渲染', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  let status = 'pending';
  const api = { async request(path, options) {
    calls.push({ path, ...options });
    if (options?.method === 'POST') { status = path.endsWith('/reject') ? 'rejected' : 'confirmed'; return { ok: true }; }
    return { recharges: [{ id: 'r/1', tenantId: 't1', tenantName: '<img src=x>', createdByUsername: '<script>bad</script>', amountMicros: 1500000, status, reviewNote: status === 'rejected' ? '未收到款项' : '' }] };
  } };
  const view = mountRecharges(root, { api, modalRoot });
  await settle();
  assert.equal(root.querySelectorAll('img').length, 0);
  findByText(root, 'button', '驳回').click();
  findByText(modalRoot, 'button', '驳回申请').click();
  await settle();
  assert.match(modalRoot.textContent, /请填写驳回原因/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  modalRoot.querySelector('#recharge-review-note').value = '未收到款项';
  findByText(modalRoot, 'button', '驳回申请').click();
  await settle();
  assert.deepEqual(calls.find((call) => call.method === 'POST'), { path: '/api/admin/recharges/r%2F1/reject', method: 'POST', body: { note: '未收到款项' } });
  assert.match(root.textContent, /未收到款项/);
  status = 'pending';
  await view.reload();
  findByText(root, 'button', '确认到账').click();
  modalRoot.querySelector('#recharge-review-note').value = '收款已核对';
  findByText(modalRoot, 'button', '确认到账').click();
  await settle();
  assert.equal(calls.at(-2).body.note, '收款已核对');
  view.destroy();
});

test('平台上游保存时空 Key 不覆盖已有密钥，LLBot Token 保存后不再显示', async () => {
  const { root } = setup();
  const calls = [];
  const api = { async request(path, options) {
    calls.push({ path, ...options });
    if (path.endsWith('/upstream')) return { upstream: { baseUrl: 'https://model.example/v1', configured: true } };
    if (path.endsWith('/drivers')) return { drivers: [{ id: 'napcat', available: false, reason: '<docker missing>' }] };
    return { hasToken: true };
  } };
  const view = mountPlatform(root, { api });
  await settle();
  const key = root.querySelector('#platform-upstream-key');
  assert.equal(key.value, '');
  fire(findByText(root, 'button', '保存上游').parentElement.parentElement, 'submit');
  await settle();
  const saved = calls.find((call) => call.method === 'PUT');
  assert.deepEqual(saved.body, { baseUrl: 'https://model.example/v1' });
  root.querySelector('#platform-llbot-token').value = 'new-private-token';
  fire(root.querySelector('#platform-llbot-token').parentElement.parentElement, 'submit');
  await settle();
  assert.equal(calls.filter((call) => call.method === 'PUT').at(-1).body.token, 'new-private-token');
  assert.equal(root.querySelector('#platform-llbot-token').value, '');
  assert.doesNotMatch(root.textContent, /new-private-token/);
  view.destroy();
});

test('用户筛选、最后管理员保护和密码重置提交', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  const api = {
    getUsers: async () => ({ users: [{ id: 'a', username: 'admin', role: 'admin' }, { id: 'u', username: 'alice', role: 'user', tenantCount: 3 }] }),
    updateUser: async (id, body) => { calls.push({ id, body }); }
  };
  const view = mountUsers(root, { api, modalRoot });
  await settle();
  assert.equal(findByText(root.querySelectorAll('article')[0], 'button', '禁用账号').disabled, true);
  const search = root.querySelector('#admin-user-search');
  search.value = 'alice';
  fire(search, 'input');
  assert.doesNotMatch(root.textContent, /ID: a\b/);
  assert.match(root.textContent, /拥有实例：3/);
  findByText(root, 'button', '重置密码').click();
  modalRoot.querySelector('#admin-reset-password').value = 'new-password';
  findByText(modalRoot, 'button', '重置密码').click();
  await settle();
  assert.deepEqual(calls, [{ id: 'u', body: { password: 'new-password' } }]);
  view.destroy();
});

test('审计筛选传递参数并忽略销毁后的响应', async () => {
  const { root } = setup();
  const paths = [];
  let resolve;
  const api = { async request(path) {
    paths.push(path);
    if (paths.length > 1) return new Promise((callback) => { resolve = callback; });
    return { entries: [{ actorUsername: '<bob>', action: 'user.update', detail: '<img>', created_at: 1 }] };
  } };
  const view = mountAudit(root, { api });
  await settle();
  root.querySelector('#audit-tenantId').value = 't/1';
  root.querySelector('#audit-action').value = 'user.update';
  fire(root.querySelector('form'), 'submit');
  assert.match(paths.at(-1), /tenantId=t%2F1/);
  view.destroy();
  resolve({ entries: [{ action: 'late-data' }] });
  await settle();
  assert.equal(root.textContent, '');
});

test('插件批量分发显示逐实例错误而不把整批标记为成功', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  const api = {
    listTenants: async () => ({ tenants: [{ id: 't1', name: '第一实例' }, { id: 't2', name: '第二实例' }] }),
    async request(path, options) {
      calls.push({ path, ...options });
      if (options?.method === 'POST') return { results: [{ tenantId: 't1', ok: true }, { tenantId: 't2', ok: false, error: '插件加载失败' }] };
      return { items: [{ id: 'dice', name: '骰子插件', kind: 'plugin', version: '1.0', installedTenants: ['t1'], tenantCount: 1 }] };
    }
  };
  const view = mountExtensions(root, { api, modalRoot });
  await settle();
  findByText(root, 'button', '分发 / 升级').click();
  assert.match(modalRoot.querySelectorAll('.workspace-check-row')[0].textContent, /第一实例.*已安装/);
  assert.match(modalRoot.querySelectorAll('.workspace-check-row')[1].textContent, /第二实例.*未安装/);
  for (const box of modalRoot.querySelectorAll('input[type="checkbox"]')) { box.checked = true; fire(box, 'change'); }
  findByText(modalRoot, 'button', '分发到所选实例').click();
  await settle();
  assert.deepEqual(calls.find((call) => call.method === 'POST').body, { tenantIds: ['t1', 't2'] });
  assert.match(root.textContent, /1 个成功，1 个失败/);
  assert.match(root.textContent, /插件加载失败/);
  view.destroy();
});

test('运营总览使用待审计数和金额契约', async () => {
  const { root } = setup();
  const view = mountOverview(root, { api: { request: async () => ({ overview: { tenants: { total: 5, running: 2 }, users: { total: 3 }, pendingRecharges: { count: 2, amountMicros: 30000000 }, usage: { today: { totalTokens: 1200 }, last7Days: { totalTokens: 15000 } }, upstream: { configured: true }, drivers: [] } }) } });
  await settle();
  assert.match(root.textContent, /2 笔充值等待审核/);
  assert.match(root.textContent, /30/);
  assert.equal(findByText(root, 'a', '等待审核').href, '#/admin/recharges');
  view.destroy();
});

test('租户创建可指定用户、套餐和天数，并支持用户名筛选', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  const api = {
    listTenants: async () => ({ tenants: [{ id: 't1', name: '鱼', slug: 'fish', planId: 'trial', ownerUserId: 'alice' }] }),
    getUsers: async () => ({ users: [{ id: 'alice', username: 'Alice' }] }),
    createTenant: async (body) => { calls.push(body); return { tenant: { id: 'new', name: body.name } }; }
  };
  const view = mountTenants({ root, api, modalRoot });
  await settle();
  findByText(root, 'button', '创建租户').click();
  modalRoot.querySelector('#create-tenant-name').value = '新鱼';
  modalRoot.querySelector('#create-tenant-slug').value = 'new-fish';
  modalRoot.querySelector('#create-tenant-owner').value = 'alice';
  modalRoot.querySelector('#create-tenant-plan').value = 'pro';
  modalRoot.querySelector('#create-tenant-days').value = '90';
  findByText(modalRoot, 'button', '创建租户').click();
  await settle();
  assert.deepEqual(calls[0], { name: '新鱼', slug: 'new-fish', ownerUserId: 'alice', planId: 'pro', days: 90 });
  view.destroy();
});
