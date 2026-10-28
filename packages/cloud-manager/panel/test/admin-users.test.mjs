import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRoot, findByText, flush, installDom } from './helpers/dom-stub.mjs';
import { mountUsers } from '../views/users.js';
import { mountUserTenants } from '../views/user-tenants.js';

const settle = async () => { await flush(); await flush(); };
const setup = () => appendRoot(installDom());

test('用户列表安全呈现、进入实例、校验并创建用户', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  const api = {
    getUsers: async () => ({ users: [{ id: 'u/1', username: '<Alice>', role: 'user' }] }),
    createUser: async (body) => { calls.push(body); return { ok: true }; }
  };
  const view = mountUsers(root, { api, modalRoot });
  await settle();
  assert.match(root.textContent, /<Alice>/);
  assert.equal(root.querySelectorAll('alice').length, 0);
  assert.equal(findByText(root, 'a', '查看拥有').href, '#/users/u%2F1/instances');
  findByText(root, 'button', '创建用户').click();
  const submit = findByText(modalRoot, 'button', '创建用户');
  submit.click();
  assert.match(modalRoot.textContent, /用户名需为/);
  modalRoot.querySelector('#admin-create-username').value = ' alice ';
  modalRoot.querySelector('#admin-create-password').value = 'password123';
  submit.click();
  await settle();
  assert.deepEqual(calls, [{ username: 'alice', password: 'password123', role: 'user' }]);
  assert.equal(modalRoot.querySelector('.modal-backdrop'), null);
  view.destroy();
});

test('指定用户实例显示、链接与创建请求携带所有者和套餐', async () => {
  const { root, modalRoot } = setup();
  const calls = [];
  let tenants = [{ id: 't/1', name: 'Alice 的鱼', status: 'running' }];
  const api = {
    getUserTenants: async (id) => { calls.push(['getUserTenants', id]); return { ok: true, user: { id, username: 'alice' }, tenants }; },
    getPlans: async () => ({ plans: [{ id: 'trial', name: '体验', maxTenants: 1 }, { id: 'pro', name: '专业', maxTenants: 10 }] }),
    createTenant: async (body) => { calls.push(['createTenant', body]); tenants = [...tenants, { id: 't2', name: body.name, status: 'stopped' }]; }
  };
  let changed = 0;
  const view = mountUserTenants(root, { api, userId: 'alice-id', modalRoot, onTenantsChanged: () => { changed++; } });
  await settle();
  assert.match(root.textContent, /Alice 的鱼/);
  assert.match(root.textContent, /运行中/);
  assert.equal(findByText(root, 'a', 'Hosting').href, '#/tenants/t%2F1/hosting');
  assert.equal(findByText(root, 'a', 'Relay').href, '#/tenants/t%2F1/relay');
  findByText(root, 'button', '创建实例').click();
  await settle();
  assert.match(modalRoot.textContent, /限额 10 个实例/);
  modalRoot.querySelector('#admin-instance-name').value = '新鱼';
  modalRoot.querySelector('#admin-instance-plan').value = 'pro';
  findByText(modalRoot, 'button', '创建实例').click();
  await settle();
  assert.deepEqual(calls.find(([method]) => method === 'createTenant')[1], { name: '新鱼', ownerUserId: 'alice-id', planId: 'pro' });
  assert.match(root.textContent, /新鱼/);
  assert.equal(changed, 1);
  assert.ok(calls.filter(([method]) => method === 'getUserTenants').every(([, id]) => id === 'alice-id'));
  view.destroy();
});

test('空实例、套餐错误和卸载时关闭弹窗并忽略迟到响应', async () => {
  const { root, modalRoot } = setup();
  let resolvePlans;
  const api = {
    getUserTenants: async () => ({ user: { id: 'u', username: 'bob' }, tenants: [] }),
    getPlans: () => new Promise((resolve) => { resolvePlans = resolve; }),
    createTenant: () => { throw new Error('不应创建'); }
  };
  const view = mountUserTenants(root, { api, userId: 'u', modalRoot });
  await settle();
  assert.match(root.textContent, /还没有拥有的实例/);
  findByText(root, 'button', '创建实例').click();
  assert.equal(findByText(modalRoot, 'button', '创建实例').disabled, true);
  view.destroy();
  resolvePlans({ plans: [{ id: 'trial' }] });
  await settle();
  assert.equal(modalRoot.querySelector('.modal-backdrop'), null);
  assert.equal(root.textContent, '');
});

test('用户实例错误可重试，套餐加载失败时禁止创建', async () => {
  const { root, modalRoot } = setup();
  let attempts = 0;
  const api = {
    getUserTenants: async () => { if (++attempts === 1) throw Object.assign(new Error('not found'), { status: 404 }); return { user: { id: 'u', username: 'bob' }, tenants: [] }; },
    getPlans: async () => { throw new Error('不可用'); }
  };
  const view = mountUserTenants(root, { api, userId: 'u', modalRoot });
  await settle();
  assert.match(root.textContent, /用户实例加载失败/);
  findByText(root, 'button', '重试').click();
  await settle();
  findByText(root, 'button', '创建实例').click();
  await settle();
  assert.match(modalRoot.textContent, /套餐加载失败/);
  assert.equal(findByText(modalRoot, 'button', '创建实例').disabled, true);
  view.destroy();
});
