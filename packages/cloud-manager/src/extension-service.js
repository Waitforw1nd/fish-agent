import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateZipStructure } from '../../qq-agent-core/src/zip-install.js';
import { normalizeManifest, isManifestUsable, SKILL_API_VERSION } from '../../qq-agent-core/src/skills/manifest.js';
import { readBlockedExtensions } from '../../qq-agent-core/src/plugin-loader.js';
import { ensureDir } from './util.js';

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../qq-agent-core');
const VALID_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_ZIP = 8 * 1024 * 1024;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const SAFE_TYPES = new Set(['boolean', 'number', 'integer', 'string', 'select', 'enum']);
const UNSAFE_SETTING = /(?:url|endpoint|host|proxy|path|command|script|exec|token|key|cookie|secret|password)/i;

async function renameDirectory(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(source, target); return; }
    catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
      if (process.platform !== 'win32' || !transient || attempt >= 39
          || !fs.existsSync(source) || fs.existsSync(target)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function safeSkillStatus(value) {
  const result = { ...value };
  if (result.loadError) result.loadError = '扩展加载失败，请检查 Agent 日志';
  if (result.lastError) result.lastError = '扩展运行异常，请检查 Agent 日志';
  if (result.reason) {
    const reasons = {
      'skill-not-found': '扩展不存在', 'skill-not-loaded': '扩展加载失败', 'skill-disabled': '扩展未启用',
      'skill-unavailable': '扩展依赖不满足', 'skill-timeout': '扩展执行超时', 'capability-missing': '缺少所需能力'
    };
    result.reason = reasons[result.code] || '扩展当前不可用，请检查运行状态';
  }
  delete result.detail;
  return result;
}

export function safeVisibleSettings(values, schema) {
  const result = {};
  for (const [key, spec] of Object.entries(schema || {})) {
    if (!spec || spec.secret || UNSAFE_SETTING.test(key) || !SAFE_TYPES.has(String(spec.type || ''))) continue;
    const value = values?.[key];
    if (spec.type === 'boolean' && typeof value === 'boolean') result[key] = value;
    else if (['number', 'integer'].includes(spec.type) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (['string', 'select', 'enum'].includes(spec.type) && typeof value === 'string' && value.length <= 4000) result[key] = value;
  }
  return result;
}

function child(root, name) {
  const absolute = path.resolve(root, name);
  const rel = path.relative(path.resolve(root), absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw err(400, 'INVALID_EXTENSION_PATH', '扩展路径无效');
  return absolute;
}

function safeRemove(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw err(400, 'INVALID_EXTENSION_PATH', '扩展路径越界');
  fs.rmSync(target, { recursive: true, force: true });
}

function extensionId(value) {
  const id = String(value || '');
  if (!VALID_ID.test(id) || id === '.' || id === '..') throw err(400, 'INVALID_EXTENSION_ID', '扩展 ID 不合法');
  return id;
}

function parsePackage(body) {
  const encoded = body?.base64 ?? body?.dataBase64 ?? body?.data;
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_ZIP / 3) * 4
      || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw err(400, 'INVALID_EXTENSION_ZIP', 'ZIP 数据无效或超过 8 MiB');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > MAX_ZIP || buffer.toString('base64') !== encoded) throw err(400, 'INVALID_EXTENSION_ZIP', 'ZIP 编码无效');
  let entries;
  try { entries = validateZipStructure(buffer); }
  catch (error) { throw err(400, 'INVALID_EXTENSION_ZIP', error.message); }
  if (!entries.length) throw err(400, 'INVALID_EXTENSION_ZIP', '安装包为空');
  const prefix = entries[0].name.split('/')[0];
  const strip = entries.every((entry) => entry.name.startsWith(`${prefix}/`)) ? prefix.length + 1 : 0;
  const files = entries.map((entry) => ({ ...entry, name: entry.name.slice(strip) }));
  const manifests = files.filter((entry) => entry.name === 'plugin.json' || entry.name === 'skill.json');
  if (manifests.length !== 1) throw err(400, 'INVALID_EXTENSION_MANIFEST', '安装包必须包含一个根目录清单');
  let raw;
  try { raw = JSON.parse(manifests[0].data.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw err(400, 'INVALID_EXTENSION_MANIFEST', '扩展清单不是合法 JSON'); }
  const { manifest, problems } = normalizeManifest(raw);
  if (!isManifestUsable(manifest, problems) || manifest.apiVersion > SKILL_API_VERSION) {
    throw err(400, 'INVALID_EXTENSION_MANIFEST', problems.join('；'));
  }
  extensionId(manifest.id);
  const entry = String(raw.entry || 'index.js').replace(/\\/g, '/');
  if (entry.startsWith('/') || entry.split('/').some((part) => !part || part === '.' || part === '..')
      || !files.some((file) => file.name === entry)) throw err(400, 'INVALID_EXTENSION_MANIFEST', '入口文件不存在或路径非法');
  return { id: manifest.id, kind: manifests[0].name === 'plugin.json' ? 'plugin' : 'skill', manifest, raw, files };
}

function scan(root, source, kind) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const dir = child(root, dirent.name);
    try {
      const manifestPath = ['skill.json', 'plugin.json'].map((name) => path.join(dir, name)).find((name) => fs.existsSync(name));
      if (!manifestPath) continue;
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      const { manifest, problems } = normalizeManifest(raw, { fallbackId: dirent.name });
      if (!isManifestUsable(manifest, problems) || !VALID_ID.test(manifest.id)) continue;
      const schema = {};
      for (const [key, spec] of Object.entries(manifest.configSchema || {})) {
        if (spec && typeof spec === 'object' && !spec.secret && !UNSAFE_SETTING.test(key) && SAFE_TYPES.has(String(spec.type || ''))) {
          schema[key] = structuredClone(spec);
        }
      }
      const defaults = safeVisibleSettings(manifest.settings, schema);
      result.push({
        id: manifest.id, extId: manifest.id, name: manifest.name, version: manifest.version,
        kind, source, description: manifest.description, capabilities: manifest.capabilities,
        permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : [],
        configSchema: schema, defaults,
        enabledByDefault: manifest.enabledByDefault, dir
      });
    } catch { /* malformed entries cannot be selected or executed */ }
  }
  return result;
}

function publicItem(item) {
  const { dir, ...publicFields } = item;
  return publicFields;
}

function atomicJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export class ExtensionService {
  constructor(deps) {
    this.config = deps.config;
    this.agent = deps.agent || deps.agentRuntime;
    this.tenants = deps.tenants;
    this.db = deps.db;
    this.audit = deps.audit;
    this.logger = deps.logger;
    this.locks = new Map();
  }

  async withLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.locks.set(key, run);
    try { return await run; }
    finally { if (this.locks.get(key) === run) this.locks.delete(key); }
  }

  roots(tenant) {
    return {
      plugins: path.join(tenant.data_dir, 'admin-extensions', 'plugins'),
      skills: path.join(tenant.data_dir, 'admin-extensions', 'skills')
    };
  }

  catalogRoots() {
    return { plugins: path.join(this.config.dataDir, 'extensions', 'catalog', 'plugins'), skills: path.join(this.config.dataDir, 'extensions', 'catalog', 'skills') };
  }

  blocked(tenant) { return readBlockedExtensions(path.join(tenant.data_dir, 'data')); }
  blockedFile(tenant) { return path.join(tenant.data_dir, 'data', 'blocked-extensions.json'); }
  writeBlocked(tenant, blocked) { atomicJson(this.blockedFile(tenant), [...blocked].sort()); }

  async list(tenant, { admin = false } = {}) {
    const roots = this.roots(tenant);
    const blocked = this.blocked(tenant);
    const builtins = [...scan(path.join(CORE_ROOT, 'plugins'), 'builtin', 'plugin'), ...scan(path.join(CORE_ROOT, 'skills'), 'builtin', 'skill')];
    const installed = [...scan(roots.plugins, 'admin', 'plugin'), ...scan(roots.skills, 'admin', 'skill')];
    const byId = new Map();
    for (const item of builtins) byId.set(item.id.toLowerCase(), { ...item, blocked: blocked.has(item.id.toLowerCase()), builtin: true });
    for (const item of installed) byId.set(item.id.toLowerCase(), { ...item, blocked: false, builtin: byId.has(item.id.toLowerCase()) });
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(path.join(tenant.data_dir, 'data', 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') throw err(500, 'AGENT_CONFIG_INVALID', 'Agent 配置无法读取'); }
    let runtime = [];
    if (this.agent.isRunning(tenant)) {
      const response = await this.agent.request(tenant, 'GET', '/api/skills');
      runtime = response.skills || [];
    }
    const items = [...byId.values()].filter((item) => admin || !item.blocked).map((item) => {
      const state = runtime.find((value) => value.id === item.id);
      const configured = stored.skills?.[item.id] || {};
      const settings = safeVisibleSettings(state ? state.settings : { ...item.defaults, ...configured }, item.configSchema);
      return safeSkillStatus({
        ...publicItem(item), settings,
        enabled: state ? state.enabled : (configured.enabled ?? item.enabledByDefault),
        ...(state ? { loaded: state.loaded, active: state.active, loadError: state.loadError } : { loaded: false, active: false })
      });
    });
    return { items, extensions: items, agentRunning: this.agent.isRunning(tenant) };
  }

  async find(tenant, id, { admin = false } = {}) {
    const safeId = extensionId(id);
    const result = await this.list(tenant, { admin: true });
    const item = result.items.find((entry) => entry.id.toLowerCase() === safeId.toLowerCase());
    if (!item) throw err(404, 'EXTENSION_NOT_FOUND', '扩展不存在');
    if (!admin && item.blocked) throw err(403, 'EXTENSION_BLOCKED_BY_ADMIN', '扩展已被管理员屏蔽');
    return item;
  }

  async reload(tenant, id = '') {
    if (!this.agent.isRunning(tenant)) return { agentRunning: false, loaded: [], failed: [] };
    const result = await this.agent.request(tenant, 'POST', '/api/skills/reload', {});
    const failed = (result.failed || []).find((entry) => !id || String(entry.id).toLowerCase() === id.toLowerCase());
    if (failed) throw err(422, 'EXTENSION_LOAD_FAILED', '扩展加载失败，请检查 Agent 日志');
    if (id && !(result.loaded || []).some((entry) => String(entry?.id || entry).toLowerCase() === id.toLowerCase())) {
      throw err(422, 'EXTENSION_LOAD_FAILED', '扩展未成功加载');
    }
    return { loaded: result.loaded || [], failed: result.failed || [], pruned: result.pruned || [], agentRunning: true };
  }

  async installFiles(tenant, pkg) {
    return this.withLock(`tenant:${tenant.id}`, async () => {
      const roots = this.roots(tenant);
      const root = roots[pkg.kind === 'plugin' ? 'plugins' : 'skills'];
      const other = roots[pkg.kind === 'plugin' ? 'skills' : 'plugins'];
      ensureDir(root);
      if (scan(other, 'admin', pkg.kind === 'plugin' ? 'skill' : 'plugin').some((x) => x.id.toLowerCase() === pkg.id.toLowerCase())) {
        throw err(409, 'EXTENSION_ID_CONFLICT', '另一类型的扩展已有相同 ID');
      }
      const target = child(root, pkg.id);
      const stagingRoot = path.dirname(root);
      const stage = fs.mkdtempSync(path.join(stagingRoot, '.stage-'));
      const backup = child(stagingRoot, `.backup-${pkg.id}-${randomUUID()}`);
      const previousBlocked = this.blocked(tenant);
      const nextBlocked = new Set(previousBlocked);
      nextBlocked.delete(pkg.id.toLowerCase());
      let saved = false;
      let moved = false;
      try {
        for (const file of pkg.files) {
          const dest = child(stage, file.name);
          ensureDir(path.dirname(dest));
          fs.writeFileSync(dest, file.data, { flag: 'wx', mode: 0o600 });
        }
        if (fs.existsSync(target)) {
          if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory()) throw err(400, 'INVALID_EXTENSION_PATH', '扩展目录不是普通目录');
          await renameDirectory(target, backup);
          saved = true;
        }
        await renameDirectory(stage, target);
        moved = true;
        this.writeBlocked(tenant, nextBlocked);
        await this.reload(tenant, pkg.id);
        if (saved) safeRemove(stagingRoot, backup);
        return { id: pkg.id, extId: pkg.id, kind: pkg.kind, replaced: saved };
      } catch (error) {
        if (moved) safeRemove(root, target);
        if (saved) await renameDirectory(backup, target);
        this.writeBlocked(tenant, previousBlocked);
        if (moved) {
          try { await this.reload(tenant); }
          catch (rollbackError) { error.message += `；回滚重载失败：${rollbackError.message}`; }
        }
        throw error;
      } finally { if (fs.existsSync(stage)) safeRemove(stagingRoot, stage); }
    });
  }

  async installZip(tenant, body) { return this.installFiles(tenant, parsePackage(body)); }

  catalogList() {
    const roots = this.catalogRoots();
    const rows = this.db?.prepare('SELECT id, data_dir FROM tenants').all() || [];
    const deployments = new Map();
    for (const tenant of rows) {
      const installedRoots = this.roots(tenant);
      for (const entry of [...scan(installedRoots.plugins, 'admin', 'plugin'), ...scan(installedRoots.skills, 'admin', 'skill')]) {
        const key = `${entry.kind}:${entry.id.toLowerCase()}`;
        const ids = deployments.get(key) || [];
        ids.push(tenant.id);
        deployments.set(key, ids);
      }
    }
    const items = [...scan(roots.plugins, 'catalog', 'plugin'), ...scan(roots.skills, 'catalog', 'skill')].map((item) => {
      const installedTenants = deployments.get(`${item.kind}:${item.id.toLowerCase()}`) || [];
      return { ...publicItem(item), installedTenants, tenantCount: installedTenants.length, deployedCount: installedTenants.length };
    });
    return { items, extensions: items };
  }

  catalogEntry(id) {
    const targetId = extensionId(id).toLowerCase();
    const roots = this.catalogRoots();
    const item = [...scan(roots.plugins, 'catalog', 'plugin'), ...scan(roots.skills, 'catalog', 'skill')].find((entry) => entry.id.toLowerCase() === targetId);
    if (!item) throw err(404, 'EXTENSION_NOT_FOUND', '插件库中不存在该扩展');
    return item;
  }

  async uploadCatalog(body) {
    const pkg = parsePackage(body);
    return this.withLock('catalog', async () => {
      const roots = this.catalogRoots();
      const root = roots[pkg.kind === 'plugin' ? 'plugins' : 'skills'];
      const other = roots[pkg.kind === 'plugin' ? 'skills' : 'plugins'];
      if (scan(other, 'catalog', pkg.kind === 'plugin' ? 'skill' : 'plugin').some((item) => item.id.toLowerCase() === pkg.id.toLowerCase())) {
        throw err(409, 'EXTENSION_ID_CONFLICT', '插件库中已有不同类型的同名扩展');
      }
      ensureDir(root);
      const target = child(root, pkg.id);
      const stage = fs.mkdtempSync(path.join(root, '.stage-'));
      const backup = child(root, `.backup-${pkg.id}-${randomUUID()}`);
      let saved = false;
      try {
        for (const file of pkg.files) {
          const dest = child(stage, file.name);
          ensureDir(path.dirname(dest));
          fs.writeFileSync(dest, file.data, { flag: 'wx', mode: 0o600 });
        }
        if (fs.existsSync(target)) {
          if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory()) throw err(400, 'INVALID_EXTENSION_PATH', '扩展目录不是普通目录');
          await renameDirectory(target, backup); saved = true;
        }
        await renameDirectory(stage, target);
        if (saved) safeRemove(root, backup);
        return { id: pkg.id, extId: pkg.id, kind: pkg.kind, replaced: saved };
      } catch (error) {
        if (saved && !fs.existsSync(target)) await renameDirectory(backup, target);
        throw error;
      } finally { if (fs.existsSync(stage)) safeRemove(root, stage); }
    });
  }

  async deleteCatalog(id) {
    return this.withLock('catalog', async () => {
      const item = this.catalogEntry(id);
      const roots = this.catalogRoots();
      safeRemove(roots[item.kind === 'plugin' ? 'plugins' : 'skills'], item.dir);
      return { id: item.id };
    });
  }

  async installCatalog(tenant, id) {
    const item = this.catalogEntry(id);
    const files = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
        else if (entry.isFile()) files.push({ name, data: fs.readFileSync(path.join(dir, entry.name)) });
        else throw err(400, 'INVALID_EXTENSION_PATH', '插件库包含符号链接或特殊文件');
      }
    };
    walk(item.dir);
    return this.installFiles(tenant, { id: item.id, kind: item.kind, files });
  }

  async remove(tenant, id, { blockBuiltin = true, cleanConfig = false } = {}) {
    return this.withLock(`tenant:${tenant.id}`, async () => {
      const item = await this.find(tenant, id, { admin: true });
      const roots = this.roots(tenant);
      const previousBlocked = this.blocked(tenant);
      const nextBlocked = new Set(previousBlocked);
      if (item.builtin && blockBuiltin) nextBlocked.add(item.id.toLowerCase());
      else nextBlocked.delete(item.id.toLowerCase());
      let backup = '';
      const root = roots[item.kind === 'plugin' ? 'plugins' : 'skills'];
      const target = child(root, item.id);
      if (item.source === 'admin' && fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink()) throw err(400, 'INVALID_EXTENSION_PATH', '扩展目录不是普通目录');
        backup = child(path.dirname(root), `.backup-${item.id}-${randomUUID()}`);
        await renameDirectory(target, backup);
      }
      try {
        this.writeBlocked(tenant, nextBlocked);
        await this.reload(tenant);
        if (cleanConfig) await this.agentSettings?.removeSkillConfig(tenant, item.id);
        if (backup) safeRemove(path.dirname(root), backup);
        return { id: item.id, blocked: nextBlocked.has(item.id.toLowerCase()) };
      } catch (error) {
        if (backup) await renameDirectory(backup, target);
        this.writeBlocked(tenant, previousBlocked);
        try { await this.reload(tenant); } catch (rollbackError) { error.message += `；回滚重载失败：${rollbackError.message}`; }
        throw error;
      }
    });
  }

  async restore(tenant, id) {
    return this.withLock(`tenant:${tenant.id}`, async () => {
      const item = await this.find(tenant, id, { admin: true });
      if (!item.builtin) throw err(404, 'EXTENSION_NOT_FOUND', '内置扩展不存在');
      const previous = this.blocked(tenant);
      const next = new Set(previous); next.delete(item.id.toLowerCase());
      this.writeBlocked(tenant, next);
      try { await this.reload(tenant, item.id); }
      catch (error) {
        this.writeBlocked(tenant, previous);
        try { await this.reload(tenant); } catch { /* preserve original failure */ }
        throw error;
      }
      return { id: item.id, blocked: false };
    });
  }

  async batch(id, tenantIds, operation) {
    if (!Array.isArray(tenantIds) || !tenantIds.length || tenantIds.length > 200) throw err(400, 'INVALID_TENANTS', '请选择 1 至 200 个实例');
    const results = [];
    for (const tenantId of [...new Set(tenantIds.map(String))]) {
      try {
        const tenant = this.tenants.row(tenantId);
        if (!tenant) throw err(404, 'TENANT_NOT_FOUND', '实例不存在');
        const value = operation === 'deploy' ? await this.installCatalog(tenant, id) : await this.remove(tenant, id);
        results.push({ tenantId, ok: true, ...value });
      } catch (error) {
        results.push({ tenantId, ok: false, code: error.code || 'EXTENSION_FAILED', error: error.message });
      }
    }
    return { results };
  }
}
