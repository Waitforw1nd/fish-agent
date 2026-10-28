import { now } from '../util.js';
import { transaction } from '../db.js';
import { resolveCustomUpstreamUrl } from './ssrf.js';

const SECRET_NAME = 'relay.custom.apiKey';

function inputError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export class CustomUpstreamService {
  constructor({ db, secrets, config }) {
    this.db = db;
    this.secrets = secrets;
    this.config = config;
    this.allowPrivate = config.relayCustomAllowPrivate === true;
  }

  row(tenantId) {
    return this.db.prepare('SELECT * FROM tenant_relay_custom WHERE tenant_id = ?').get(tenantId) || null;
  }

  get(tenantId) {
    const row = this.row(tenantId);
    if (!row) return { configured: false, source: 'platform' };
    return {
      configured: true,
      source: 'custom',
      baseUrl: row.base_url,
      model: row.model,
      apiKey: this.secrets.get(tenantId, SECRET_NAME, '')
    };
  }

  public(tenant) {
    const row = this.row(tenant.id);
    if (!row) {
      return {
        configured: false,
        baseUrl: null,
        model: tenant.default_model || this.config.defaultModel,
        hasKey: false,
        keyMasked: '',
        source: 'platform'
      };
    }
    const key = this.secrets.get(tenant.id, SECRET_NAME, '');
    return {
      configured: true,
      baseUrl: row.base_url,
      model: row.model,
      hasKey: Boolean(key),
      keyMasked: maskKey(key),
      source: 'custom'
    };
  }

  async update(tenant, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('INVALID_BODY', '请求体必须是对象');
    const previous = this.row(tenant.id);
    if (Object.hasOwn(body, 'apiKey')) {
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
        throw inputError('CUSTOM_UPSTREAM_KEY_REQUIRED', 'API Key 不能显式清空；缺省该字段可保留原 Key');
      }
      if (body.apiKey.length > 4096) throw inputError('INVALID_CUSTOM_UPSTREAM_KEY', 'API Key 不能超过 4096 字符');
    }
    const baseUrl = Object.hasOwn(body, 'baseUrl') ? body.baseUrl : previous?.base_url;
    const model = Object.hasOwn(body, 'model') ? body.model : previous?.model;
    if (typeof model !== 'string' || !model.trim() || model.trim().length > 200) {
      throw inputError('INVALID_CUSTOM_UPSTREAM_MODEL', '模型不能为空且不能超过 200 字符');
    }
    if (!previous && !Object.hasOwn(body, 'apiKey')) throw inputError('CUSTOM_UPSTREAM_KEY_REQUIRED', '首次配置自定义上游必须提供 API Key');
    const resolved = await resolveCustomUpstreamUrl(baseUrl, { allowPrivate: this.allowPrivate });
    const normalized = resolved.url.toString().replace(/\/+$/, '');
    const ts = now();
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO tenant_relay_custom (tenant_id, base_url, model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, updated_at = excluded.updated_at
      `).run(tenant.id, normalized, model.trim(), previous?.created_at || ts, ts);
      if (Object.hasOwn(body, 'apiKey')) this.secrets.set(tenant.id, SECRET_NAME, body.apiKey.trim());
    });
    return this.public(tenant);
  }

  delete(tenant) {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM tenant_relay_custom WHERE tenant_id = ?').run(tenant.id);
      this.secrets.delete(tenant.id, SECRET_NAME);
    });
    return this.public(tenant);
  }

  async resolve(baseUrl) {
    return resolveCustomUpstreamUrl(baseUrl, { allowPrivate: this.allowPrivate });
  }

  url(baseUrl, path) {
    const base = String(baseUrl).replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/${path}` : `${base}/v1/${path}`;
  }
}
