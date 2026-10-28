// 表单校验纯函数：视图与测试共用同一套规则。

const RESERVED_SLUGS = new Set(['www', 'api', 'admin', 'panel', 'app', 'mail', 'static', 'relay', 'login', 'auth', 'console']);

export function validateUin(value) {
  const uin = String(value ?? '').trim();
  if (!/^\d{5,12}$/.test(uin)) {
    return { ok: false, error: 'QQ 号需为 5-12 位数字', value: uin };
  }
  return { ok: true, error: null, value: uin };
}

export function validateLoginInput({ username, password } = {}) {
  const user = String(username ?? '').trim();
  const pass = String(password ?? '');
  if (!user) return '请输入用户名';
  if (user.length > 128) return '用户名过长';
  if (!pass) return '请输入密码';
  if (pass.length > 512) return '密码过长';
  return null;
}

export function validateTenantInput({ name, slug } = {}) {
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  const cleanSlug = String(slug ?? '').trim().toLowerCase();
  const errors = {};
  if (!cleanName) errors.name = '请输入租户名称';
  else if (cleanName.length > 80) errors.name = '租户名称最多 80 个字符';
  if (/[\u0000-\u001f\u007f]/.test(cleanName)) errors.name = '租户名称包含非法字符';

  if (cleanSlug) {
    if (cleanSlug.length < 2 || cleanSlug.length > 32) errors.slug = '子域名需为 2–32 个字符';
    else if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(cleanSlug)) errors.slug = '仅允许小写字母、数字与中划线，且不能以中划线开头/结尾';
    else if (RESERVED_SLUGS.has(cleanSlug)) errors.slug = '该子域名已被平台保留';
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: { name: cleanName, slug: cleanSlug }
  };
}

export function suggestSlug(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

export function validateRelayInput({ key, model } = {}, { configured = false } = {}) {
  const cleanKey = String(key ?? '').trim();
  const cleanModel = String(model ?? '').trim();
  if (cleanKey && cleanKey.length < 6) return { ok: false, error: 'Relay Key 至少 6 个字符' };
  if (cleanKey.length > 512) return { ok: false, error: 'Relay Key 过长' };
  if (/[\u0000-\u001f\u007f\s]/.test(cleanKey)) return { ok: false, error: 'Relay Key 不能包含空白或控制字符' };
  if (!cleanKey && !cleanModel) {
    return { ok: false, error: configured ? '请输入新 Key 或选择默认模型' : '请输入 Relay Key，或选择一个模型由平台签发' };
  }
  const payload = {};
  if (cleanKey) payload.key = cleanKey;
  if (cleanModel) payload.model = cleanModel;
  return { ok: true, error: null, payload };
}
