// 哈希路由：面板可挂在平台根路径或 /panel/ 下，不依赖服务端重写。

const USER_ROUTES = {
  instances: { name: 'userInstances', path: '#/user/instances', title: '我的鱼' },
  agent: { name: 'userAgent', path: '#/user/agent', title: 'QQ Agent 设置' },
  channel: { name: 'userChannel', path: '#/user/channel', title: '模型与渠道' },
  logs: { name: 'userLogs', path: '#/user/logs', title: '调用日志' },
  billing: { name: 'userBilling', path: '#/user/billing', title: '钱包与充值' }
};

const ADMIN_ROUTES = {
  overview: { name: 'adminOverview', path: '#/admin/overview', title: '运营总览' },
  extensions: { name: 'adminExtensions', path: '#/admin/extensions', title: '插件中心' },
  recharges: { name: 'adminRecharges', path: '#/admin/recharges', title: '充值审核' },
  platform: { name: 'adminPlatform', path: '#/admin/platform', title: '平台设置' },
  audit: { name: 'adminAudit', path: '#/admin/audit', title: '审计日志' }
};

export function parseRoute(hash) {
  const [raw, query = ''] = String(hash ?? '').replace(/^#/, '').split('?', 2);
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const clean = path.replace(/\/+$/, '') || '/';
  const parts = clean.split('/').filter(Boolean).map(decodePart);
  if (!parts.length) return { name: 'tenants', path: '#/tenants' };
  if (parts[0] === 'login') return { name: 'login', path: '#/login' };
  if (parts[0] === 'admin') {
    if (parts.length === 1) return { ...ADMIN_ROUTES.overview };
    return parts.length === 2 && ADMIN_ROUTES[parts[1]] ? { ...ADMIN_ROUTES[parts[1]] } : { name: 'notFound', path: `#${clean}` };
  }
  if (parts[0] === 'user') {
    if (parts.length === 1) return { ...USER_ROUTES.instances };
    const route = USER_ROUTES[parts[1]];
    if (parts[1] === 'instances' && parts.length === 3 && parts[2]) {
      const section = new URLSearchParams(query).get('tab');
      const route = { name: 'userInstance', tenantId: parts[2] };
      if (['overview', 'whitelist', 'persona', 'behavior', 'runtime'].includes(section)) route.section = section;
      return { ...route, path: routeToHash(route) };
    }
    if (route && parts.length === 2) return { ...route };
    return { name: 'notFound', path: `#${clean}` };
  }
  if (parts[0] === 'users') {
    if (parts.length === 1) return { name: 'users', path: '#/users' };
    if (parts.length === 3 && parts[1] && parts[2] === 'instances') return { name: 'userTenants', userId: parts[1], path: routeToHash({ name: 'userTenants', userId: parts[1] }) };
    return { name: 'notFound', path: `#${clean}` };
  }
  if (parts[0] !== 'tenants') return { name: 'notFound', path: `#${clean}` };
  if (parts.length === 1) return { name: 'tenants', path: '#/tenants' };
  const tenantId = parts[1];
  if (!tenantId) return { name: 'tenants', path: '#/tenants' };
  const section = parts[2] || 'hosting';
  if (parts.length > 3) return { name: 'notFound', path: `#${clean}` };
  if (section === 'hosting') return { name: 'hosting', tenantId, path: routeToHash({ name: 'hosting', tenantId }) };
  if (section === 'relay') return { name: 'relay', tenantId, path: routeToHash({ name: 'relay', tenantId }) };
  const names = { agent: 'tenantAgent', extensions: 'tenantExtensions', ops: 'tenantOps' };
  if (names[section]) return { name: names[section], tenantId, path: routeToHash({ name: names[section], tenantId }) };
  return { name: 'notFound', path: `#${clean}` };
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function routeToHash(route = {}) {
  if (route.name === 'login') return '#/login';
  if (route.name === 'tenants') return '#/tenants';
  if (route.name === 'users') return '#/users';
  if (route.name === 'userTenants') return route.userId ? `#/users/${encodeURIComponent(route.userId)}/instances` : '#/users';
  if (route.name === 'userInstance') {
    if (!route.tenantId) return '#/user/instances';
    const tab = ['overview', 'whitelist', 'persona', 'behavior', 'runtime'].includes(route.section) ? `?tab=${route.section}` : '';
    return `#/user/instances/${encodeURIComponent(route.tenantId)}${tab}`;
  }
  const userRoute = Object.values(USER_ROUTES).find((item) => item.name === route.name);
  if (userRoute) return userRoute.path;
  const adminRoute = Object.values(ADMIN_ROUTES).find((item) => item.name === route.name);
  if (adminRoute) return adminRoute.path;
  const sections = { hosting: 'hosting', relay: 'relay', tenantAgent: 'agent', tenantExtensions: 'extensions', tenantOps: 'ops' };
  if (sections[route.name]) {
    const id = encodeURIComponent(String(route.tenantId ?? ''));
    if (!id) return '#/tenants';
    return `#/tenants/${id}/${sections[route.name]}`;
  }
  return '#/tenants';
}

export function tenantHash(tenantId, section = 'hosting') {
  return routeToHash({ name: ({ relay: 'relay', agent: 'tenantAgent', extensions: 'tenantExtensions', ops: 'tenantOps' })[section] || 'hosting', tenantId });
}

export function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase();
  const roles = Array.isArray(user?.roles) ? user.roles.map((item) => String(item).toLowerCase()) : [];
  return ['admin', 'superadmin'].includes(role) || roles.some((item) => ['admin', 'superadmin'].includes(item));
}

export function isUserRoute(route) {
  return route?.name === 'userInstance' || Object.values(USER_ROUTES).some((item) => item.name === route?.name);
}

export function defaultRouteForUser(user) {
  return isAdminUser(user) ? '#/admin/overview' : '#/user/instances';
}

export function canAccessRoute(route, user) {
  if (route?.name === 'login') return true;
  return isAdminUser(user) || isUserRoute(route);
}

export function routeTitle(route, tenantName = '') {
  if (route?.name === 'login') return '登录';
  if (route?.name === 'tenants') return '租户总览';
  if (route?.name === 'users') return '用户管理';
  if (route?.name === 'userTenants') return '用户实例';
  if (route?.name === 'userInstance') return tenantName || '我的鱼';
  if (route?.name === 'hosting') return tenantName || 'Hosting Center';
  if (route?.name === 'relay') return tenantName ? `${tenantName} · Relay` : 'Relay & Billing';
  if (['tenantAgent', 'tenantExtensions', 'tenantOps'].includes(route?.name)) return tenantName || '租户管理';
  const adminRoute = Object.values(ADMIN_ROUTES).find((item) => item.name === route?.name);
  if (adminRoute) return adminRoute.title;
  const userRoute = Object.values(USER_ROUTES).find((item) => item.name === route?.name);
  if (userRoute) return userRoute.title;
  return '页面不存在';
}
