import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateZipStructure } from './zip-install.js';
import { normalizeManifest, isManifestUsable, SKILL_API_VERSION } from './skills/manifest.js';
import { resolveSkillRoots, tenantExtensionsAllowed, isCloudMode, extensionInstallLocks, extensionRootsLockKey } from './plugin-loader.js';

export async function installExtensionZip(buffer, { reload, expectedId = '' } = {}) {
  if (!tenantExtensionsAllowed()) throw new Error('租户扩展执行隔离未确认，安装已禁用');
  if (!Buffer.isBuffer(buffer) || buffer.length > 8 * 1024 * 1024) throw new Error('安装包超过 8MB 上限');
  if (typeof reload !== 'function') throw new Error('核心未提供扩展重载');
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const prefix = entries[0].name.split('/')[0];
  const strip = entries.every((entry) => entry.name.startsWith(`${prefix}/`)) ? prefix.length + 1 : 0;
  const files = entries.map((entry) => ({ ...entry, name: entry.name.slice(strip) }));
  const manifests = files.filter((entry) => entry.name === 'skill.json' || entry.name === 'plugin.json');
  if (manifests.length !== 1) throw new Error('安装包必须包含且仅包含一个根目录清单');
  let raw;
  try { raw = JSON.parse(manifests[0].data.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('清单不是合法 JSON'); }
  if (typeof raw?.id !== 'string' || !raw.id.trim()) throw new Error('清单缺少 id');
  const { manifest, problems } = normalizeManifest(raw);
  if (!isManifestUsable(manifest, problems) || manifest.apiVersion > SKILL_API_VERSION || manifest.id.length > 64) throw new Error(`清单不可用：${problems.join('；')}`);
  if (expectedId && manifest.id !== expectedId) throw new Error('安装包 ID 与市场条目不一致');
  const entry = String(raw.entry || 'index.js').replace(/\\/g, '/');
  if (entry.startsWith('/') || entry.split('/').some((part) => !part || part === '.' || part === '..') || !files.some((file) => file.name === entry)) throw new Error('清单入口不存在或路径非法');
  const kind = manifests[0].name === 'plugin.json' ? 'plugin' : 'skill';
  const roots = resolveSkillRoots();
  const base = roots[kind === 'plugin' ? 'plugins' : 'skills'];
  const other = roots[kind === 'plugin' ? 'skills' : 'plugins'];
  if (isCloudMode() && (!process.env.QQ_AGENT_SKILLS_DIR || !process.env.QQ_AGENT_PLUGINS_DIR)) throw new Error('云端必须配置租户扩展目录');
  fs.mkdirSync(base, { recursive: true });
  const lock = extensionRootsLockKey(roots);
  if (extensionInstallLocks.has(lock)) throw new Error('扩展正在安装');
  extensionInstallLocks.add(lock);
  const suffix = randomUUID();
  const staging = path.join(path.dirname(base), `.extension-stage-${suffix}`);
  const backup = path.join(path.dirname(base), `.${path.basename(base)}-extension-backup-${manifest.id}`);
  const target = path.join(base, manifest.id);
  let replaced = false;
  let moved = false;
  try {
    for (const root of [base, other]) {
      if (!fs.existsSync(root)) continue;
      for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const dir = path.join(root, dirent.name);
        for (const name of ['skill.json', 'plugin.json']) {
          try {
            const existing = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
            if (String(existing.id || '').toLowerCase() === manifest.id.toLowerCase() && path.resolve(dir) !== path.resolve(target)) throw new Error(`扩展 ID 已存在于其他目录：${manifest.id}`);
          } catch (error) { if (error.message.startsWith('扩展 ID')) throw error; }
        }
      }
    }
    fs.mkdirSync(staging);
    for (const file of files) {
      const dest = path.join(staging, ...file.name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.data, { flag: 'wx' });
    }
    if (fs.existsSync(backup)) throw new Error('存在待恢复的扩展备份，请重启服务');
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw new Error('扩展目标不是普通目录');
      fs.renameSync(target, backup); replaced = true;
    }
    fs.renameSync(staging, target);
    moved = true;
    const result = await reload({ reason: 'zip-install' });
    const failed = result?.failed?.find((item) => item.id === manifest.id);
    if (failed || !result?.loaded?.some((item) => item.id === manifest.id)) throw new Error(failed?.error || '扩展未加载');
    if (replaced) fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true, id: manifest.id, kind, replaced };
  } catch (error) {
    if (moved) fs.rmSync(target, { recursive: true, force: true });
    if (replaced) fs.renameSync(backup, target);
    if (moved || replaced) {
      try { await reload({ reason: 'zip-install-rollback' }); } catch (rollbackError) { error.message += `；回滚重载失败：${rollbackError.message}`; }
    }
    throw error;
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); }
    finally { extensionInstallLocks.delete(lock); }
  }
}
