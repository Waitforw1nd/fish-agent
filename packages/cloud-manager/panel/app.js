// Fish Cloud 平台面板入口：登录态、哈希路由、侧栏/主题、视图生命周期。

import { createApi } from './lib/api.js';
import { closeAllModals } from './lib/modal.js';
import { normalizeMe } from './lib/normalize.js';
import { canAccessRoute, defaultRouteForUser, isAdminUser, isUserRoute, parseRoute, routeTitle } from './lib/router.js';
import { clear, h, setHidden, setText } from './lib/dom.js';
import { initials } from './lib/format.js';
import { apiErrorMessage } from './lib/view-data.js';
import { createToast } from './lib/toast.js';
import { errorBlock, emptyBlock, pageHead } from './lib/ui.js';
import { mountLogin } from './views/login.js';
import { mountTenants } from './views/tenants.js';
import { mountHosting } from './views/hosting.js';
import { mountRelay } from './views/relay.js';
import { mountUsers } from './views/users.js';
import { mountUserTenants } from './views/user-tenants.js';
import { mountUserInstances } from './views/user/instances.js';
import { mountUserInstance } from './views/user/instance.js';
import { normalizeUserTenants } from './views/user/shared.js';
import { mountUserChannel } from './views/user/channel.js';
import { mountUserLogs } from './views/user/logs.js';
import { mountUserBilling } from './views/user/billing.js';

const els = {
  boot: document.getElementById('boot-screen'),
  bootStatus: document.getElementById('boot-status'),
  loginRoot: document.getElementById('login-root'),
  appShell: document.getElementById('app-shell'),
  viewRoot: document.getElementById('view-root'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  tenantNav: document.getElementById('tenant-nav'),
  platformNav: document.getElementById('platform-nav'),
  userNav: document.getElementById('user-nav'),
  sideTenants: document.getElementById('side-tenants'),
  brandLink: document.getElementById('brand-link'),
  navTenants: document.querySelector('[data-nav="tenants"]'),
  navHosting: document.getElementById('nav-hosting'),
  navRelay: document.getElementById('nav-relay'),
  pageTitle: document.getElementById('page-title'),
  breadcrumb: document.getElementById('breadcrumb'),
  userAvatar: document.getElementById('user-avatar'),
  userName: document.getElementById('user-name'),
  userRole: document.getElementById('user-role'),
  logout: document.getElementById('logout-btn'),
  themeToggle: document.getElementById('theme-toggle'),
  modalRoot: document.getElementById('modal-root'),
  toastRoot: document.getElementById('toast-root')
};

const toast = createToast(els.toastRoot);
const state = {
  me: null,
  tenants: [],
  tenantsError: '',
  userTenantId: '',
  route: parseRoute(location.hash),
  view: null,
  loginView: null,
  loginMounted: false,
  loggingOut: false
};

const api = createApi({ onUnauthorized: handleUnauthorized });

// ── 主题 / 侧栏 ──────────────────────────────────────────

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('fish-cloud-theme', next);
  } catch {
    // 隐私模式禁用 localStorage 时仅影响持久化
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#f1f5f0' : '#07121c');
  if (els.themeToggle) {
    els.themeToggle.title = next === 'light' ? '切换到深色主题' : '切换到浅色主题';
    els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
}

function setSidebar(open) {
  const next = Boolean(open);
  els.appShell?.classList.toggle('sidebar-open', next);
  setHidden(els.sidebarScrim, !next);
  els.sidebarToggle?.setAttribute('aria-expanded', next ? 'true' : 'false');
}

function closeSidebar() {
  setSidebar(false);
}

// ── 用户界面 ─────────────────────────────────────────────

function roleLabel(user) {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'superadmin' || user?.roles?.includes('admin')) return '平台管理员';
  if (role === 'owner' || role === 'tenant_owner') return '租户所有者';
  if (role === 'operator') return '运维';
  if (role === 'viewer' || role === 'readonly') return '只读账号';
  return role ? role : '平台用户';
}

function setUser(user) {
  if (!user) {
    setText(els.userName, '未登录');
    setText(els.userRole, '—');
    setText(els.userAvatar, 'F');
    return;
  }
  const name = user.displayName || user.username || '用户';
  setText(els.userName, name);
  setText(els.userRole, roleLabel(user));
  setText(els.userAvatar, initials(name));
}

// ── 启动 / 登录态 ────────────────────────────────────────

function showBoot(message = '正在连接云平台…') {
  setHidden(els.boot, false);
  setHidden(els.loginRoot, true);
  setHidden(els.appShell, true);
  setText(els.bootStatus, message);
}

function hideBoot() {
  setHidden(els.boot, true);
}

async function bootstrap() {
  showBoot('正在验证平台会话…');
  try {
    const payload = await api.me();
    const raw = payload && typeof payload === 'object' ? (payload.user || payload) : null;
    if (!raw || (!raw.id && !raw.username && !raw.name && !raw.email && !raw.role)) {
      hideBoot();
      showLogin({ notice: '会话无效，请重新登录。' });
      return;
    }
    const user = normalizeMe(payload);
    await enterApp(user);
  } catch (error) {
    if (error?.isAuthExpired) {
      hideBoot();
      showLogin();
      return;
    }
    hideBoot();
    showLogin({
      notice: apiErrorMessage(error, { fallback: '无法连接云平台，请稍后重试。' }),
      onRetry: () => { void bootstrap(); }
    });
  }
}

async function enterApp(user) {
  state.me = user;
  state.loginMounted = false;
  state.loginView?.destroy?.();
  state.loginView = null;
  els.loginRoot.replaceChildren();
  setHidden(els.loginRoot, true);
  setHidden(els.appShell, false);
  setHidden(els.boot, true);
  setUser(user);
  closeAllModals();
  await refreshTenants();
  if (!state.me) return;
  const route = parseRoute(location.hash);
  state.route = route;
  if (route.name === 'login' || !location.hash || !canAccessRoute(route, state.me)) {
    navigate(defaultRouteForUser(state.me));
    return;
  }
  renderRoute();
}

function showLogin({ notice = '', onRetry = null } = {}) {
  if (state.loginMounted && state.me === null && notice) {
    // 已显示登录页时仅刷新提示，避免重复挂载丢输入
    const existing = els.loginRoot.querySelector?.('.form-error');
    if (existing) {
      existing.textContent = notice;
      existing.hidden = false;
      return;
    }
  }
  state.me = null;
  state.tenants = [];
  state.tenantsError = '';
  state.userTenantId = '';
  state.view?.destroy?.();
  state.view = null;
  clear(els.viewRoot);
  closeAllModals();
  closeSidebar();
  setHidden(els.appShell, true);
  setHidden(els.boot, true);
  setHidden(els.loginRoot, false);
  setUser(null);
  setText(els.pageTitle, '登录');
  clear(els.breadcrumb);
  document.title = '登录 · Fish Cloud';
  state.loginView?.destroy?.();
  state.loginView = mountLogin({
    root: els.loginRoot,
    api,
    toast,
    notice,
    onRetry,
    onSuccess: async (user) => {
      state.authNotice = '';
      await enterApp(user);
    }
  });
  state.loginMounted = true;
  state.route = parseRoute(location.hash);
}

function handleUnauthorized(error) {
  if (state.me === null) return;
  state.me = null;
  state.loginMounted = false;
  state.view?.destroy?.();
  state.view = null;
  const message = '登录状态已过期，请重新登录。';
  state.authNotice = message;
  showLogin({ notice: message });
  toast.show(message, { tone: 'danger' });
}

async function logout() {
  if (state.loggingOut) return;
  state.loggingOut = true;
  try {
    await api.logout();
  } catch {
    // 会话可能已经失效；本地仍然退出
  } finally {
    state.loggingOut = false;
  }
  state.me = null;
  state.tenants = [];
  state.loginMounted = false;
  if (location.hash !== '#/login') {
    location.hash = '#/login';
  }
  showLogin();
  toast.show('已退出登录', { tone: 'info' });
}

// ── 租户数据 / 侧栏 ──────────────────────────────────────

async function refreshTenants() {
  try {
    const payload = await api.listTenants();
    if (!state.me) return;
    state.tenants = normalizeUserTenants(payload);
    state.tenantsError = '';
  } catch (error) {
    if (!state.me) return;
    state.tenants = [];
    state.tenantsError = apiErrorMessage(error, { fallback: '租户列表加载失败。' });
    if (error?.isAuthExpired) return;
  }
  if (!findTenant(state.userTenantId)) state.userTenantId = state.tenants[0]?.id || '';
  updateTenantNav();
  updateChrome(state.route);
}

function findTenant(id) {
  return state.tenants.find((tenant) => tenant.id === id) || null;
}

function updateTenantNav() {
  clear(els.tenantNav);
  if (!state.tenants.length) {
    els.tenantNav.appendChild(h('p', { class: 'side-hint' },
      state.tenantsError || h('a', { href: '#/tenants' }, '创建第一个租户 →')
    ));
    return;
  }
  for (const tenant of state.tenants) {
    const active = state.route.tenantId === tenant.id;
    const link = h('a', {
      class: `tenant-nav-link${active ? ' active' : ''}`,
      href: `#/tenants/${encodeURIComponent(tenant.id)}/hosting`,
      title: `${tenant.name} · ${tenant.statusLabel}`,
      dataset: { tenantId: tenant.id }
    },
      h('span', { class: 'status-dot', dataset: { tone: tenant.statusTone }, 'aria-hidden': 'true' }),
      h('span', { class: 'tenant-nav-name' }, tenant.name)
    );
    link.addEventListener('click', closeSidebar);
    els.tenantNav.appendChild(link);
  }
}

function updateSideNav(selectedId) {
  const admin = isAdminUser(state.me);
  const hasTenant = Boolean(selectedId);
  setHidden(els.platformNav, !admin);
  setHidden(els.sideTenants, !admin);
  setHidden(els.userNav, false);
  els.brandLink?.setAttribute('href', defaultRouteForUser(state.me));
  if (els.navHosting) {
    els.navHosting.setAttribute('href', hasTenant ? `#/tenants/${encodeURIComponent(selectedId)}/hosting` : '#/tenants');
    els.navHosting.setAttribute('aria-disabled', hasTenant ? 'false' : 'true');
    els.navHosting.classList.toggle('active', state.route.name === 'hosting');
  }
  if (els.navRelay) {
    els.navRelay.setAttribute('href', hasTenant ? `#/tenants/${encodeURIComponent(selectedId)}/relay` : '#/tenants');
    els.navRelay.setAttribute('aria-disabled', hasTenant ? 'false' : 'true');
    els.navRelay.classList.toggle('active', state.route.name === 'relay');
  }
  els.navTenants?.classList.toggle('active', state.route.name === 'tenants');
  for (const link of els.platformNav?.querySelectorAll?.('[data-nav="users"]') || []) {
    link.classList.toggle('active', ['users', 'userTenants'].includes(state.route.name));
  }
  for (const link of els.userNav?.querySelectorAll?.('[data-nav]') || []) {
    link.classList.toggle('active', link.dataset.nav === state.route.name || (link.dataset.nav === 'userInstances' && state.route.name === 'userInstance'));
  }
}

// ── 顶栏 / 面包屑 ────────────────────────────────────────

function updateChrome(route = state.route) {
  const tenant = route.tenantId ? findTenant(route.tenantId) : null;
  const tenantName = tenant?.name || '租户';
  updateSideNav(route.tenantId || state.tenants[0]?.id || '');
  updateTenantNavActive(route.tenantId);

  let title = routeTitle(route, tenantName);
  if (route.name === 'hosting') title = tenant ? `${tenant.name} · Hosting Center` : 'Hosting Center';
  if (route.name === 'relay') title = tenant ? `${tenant.name} · Relay & Billing` : 'Relay & Billing';
  setText(els.pageTitle, title);
  document.title = `${title} · Fish Cloud`;

  clear(els.breadcrumb);
  const sep = () => h('span', { class: 'sep' }, '/');
  if (route.name === 'tenants') {
    els.breadcrumb.appendChild(h('span', {}, '平台'));
    els.breadcrumb.appendChild(sep());
    els.breadcrumb.appendChild(h('span', {}, '租户总览'));
  } else if (route.name === 'users' || route.name === 'userTenants') {
    if (route.name === 'users') els.breadcrumb.appendChild(h('span', {}, '用户管理'));
    else {
      els.breadcrumb.appendChild(h('a', { href: '#/users' }, '用户管理'));
      els.breadcrumb.appendChild(sep());
      els.breadcrumb.appendChild(h('span', {}, '用户实例'));
    }
  } else if (route.name === 'hosting' || route.name === 'relay') {
    els.breadcrumb.appendChild(h('a', { href: '#/tenants' }, '租户总览'));
    els.breadcrumb.appendChild(sep());
    els.breadcrumb.appendChild(h('a', { href: `#/tenants/${encodeURIComponent(route.tenantId)}/hosting` }, tenantName));
    els.breadcrumb.appendChild(sep());
    els.breadcrumb.appendChild(h('span', {}, route.name === 'relay' ? 'Relay & Billing' : 'Hosting Center'));
  } else if (route.name === 'notFound') {
    els.breadcrumb.appendChild(h('a', { href: '#/tenants' }, '租户总览'));
    els.breadcrumb.appendChild(sep());
    els.breadcrumb.appendChild(h('span', {}, '页面不存在'));
  }
}

function updateTenantNavActive(tenantId) {
  for (const link of els.tenantNav.querySelectorAll?.('.tenant-nav-link') || []) {
    link.classList.toggle('active', link.dataset.tenantId === tenantId);
  }
}

// ── 路由 ─────────────────────────────────────────────────

function navigate(hash) {
  if (location.hash === hash) {
    state.route = parseRoute(hash);
    renderRoute();
    return;
  }
  location.hash = hash;
}

function renderRoute() {
  if (!state.me) {
    if (!state.loginMounted) showLogin();
    return;
  }
  if (state.route.name === 'login' || !canAccessRoute(state.route, state.me)) {
    navigate(defaultRouteForUser(state.me));
    return;
  }
  closeAllModals();
  closeSidebar();
  state.view?.destroy?.();
  state.view = null;
  clear(els.viewRoot);
  updateChrome(state.route);

  const common = {
    root: els.viewRoot,
    api,
    toast,
    navigate,
    modalRoot: els.modalRoot
  };

  try {
    if (state.route.name === 'tenants') {
      state.view = mountTenants({
        ...common,
        onTenantsChanged: (list) => {
          state.tenants = list;
          state.tenantsError = '';
          updateChrome(state.route);
        }
      });
    } else if (state.route.name === 'users') {
      state.view = mountUsers(els.viewRoot, { ...common, refreshTenants });
    } else if (state.route.name === 'userTenants') {
      state.view = mountUserTenants(els.viewRoot, { ...common, userId: state.route.userId, refreshTenants, onTenantsChanged: () => { void refreshTenants(); } });
    } else if (state.route.name === 'hosting') {
      if (!state.route.tenantId) {
        navigate('#/tenants');
        return;
      }
      state.view = mountHosting({
        ...common,
        tenantId: state.route.tenantId
      });
    } else if (state.route.name === 'relay') {
      if (!state.route.tenantId) {
        navigate('#/tenants');
        return;
      }
      state.view = mountRelay({
        ...common,
        tenantId: state.route.tenantId
      });
    } else if (state.route.name === 'userInstances') {
      state.view = mountUserInstances({ ...common, onTenantsChanged: (list) => {
        state.tenants = list;
        state.tenantsError = '';
        if (!findTenant(state.userTenantId)) state.userTenantId = list[0]?.id || '';
        updateChrome(state.route);
      } });
    } else if (state.route.name === 'userInstance') {
      state.userTenantId = state.route.tenantId;
      state.view = mountUserInstance({ ...common, tenantId: state.route.tenantId, onSelectTenant: (id) => { state.userTenantId = id; } });
    } else if (isUserRoute(state.route)) {
      const options = {
        ...common, tenants: state.tenants, tenantId: state.userTenantId, tenantsError: state.tenantsError,
        retryTenants: async () => { await refreshTenants(); if (state.me) renderRoute(); },
        onTenantChange: (id) => { state.userTenantId = id; renderRoute(); }
      };
      const mount = { userChannel: mountUserChannel, userLogs: mountUserLogs, userBilling: mountUserBilling }[state.route.name];
      state.view = mount(options);
    } else {
      state.view = mountNotFound();
    }
  } catch (error) {
    clear(els.viewRoot);
    els.viewRoot.appendChild(errorBlock({
      title: '页面加载失败',
      message: apiErrorMessage(error, { fallback: '页面渲染出现异常。' }),
      onRetry: () => renderRoute()
    }));
  }
  els.viewRoot.scrollTop = 0;
  try {
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch {
    // 部分嵌入环境不支持 scrollTo 选项
  }
}

function mountNotFound() {
  clear(els.viewRoot);
  const head = pageHead({
    eyebrow: '404',
    title: '页面不存在',
    sub: '地址可能已失效，或该页面不属于当前面板。'
  });
  const empty = emptyBlock({
    title: '找不到这个页面',
    message: '返回租户总览继续操作。',
    symbol: '?',
    actions: h('a', { class: 'btn btn-primary', href: '#/tenants' }, '返回租户总览')
  });
  els.viewRoot.appendChild(head);
  els.viewRoot.appendChild(empty);
  return { destroy() {} };
}

// ── 事件绑定 ─────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  state.route = parseRoute(location.hash);
  if (!state.me) {
    if (!state.loginMounted) showLogin();
    return;
  }
  renderRoute();
});

els.logout?.addEventListener('click', () => { void logout(); });
els.themeToggle?.addEventListener('click', toggleTheme);
els.sidebarToggle?.addEventListener('click', () => {
  setSidebar(!els.appShell.classList.contains('sidebar-open'));
});
els.sidebarScrim?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSidebar();
});
for (const link of [els.navTenants, els.navHosting, els.navRelay]) {
  link?.addEventListener('click', closeSidebar);
}

applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
void bootstrap();
