import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, flush, findByText } from './helpers/dom-stub.mjs';

test('普通用户启动与手动切换管理路由时保持用户视图', async () => {
  const document = installDom();
  const ids = ['boot-screen', 'boot-status', 'login-root', 'app-shell', 'view-root', 'sidebar', 'sidebar-toggle', 'sidebar-scrim', 'tenant-nav', 'platform-nav', 'user-nav', 'side-tenants', 'brand-link', 'nav-hosting', 'nav-relay', 'page-title', 'breadcrumb', 'user-avatar', 'user-name', 'user-role', 'logout-btn', 'theme-toggle', 'modal-root', 'toast-root'];
  for (const id of ids) { const el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
  const listeners = {};
  globalThis.window = { addEventListener: (name, callback) => { listeners[name] = callback; }, scrollTo() {} };
  globalThis.localStorage = { setItem() {} };
  globalThis.location = { hash: '', origin: 'http://localhost' };
  const calls = [];
  const tenants = [{ id: 't1', name: '鱼一', role: 'owner' }, { id: 't2', name: '鱼二', role: 'owner' }];
  globalThis.fetch = async (path) => {
    calls.push(path);
    const payload = path === '/api/me' ? { user: { id: 'u', username: 'u', role: 'user' } }
      : path === '/api/tenants' ? { tenants }
        : path === '/api/tenants/t2' ? { tenant: tenants[1], role: 'owner' } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), headers: { get: () => null } };
  };
  await import('../app.js');
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(location.hash, '#/user/instances');
  listeners.hashchange();
  for (let i = 0; i < 5; i++) await flush();
  assert.match(document.getElementById('view-root').textContent, /我的鱼/);
  assert.equal(document.getElementById('platform-nav').hidden, true);
  location.hash = '#/tenants/t1/hosting'; listeners.hashchange();
  assert.equal(location.hash, '#/user/instances');
  listeners.hashchange(); await flush();
  assert.match(document.getElementById('view-root').textContent, /我的鱼/);
  location.hash = '#/user/instances/t2'; listeners.hashchange();
  for (let i = 0; i < 5; i++) await flush();
  const link = findByText(document.getElementById('view-root'), 'a', '渠道配置');
  assert.ok(link); link.click();
  location.hash = '#/user/channel'; listeners.hashchange();
  for (let i = 0; i < 5; i++) await flush();
  assert.ok(calls.includes('/api/tenants/t2/relay/overview'));
  assert.ok(calls.includes('/api/tenants/t2/relay/custom'));
  assert.ok(!calls.includes('/api/tenants/t1/relay/overview'));
});
