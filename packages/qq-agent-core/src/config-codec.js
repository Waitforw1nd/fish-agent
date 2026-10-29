import { DEFAULT_CONFIG } from './config-defaults.js';
import { sliderToTier, tierToSlider } from './tier-slider.js';

/** 深合并（含 __replace__ 整体替换约定）。导出供 routes.js 的预览端点做"不落盘的临时合并"。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

// ── 配置脱敏 ────────────────────────────────────────────────────────────
// 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
// 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
// ⚠️ cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie
//    是登录凭据，曾经 pattern 不认导致 /api/config 明文返回。
// ⚠️ server.token（控制台管理令牌）也在内：它只用于 x-console-token 校验，
//    GET /api/config 没有任何理由把明文管理令牌回传给浏览器（2026-09-26 审查发现
//    裸 "token" 键名不命中原 pattern，配置了 token 的实例会在每次打开设置页时泄露它）。
const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|authtoken|auth_token|communitykey|cookie|secret|password|privatekey|private_key|^token$|^key$)/i;
// 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
const SECRET_KEY_EXCLUDE = /from$/i;

export function sanitizeConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg ?? {}));
  const seen = new WeakSet();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (SECRET_KEY_EXCLUDE.test(key)) continue;
      // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
      // 不排除就会连锁生成 hasHasXxx
      if (/^has/i.test(key) && typeof value === 'boolean') continue;
      if (SECRET_KEY_PATTERN.test(key)) {
        // ⚠️ 必须"删除字段"而不是"置为空串"。
        // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
        // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
        // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
        // 删掉字段则展开时不会带上该键，服务端原值得以保留。
        delete node[key];
        const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        node[flagName] = Boolean(String(value ?? '').trim());
      } else if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(out);

  // 密钥集合整体清空（不逐 key 暴露存在性）
  if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
    const has = { ...(cfg?.dshProviderKeyPresence || {}) };
    for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
    out.dshProviderKeys = {};
    out.dshProviderKeyPresence = has;
  }

  // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
  if (Array.isArray(out.providers)) {
    for (let i = 0; i < out.providers.length; i++) {
      const p = out.providers[i];
      const real = (cfg?.dshProviderKeys || {})[p.id] || cfg?.providers?.[i]?.apiKey;
      delete p.apiKey;
      p.hasKey = Boolean(String(real ?? '').trim()) || p.hasKey === true || p.hasApiKey === true;
    }
  }
  // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
  if (out.api && typeof out.api === 'object' && !Array.isArray(out.api)) {
    out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());
  }

  return out;
}

export function sanitizeProvider(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  const result = sanitizeConfig(provider);
  const apiKey = provider.apiKey;
  return { ...result, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
}


/**
 * 旧配置迁移：把历史上散落在各处的"能力开关"收拢进 config.skills。
 *
 * 为什么必须做：社区版/旧版把同一件事的开关放在 api.thinking、tools.knowledgeEnabled
 * 之类的字段里，而新架构只认 config.skills[id].enabled。若不迁移，
 * 用户升级后会出现"UI 显示已开启、实际 Skill 判定为关闭"——正是要消灭的冲突。
 *
 * 规则（表驱动，新增迁移只需加一行）：
 *   旧字段路径 → Skill id，可选值映射函数
 * 迁移是幂等的：只有在 skills[id] 尚未存在时才写入，不会覆盖用户新配置。
 */
const LEGACY_SKILL_MIGRATIONS = [
  // ⚠️ skill 名字必须与 skills/ 或 plugins/ 下的**目录名**完全一致，
  //    目标不存在时迁移会跳过并记日志（migrateLegacySkills 内有校验）。
  // 社区版的思考开关已收编进核心（src/thinking.js），不再迁往任何 Skill：
  // api.thinking: true → thinkingMode 'on'，false → 'off'，由下方专段处理。
  // 旧知识库开关（知识库技能尚未移植，先留位；目标不存在时迁移会跳过并记日志）
  { from: ['tools', 'knowledgeEnabled'], skill: 'knowledge-base', map: (v) => ({ enabled: v !== false }) },
  // 旧视频理解开关
  { from: ['tools', 'videoEnabled'], skill: 'video-frames', map: (v) => ({ enabled: v !== false }) },
  // 旧表情标注开关
  { from: ['tools', 'stickerAnnotate'], skill: 'sticker-annotate', map: (v) => ({ enabled: v !== false }) }
];

export function migrateLegacySkills(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  out.skills = (out.skills && typeof out.skills === 'object' && !Array.isArray(out.skills)) ? { ...out.skills } : {};

  // 社区版的思考开关（api.thinking: boolean）：思考已收编进核心（src/thinking.js），
  // 旧值映射成 thinkingMode（true=on / false=off），不再迁往任何 Skill 命名空间。
  if (out.api && typeof out.api === 'object' && !Array.isArray(out.api) && 'thinking' in out.api) {
    const legacyThinking = out.api.thinking;
    if (out.api.thinkingMode === undefined) {
      out.api = { ...out.api, thinkingMode: legacyThinking === false ? 'off' : 'on' };
    }
    const nextApi = { ...out.api };
    delete nextApi.thinking;
    out.api = nextApi;
  }

  for (const rule of LEGACY_SKILL_MIGRATIONS) {
    const [parent, key] = rule.from;
    const container = out[parent];
    if (!container || typeof container !== 'object') continue;
    if (!(key in container)) continue;
    const legacyValue = container[key];
    // 已有新配置就不动（用户可能已经在新 UI 里改过）
    if (!(rule.skill in out.skills)) {
      out.skills[rule.skill] = { ...rule.map(legacyValue) };
    }
    // 清掉旧字段，避免下次启动重复迁移、也避免模块继续读到旧值
    const nextContainer = { ...container };
    delete nextContainer[key];
    out[parent] = nextContainer;
  }
  return out;
}

/**
 * 剔除**废弃字段**（磁盘/回传 patch 都可能带着的历史残留）。
 * 这些字段已无任何读点，留着只会冒充"生效配置"继续漂移：
 *   · api.stream          —— llm.js 请求体硬编码 stream:false（无 UI、无读点）
 *   · api.priceRemoteUrl  —— 远程价格表地址固定为 src/community.js 的常量
 *   · budget（容器整体）  —— 预算保险丝功能已移除，容器本身也无读点
 *   · store.peakSchedule.valley.start/end —— "高峰外=低谷"语义下无人读
 *     （peakSchedule.valley.sliderPos 保留，peakSchedule.custom.valley 同口径只留 sliderPos）
 *   · providersImported   —— 导入来源标记，零读点
 * 与 stripDerivedFlags 一样在 loadConfig / updateConfig 时调用，删旧键不碰活键。
 */
const OBSOLETE_PATHS = [
  ['api', 'stream'],
  ['api', 'priceRemoteUrl'],
  ['budget'],
  ['providersImported'],
  // 2026-09-25 档位改版：四个分档条数字段废弃，统一为 store.historyCount。
  // 老配置里的存量值会在 loadConfig 时被剔除（读条数走 historyCount / allCount 迁移兜底）。
  ['store', 'atCount'],
  ['store', 'keywordCount'],
  ['store', 'randomCount'],
  ['store', 'allCount'],
  ['store', 'peakSchedule', 'valley', 'start'],
  ['store', 'peakSchedule', 'valley', 'end'],
  ['store', 'peakSchedule', 'custom', 'valley', 'start'],
  ['store', 'peakSchedule', 'custom', 'valley', 'end']
];

export function stripObsoleteFields(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  for (const path of OBSOLETE_PATHS) {
    let cur = node;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cur?.[path[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { ok = false; break; }
      cur = next;
    }
    if (ok && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete cur[path[path.length - 1]];
    }
  }
  return node;
}


/**
 * 剔除**派生标记**：GET /api/config 的脱敏层会生成 hasXxx / dshProviderKeyPresence
 * 这类"只表示存在性"的字段。前端把它们当成配置的一部分回传时，
 * deepMerge 会把它们真的写进 config.json —— 于是配置文件里混进了派生数据，
 * 且会随密钥增删变得与实际不一致（清了 Key 但 hasKey 仍是 true）。
 */
export function stripDerivedConfigFlags(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripDerivedConfigFlags(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    // hasApiKey / hasKey / hasAccessToken / hasHttpAccessToken …
    // 只匹配 camelCase 的 has+大写开头，避免误删用户自定义的普通字段。
    if (/^has[A-Z][A-Za-z0-9]*$/.test(key)) { delete node[key]; continue; }
    if (key === 'dshProviderKeyPresence') { delete node[key]; continue; }
    stripDerivedConfigFlags(node[key]);
  }
  return node;
}

/**
 * 数组型密钥容器的脱敏回传保留：patch 里按 id 匹配的条目若**缺少**密钥字段，
 * 从现配置同 id 条目回填 —— 前端脱敏视图回传时密钥天然不在场，不回填就会
 * 在"数组整体替换"的合并语义下静默清空。显式传空串（''）= 真清除，不回填。
 * 目前只有 webSearch.providers 一处数组密钥容器；新增容器时往数组里加路径即可。
 */
function preserveSanitizedSecrets(current, patch) {
  if (!current || !patch || typeof current !== 'object' || typeof patch !== 'object') return;
  if (Array.isArray(patch)) {
    if (!Array.isArray(current)) return;
    for (const entry of patch) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      const stored = current.find((item) => item && String(item.id) === String(entry.id));
      if (!stored) continue;
      for (const [key, value] of Object.entries(stored)) {
        if (SECRET_KEY_PATTERN.test(key) && !SECRET_KEY_EXCLUDE.test(key) && !Object.hasOwn(entry, key)) {
          entry[key] = structuredClone(value);
        }
      }
      preserveSanitizedSecrets(stored, entry);
    }
    return;
  }
  for (const key of Object.keys(patch)) preserveSanitizedSecrets(current[key], patch[key]);
}

function synchronizeTier(store, source) {
  if (!store || typeof store !== 'object') return;
  if (source?.contextSliderPos !== undefined && source.contextSliderPos !== null) {
    store.contextSliderPos = source.contextSliderPos;
  } else if (source?.contextTier !== undefined || source?.randomPercent !== undefined) {
    store.contextSliderPos = tierToSlider(
      source?.contextTier ?? store.contextTier,
      source?.randomPercent ?? store.randomPercent
    );
    if (Number(source?.contextTier ?? store.contextTier) === 3 && store.contextSliderPos <= 20) {
      store.contextSliderPos = 20.01;
    }
  }
  if (store.contextSliderPos !== undefined && store.contextSliderPos !== null) {
    const { tier, randomPercent } = sliderToTier(store.contextSliderPos);
    store.contextTier = tier;
    store.randomPercent = randomPercent;
  }
}

export function normalizeStoredAgentConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw) : {};
  const migrated = stripObsoleteFields(migrateLegacySkills(source));
  const result = deepMerge(DEFAULT_CONFIG, migrated);
  stripDerivedConfigFlags(result);
  synchronizeTier(result.store, source.store);
  return result;
}

export function mergeAgentConfigPatch(current, patch) {
  const cleanPatch = stripObsoleteFields(stripDerivedConfigFlags(structuredClone(patch ?? {})));
  preserveSanitizedSecrets(current, cleanPatch);
  const merged = deepMerge(current, cleanPatch);
  stripDerivedConfigFlags(merged);
  stripObsoleteFields(merged);
  synchronizeTier(merged.store, cleanPatch?.store);
  return merged;
}
