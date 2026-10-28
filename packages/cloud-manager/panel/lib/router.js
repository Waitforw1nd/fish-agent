// 哈希路由：面板可挂在平台根路径或 /panel/ 下，不依赖服务端重写。

const USER_ROUTES = {
  instances: { name: 'userInstances', path: '#/user/instances', title: '我的鱼' },
  channel: { name: 'userChannel', path: '#/user/channel', title: '渠道 Key' },
  logs: { name: 'userLogs', path: '#/user/logs', title: '调用日志' },
  billing: { name: 'userBilling', path: '#/user/billing', title: '充值' }
};

export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const clean = path.replace(/\/+$/, '') || '/';
  const parts = clean.split('/').filter(Boolean).map(decodePart);
  if (!parts.length) return { name: 'tenants', path: '#/tenants' };
  if (parts[0] === 'login') return { name: 'login', path: '#/login' };
  if (parts[0] === 'user') {
    if (parts.length === 1) return { ...USER_ROUTES.instances };
    const route = USER_ROUTES[parts[1]];
    if (parts[1] === 'instances' && parts.length === 3 && parts[2]) return { name: 'userInstance', tenantId: parts[2], path: routeToHash({ name: 'userInstance', tenantId: parts[2] }) };
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
  if (section === 'hosting') return { name: 'hosting', tenantId, path: routeToHash({ name: 'hosting', tenantId }) };
  if (section === 'relay') return { name: 'relay', tenantId, path: routeToHash({ name: 'relay', tenantId }) };
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
  if (route.name === 'userInstance') return route.tenantId ? `#/user/instances/${encodeURIComponent(route.tenantId)}` : '#/user/instances';
  const userRoute = Object.values(USER_ROUTES).find((item) => item.name === route.name);
  if (userRoute) return userRoute.path;
  if (route.name === 'hosting' || route.name === 'relay') {
    const id = encodeURIComponent(String(route.tenantId ?? ''));
    if (!id) return '#/tenants';
    return route.name === 'relay' ? `#/tenants/${id}/relay` : `#/tenants/${id}/hosting`;
  }
  return '#/tenants';
}

export function tenantHash(tenantId, section = 'hosting') {
  return routeToHash({ name: section === 'relay' ? 'relay' : 'hosting', tenantId });
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
  return isAdminUser(user) ? '#/tenants' : '#/user/instances';
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
  const userRoute = Object.values(USER_ROUTES).find((item) => item.name === route?.name);
  if (userRoute) return userRoute.title;
  return '页面不存在';
}
