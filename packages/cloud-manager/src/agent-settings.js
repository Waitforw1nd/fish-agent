import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardConfigPatch } from './config-guard.js';
import { ensureDir } from './util.js';
import { normalizeStoredAgentConfig, mergeAgentConfigPatch, sanitizeConfig } from '../../qq-agent-core/src/config-codec.js';
import { PERSONAS, parsePersonaCard, personaCardToTemplate } from '../../qq-agent-core/src/personas.js';
import { CATEGORY_META } from '../../qq-agent-core/src/tool-registry.js';
import { safeSkillStatus, safeVisibleSettings } from './extension-service.js';

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const LOCKED_FIELDS = ['server', 'extensions', 'relay', 'channels', 'connection', 'snowluma', 'providers', 'dshProviderKeys', 'api.baseUrl', 'api.apiKey', 'allowAllWhenEmpty', 'tools.crossChatSend', 'security.allowPrivateImageHosts'];
const unsafeSetting = /(?:url|endpoint|host|proxy|path|command|script|exec|token|key|cookie|secret|password)/i;
const REPLACEABLE_MAPS = new Set(['blocklist', 'personaByChat', 'store.groupSliderPos', 'store.groupPeakPos']);

function ensurePlainPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err(400, 'INVALID_CONFIG', '配置必须是 JSON 对象');
  const walk = (node, depth = 0, currentPath = '') => {
    if (!node || typeof node !== 'object') return;
    if (depth > 40) throw err(400, 'INVALID_CONFIG', '配置嵌套过深');
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw err(400, 'INVALID_CONFIG', '配置中包含禁止的字段');
      if (key === '__replace__') {
        if (!REPLACEABLE_MAPS.has(currentPath) || Object.keys(node).length !== 1
            || !item || typeof item !== 'object' || Array.isArray(item)) {
          throw err(400, 'INVALID_CONFIG', '该配置字段不允许整体替换');
        }
        walk(item, depth + 1, `${currentPath}.__replace__`);
      } else {
        walk(item, depth + 1, currentPath ? `${currentPath}.${key}` : key);
      }
    }
  };
  walk(value);
  for (const key of ['api', 'security', 'tools', 'webSearch']) {
    if (Object.hasOwn(value, key) && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw err(400, 'INVALID_CONFIG', `${key} 必须是对象`);
    }
  }
  if (Object.hasOwn(value, 'skills')) throw err(400, 'USE_SKILL_ENDPOINT', '扩展设置请使用专用接口');
}

function chatPart(chatId) {
  const match = /^(group|private)[:_](\d{1,20})$/.exec(String(chatId || ''));
  if (!match) throw err(400, 'INVALID_CHAT_ID', '会话 ID 不合法');
  return `${match[1]}_${match[2]}`;
}

function sessionPart(id) {
  const value = String(id || '');
  if (!/^[\w-]{1,128}$/.test(value)) throw err(400, 'INVALID_SESSION_ID', '运行记录 ID 不合法');
  return value;
}

function validateSettings(item, settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw err(400, 'INVALID_SKILL_SETTINGS', '扩展设置必须是对象');
  const schema = item.configSchema || {};
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    const spec = schema[key];
    if (!spec || typeof spec !== 'object' || spec.secret || unsafeSetting.test(key)
        || ['internal', 'password', 'secret', 'file'].includes(spec.type)) {
      throw err(403, 'SKILL_SETTING_FORBIDDEN', `不可修改扩展设置：${key}`);
    }
    const type = String(spec.type || '');
    if (type === 'boolean') {
      if (typeof value !== 'boolean') throw err(400, 'INVALID_SKILL_SETTINGS', `${key} 必须是布尔值`);
    } else if (type === 'number' || type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))
          || (spec.min !== undefined && value < Number(spec.min)) || (spec.max !== undefined && value > Number(spec.max))) {
        throw err(400, 'INVALID_SKILL_SETTINGS', `${key} 超出允许范围`);
      }
    } else if (type === 'string' || type === 'select' || type === 'enum') {
      if (typeof value !== 'string' || value.length > Math.min(4000, Number(spec.maxLength) || 4000)) {
        throw err(400, 'INVALID_SKILL_SETTINGS', `${key} 必须是有效文本`);
      }
    } else {
      throw err(403, 'SKILL_SETTING_FORBIDDEN', `不支持的扩展设置类型：${key}`);
    }
    const choices = spec.enum || spec.options;
    if (Array.isArray(choices)) {
      const values = choices.map((choice) => (choice && typeof choice === 'object' ? choice.value : choice));
      if (!values.includes(value)) throw err(400, 'INVALID_SKILL_SETTINGS', `${key} 不是允许的选项`);
    }
    result[key] = value;
  }
  return result;
}

function cardSummary(parsed, template) {
  const c = parsed.card;
  return {
    format: parsed.format, spec: parsed.spec, specVersion: parsed.specVersion, png: parsed.png || null,
    name: template.name, creator: c.creator, characterVersion: c.characterVersion, tags: c.tags,
    description: c.description, personality: c.personality, scenario: c.scenario,
    firstMes: c.firstMes, mesExample: c.mesExample,
    flags: { hasSystemPrompt: c.hasSystemPrompt, hasPostHistoryInstructions: c.hasPostHistoryInstructions, characterBookEntries: c.characterBookEntries, assetsCount: c.assetsCount },
    template, warnings: [...new Set([...(parsed.warnings || []), ...(template.warnings || [])])],
    stats: { sourceBytes: parsed.sourceBytes || 0, templateChars: template.text.length }
  };
}

export class AgentSettingsService {
  constructor(deps) {
    this.agent = deps.agent || deps.agentRuntime;
    this.supervisor = deps.supervisor;
    this.extensionService = deps.extensionService;
    this.logger = deps.logger;
    this.locks = new Map();
    if (this.extensionService) this.extensionService.agentSettings = this;
  }

  async locked(tenant, fn) {
    const previous = this.locks.get(tenant.id) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    this.locks.set(tenant.id, run);
    try { return await run; } finally { if (this.locks.get(tenant.id) === run) this.locks.delete(tenant.id); }
  }

  running(tenant) { return this.agent.isRunning(tenant); }

  assertStable(tenant) {
    const state = this.supervisor?.status(tenant.id, 'agent')?.state || (this.running(tenant) ? 'running' : 'stopped');
    if (['starting', 'restarting', 'stopping', 'stop_unconfirmed'].includes(state)) {
      throw err(409, 'AGENT_STATE_CHANGING', 'Agent 正在切换运行状态，请稍后重试');
    }
  }

  raw(tenant) {
    const file = this.agent.configPath(tenant);
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw err(500, 'AGENT_CONFIG_INVALID', 'Agent 配置无法读取，请检查配置文件');
    }
  }

  write(tenant, value) {
    const file = this.agent.configPath(tenant);
    ensureDir(path.dirname(file));
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }

  async publicConfig(tenant, value) {
    const result = sanitizeConfig(value);
    if (result.skills && this.extensionService) {
      const { items } = await this.extensionService.list(tenant, { admin: true });
      const allowed = new Map(items.filter((item) => !item.blocked).map((item) => [item.id, item]));
      for (const [id, values] of Object.entries(result.skills)) {
        const item = allowed.get(id);
        if (!item || !values || typeof values !== 'object') { delete result.skills[id]; continue; }
        result.skills[id] = {
          ...(typeof values.enabled === 'boolean' ? { enabled: values.enabled } : {}),
          ...safeVisibleSettings(values, item.configSchema)
        };
      }
    }
    return result;
  }

  async getConfig(tenant) {
    this.assertStable(tenant);
    const agentRunning = this.running(tenant);
    const value = agentRunning
      ? await this.agent.request(tenant, 'GET', '/api/config')
      : normalizeStoredAgentConfig(this.raw(tenant));
    return { config: await this.publicConfig(tenant, value), agentRunning, lockedFields: LOCKED_FIELDS };
  }

  async updateUnlocked(tenant, input) {
    this.assertStable(tenant);
    ensurePlainPatch(input);
    const guarded = guardConfigPatch(input);
    if (guarded.blocked) throw err(400, 'INVALID_CONFIG', guarded.warnings.join('；'));
    const patch = guarded.patch;
    patch.allowAllWhenEmpty = false;
    patch.tools = { ...(patch.tools || {}), crossChatSend: false };
    patch.security = { ...(patch.security || {}), allowPrivateImageHosts: false };
    let value;
    const agentRunning = this.running(tenant);
    if (agentRunning) {
      const response = await this.agent.request(tenant, 'POST', '/api/config', patch);
      value = response.config;
    } else {
      value = mergeAgentConfigPatch(normalizeStoredAgentConfig(this.raw(tenant)), patch);
      this.write(tenant, value);
    }
    return { config: await this.publicConfig(tenant, value), warnings: guarded.warnings, agentRunning, lockedFields: LOCKED_FIELDS };
  }

  async updateConfig(tenant, patch) { return this.locked(tenant, () => this.updateUnlocked(tenant, patch)); }

  async personas(tenant) {
    const { config, agentRunning } = await this.getConfig(tenant);
    const builtins = Object.entries(PERSONAS).map(([id, item]) => ({ id, ...item, builtin: true }));
    const custom = (config.customPersonas || []).map((item, index) => ({ ...item, id: `custom_${index}`, builtin: false }));
    return { templates: [...builtins, ...custom], persona: config.persona, agentRunning };
  }

  async savePersona(tenant, input) {
    return this.locked(tenant, async () => {
      const name = String(input?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 50);
      const text = String(input?.text || '').trim();
      if (!name || !text || text.length > 100000) throw err(400, 'INVALID_PERSONA', '人设名称或正文无效');
      const { config } = await this.getConfig(tenant);
      const customs = Array.isArray(config.customPersonas) ? [...config.customPersonas] : [];
      if (customs.length >= 200) throw err(400, 'PERSONA_LIMIT', '自定义人设最多 200 个');
      const entry = { name, text, ...(input.customRules ? { customRules: String(input.customRules).slice(0, 4000) } : {}), ...(input.imported ? { imported: true, cardMeta: input.cardMeta } : {}) };
      customs.push(entry);
      const patch = { customPersonas: customs };
      if (input.applyNow === true) patch.persona = { roleText: text, customRules: entry.customRules || '' };
      const result = await this.updateUnlocked(tenant, patch);
      return { id: `custom_${customs.length - 1}`, entry, templates: customs, config: result.config };
    });
  }

  async deletePersona(tenant, templateId) {
    return this.locked(tenant, async () => {
      if (!/^custom_\d+$/.test(String(templateId))) throw err(400, 'INVALID_PERSONA', '只能删除自定义人设');
      const { config } = await this.getConfig(tenant);
      const index = Number(String(templateId).slice(7));
      const customs = [...(config.customPersonas || [])];
      if (index >= customs.length) throw err(404, 'PERSONA_NOT_FOUND', '人设不存在');
      customs.splice(index, 1);
      await this.updateUnlocked(tenant, { customPersonas: customs });
      return { templates: customs };
    });
  }

  previewCard(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw err(400, 'INVALID_PERSONA_CARD', '角色卡数据无效');
    const filename = String(input.filename || input.fileName || input.name || '').slice(0, 200);
    const data = input.base64 || input.dataBase64 || input.data || input.text || input.card;
    if (!data || Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data)) > 12 * 1024 * 1024) {
      throw err(400, 'INVALID_PERSONA_CARD', '角色卡为空或过大');
    }
    try {
      const parsed = parsePersonaCard(data, { filename, encoding: input.base64 || input.dataBase64 ? 'base64' : input.encoding });
      const template = personaCardToTemplate(parsed.card, { includeGreeting: input.includeGreeting === true, includeExamples: input.includeExamples !== false });
      return { card: cardSummary(parsed, template), parsed, template };
    } catch (error) { throw err(400, 'INVALID_PERSONA_CARD', error.message); }
  }

  async importCard(tenant, input) {
    const { parsed, template, card } = this.previewCard(input);
    const result = await this.savePersona(tenant, {
      name: input.templateName || template.name, text: template.text, customRules: input.customRules,
      applyNow: input.applyNow, imported: true,
      cardMeta: { format: parsed.format, spec: parsed.spec, specVersion: parsed.specVersion, creator: parsed.card.creator, characterVersion: parsed.card.characterVersion, tags: parsed.card.tags.slice(0, 20) }
    });
    return { ...result, template, warnings: card.warnings };
  }

  async contacts(tenant) {
    if (!this.running(tenant)) return { online: false, groups: [], friends: [] };
    const [groups, friends] = await Promise.allSettled([
      this.agent.request(tenant, 'GET', '/api/onebot/groups'), this.agent.request(tenant, 'GET', '/api/onebot/friends')
    ]);
    return { online: groups.status === 'fulfilled' && friends.status === 'fulfilled', groups: groups.value?.groups || [], friends: friends.value?.friends || [] };
  }

  async status(tenant) {
    if (!this.running(tenant)) return { agentRunning: false, paused: false, online: false };
    const result = await this.agent.request(tenant, 'GET', '/api/status');
    delete result.dataDir;
    return { ...result, agentRunning: true };
  }

  async bridge(tenant, method, endpoint, body) {
    this.assertStable(tenant);
    return this.agent.request(tenant, method, endpoint, body);
  }

  async sessions(tenant, query = '') { return this.bridge(tenant, 'GET', `/api/sessions${query}`); }
  async sessionAction(tenant, id, action) {
    if (!['retry', 'abort', 'delete'].includes(action)) throw err(400, 'INVALID_ACTION', '不支持的运行记录操作');
    const base = `/api/sessions/${sessionPart(id)}`;
    return this.bridge(tenant, action === 'delete' ? 'DELETE' : 'POST', action === 'delete' ? base : `${base}/${action}`, {});
  }
  async chats(tenant) { return this.bridge(tenant, 'GET', '/api/chats'); }
  async messages(tenant, id, query = '') { return this.bridge(tenant, 'GET', `/api/chats/${chatPart(id)}/messages${query}`); }
  async chatAction(tenant, id, body) {
    const action = String(body?.action || '');
    if (!['test-send', 'mark-read', 'mute', 'clear'].includes(action)) throw err(400, 'INVALID_ACTION', '不支持的会话操作');
    const chat = chatPart(id);
    if (action === 'test-send') {
      const [kind, chatId] = chat.split('_');
      const { config } = await this.getConfig(tenant);
      const allowed = config.allow?.[kind] ?? config.allow?.[`${kind}s`] ?? [];
      const denied = config.deny?.[kind] ?? config.deny?.[`${kind}s`] ?? [];
      if (!Array.isArray(allowed) || !allowed.map(String).includes(chatId)
          || (Array.isArray(denied) && denied.map(String).includes(chatId))) {
        throw err(403, 'CHAT_NOT_ALLOWED', '该会话不在可发送白名单内');
      }
    }
    return this.bridge(tenant, 'POST', `/api/chats/${chat}/${action}`, body);
  }
  async memories(tenant) { return this.bridge(tenant, 'GET', '/api/memory-files'); }
  async memory(tenant, id) {
    const [result, { config }] = await Promise.all([
      this.bridge(tenant, 'GET', `/api/memory-files/${chatPart(id)}`),
      this.getConfig(tenant)
    ]);
    const notes = config.memberNotes || {};
    return { ...result, members: (result.members || []).map((member) => ({ ...member, note: String(notes[String(member.userId)] || '') })) };
  }
  async memoryMember(tenant, id, userId, method, body) {
    if (!/^\d{1,20}$/.test(String(userId))) throw err(400, 'INVALID_USER_ID', '用户 ID 不合法');
    let input = body;
    if (method === 'PUT') {
      input = { ...(body || {}) };
      if (!Object.hasOwn(input, 'note')) {
        const { config } = await this.getConfig(tenant);
        input.note = String(config.memberNotes?.[String(userId)] || '');
      }
      if (Array.isArray(input.impressions)) {
        input.impressions = input.impressions.map((entry) => typeof entry === 'string' ? entry : String(entry?.content || ''));
      }
    }
    return this.bridge(tenant, method, `/api/memory-files/${chatPart(id)}/members/${userId}`, input);
  }
  async deleteMemory(tenant, id) { return this.bridge(tenant, 'DELETE', `/api/memory-files/${chatPart(id)}`); }

  async skills(tenant) {
    const extensions = await this.extensionService.list(tenant);
    if (!this.running(tenant)) {
      return { skills: extensions.items, categories: CATEGORY_META, tools: [], availabilityKnown: false, agentRunning: false };
    }
    const [result, availability, toolDefs] = await Promise.all([
      this.bridge(tenant, 'GET', '/api/skills'),
      this.bridge(tenant, 'GET', '/api/tools/availability'),
      this.bridge(tenant, 'GET', '/api/tools')
    ]);
    const allowed = new Map(extensions.items.map((item) => [item.id, item]));
    const defs = new Map((toolDefs.tools || []).map((item) => [item.id, item]));
    return {
      ...result,
      skills: (result.skills || []).filter((item) => allowed.has(item.id)).map((item) => safeSkillStatus({
        ...item, configSchema: allowed.get(item.id).configSchema, settings: allowed.get(item.id).settings
      })),
      uninstalled: (result.uninstalled || []).filter((item) => allowed.has(item.id)),
      categories: availability.categories || CATEGORY_META,
      tools: (availability.tools || [])
        .filter((item) => !item.skillId || allowed.has(item.skillId))
        .map((item) => {
          const result = { ...(defs.get(item.id) || {}), ...item };
          if (result.reason && (result.skillId || result.code === 'skill-guard')) {
            result.reason = '所属扩展当前不可用，请检查运行状态';
          }
          return result;
        }),
      availabilityKnown: true,
      agentRunning: true
    };
  }

  async updateSkill(tenant, id, body) {
    return this.locked(tenant, async () => {
      this.assertStable(tenant);
      const item = await this.extensionService.find(tenant, id);
      const patch = {};
      if (body?.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw err(400, 'INVALID_SKILL_SETTINGS', 'enabled 必须是布尔值');
        patch.enabled = body.enabled;
      }
      const settings = body?.settings === undefined ? {} : validateSettings(item, body.settings);
      if (!Object.keys(settings).length && patch.enabled === undefined) throw err(400, 'INVALID_SKILL_SETTINGS', '没有可修改的扩展设置');
      if (this.running(tenant)) {
        const result = await this.agent.request(tenant, 'POST', `/api/skills/${encodeURIComponent(item.id)}`, { ...patch, settings });
        const publicConfig = await this.publicConfig(tenant, result.config);
        const latest = await this.extensionService.find(tenant, item.id);
        return {
          ...result,
          skill: result.skill ? safeSkillStatus({ ...result.skill, configSchema: item.configSchema, settings: latest.settings }) : result.skill,
          settings: latest.settings,
          config: publicConfig, agentRunning: true
        };
      }
      const current = normalizeStoredAgentConfig(this.raw(tenant));
      const next = mergeAgentConfigPatch(current, { skills: { [item.id]: { ...patch, ...settings } }, allowAllWhenEmpty: false, tools: { crossChatSend: false }, security: { allowPrivateImageHosts: false } });
      this.write(tenant, next);
      const publicConfig = await this.publicConfig(tenant, next);
      return { skill: { ...item, enabled: next.skills?.[item.id]?.enabled ?? item.enabledByDefault, settings: publicConfig.skills?.[item.id] || {} }, config: publicConfig, agentRunning: false };
    });
  }

  async removeSkillConfig(tenant, id) {
    return this.locked(tenant, async () => {
      this.assertStable(tenant);
      if (this.running(tenant)) return this.agent.request(tenant, 'POST', '/api/skills/cleanup', { ids: [id] });
      const current = normalizeStoredAgentConfig(this.raw(tenant));
      if (current.skills) delete current.skills[id];
      this.write(tenant, current);
      return { removed: [id] };
    });
  }
}
