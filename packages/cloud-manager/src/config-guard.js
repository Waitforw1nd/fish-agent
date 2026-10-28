const LOCKED_TOP_LEVEL = [
  'server', 'extensions', 'relay', 'channels', 'connection', 'snowluma',
  'providers', 'dshProviderKeys', 'providersSourceYaml', 'providersImported'
];

const LOCKED_API_KEYS = ['baseUrl', 'apiKey', 'provider', 'fallbackModels'];
const LOCKED_WEBSEARCH_KEYS = ['searchUrl', 'providers', 'custom'];

const GET_ROUTES = [
  /^\/api\/status$/,
  /^\/api\/version$/,
  /^\/api\/update-check$/,
  /^\/api\/config$/,
  /^\/api\/prompt-preview$/,
  /^\/api\/tools$/,
  /^\/api\/tools\/availability$/,
  /^\/api\/skills$/,
  /^\/api\/skills\/capabilities$/,
  /^\/api\/models$/,
  /^\/api\/sessions$/,
  /^\/api\/sessions\/[\w-]+$/,
  /^\/api\/chats$/,
  /^\/api\/chats\/(?:group|private)_\d+$/,
  /^\/api\/chats\/(?:group|private)_\d+\/messages$/,
  /^\/api\/memory-files$/,
  /^\/api\/memory-files\/(?:group|private)_\d+$/,
  /^\/api\/usage\/(?:stats|breakdown|prices)$/,
  /^\/api\/model-prices$/,
  /^\/api\/persona-templates$/,
  /^\/api\/vision\/results$/,
  /^\/api\/onebot\/(?:groups|friends)$/,
  /^\/api\/community\/blocklist$/,
  /^\/api\/logs$/,
  /^\/api\/events$/,
  /^\/api\/groups\/\d+\/members$/
];

const POST_ROUTES = [
  /^\/api\/config$/,
  /^\/api\/prompt-preview$/,
  /^\/api\/model-prices\/refresh$/,
  /^\/api\/persona-templates$/,
  /^\/api\/persona-cards\/(?:preview|import)$/,
  /^\/api\/vision\/scan$/,
  /^\/api\/skills\/(?:reload|cleanup|install-zip)$/,
  /^\/api\/skills\/[^/]+$/,
  /^\/api\/sessions\/clear-finished$/,
  /^\/api\/sessions\/[\w-]+\/(?:retry|abort)$/,
  /^\/api\/memory-files\/consolidate$/,
  /^\/api\/media-data$/,
  /^\/api\/chats\/(?:group|private)_\d+\/(?:wake|test-send|mark-read|clear|mute|delete-messages)$/,
  /^\/api\/pause$/,
  /^\/api\/logs\/level$/
];

const DELETE_ROUTES = [
  /^\/api\/sessions\/[\w-]+$/,
  /^\/api\/persona-templates\/custom_\d+$/,
  /^\/api\/memory-files\/(?:group|private)_\d+$/,
  /^\/api\/memory-files\/(?:group|private)_\d+\/members\/\d+$/,
  /^\/api\/pause$/
];

const PUT_ROUTES = [
  /^\/api\/memory-files\/(?:group|private)_\d+\/members\/\d+$/
];

export function isApiAllowed(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const list = verb === 'GET' || verb === 'HEAD' ? GET_ROUTES
    : verb === 'POST' ? POST_ROUTES
      : verb === 'DELETE' ? DELETE_ROUTES
        : verb === 'PUT' ? PUT_ROUTES : [];
  return list.some((pattern) => pattern.test(pathname));
}

function deleteWithWarning(target, key, warnings, prefix = '') {
  if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return;
  delete target[key];
  warnings.push(`${prefix}${key} 已锁定，云端配置未修改该字段`);
}

export function guardConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { patch: {}, warnings: ['配置必须是 JSON 对象'], blocked: true };
  }
  const out = structuredClone(patch);
  const warnings = [];
  for (const key of LOCKED_TOP_LEVEL) deleteWithWarning(out, key, warnings);
  if (out.api && typeof out.api === 'object') {
    for (const key of LOCKED_API_KEYS) deleteWithWarning(out.api, key, warnings, 'api.');
    if (out.api.model !== undefined && (typeof out.api.model !== 'string' || out.api.model.length > 200)) {
      delete out.api.model;
      warnings.push('api.model 不合法，已忽略');
    }
  }
  if (out.webSearch && typeof out.webSearch === 'object') {
    for (const key of LOCKED_WEBSEARCH_KEYS) deleteWithWarning(out.webSearch, key, warnings, 'webSearch.');
    stripNestedBaseUrl(out.webSearch, warnings, 'webSearch.');
  }
  if (out.security && typeof out.security === 'object' && out.security.allowPrivateImageHosts !== undefined) {
    out.security.allowPrivateImageHosts = false;
    warnings.push('security.allowPrivateImageHosts 在云端强制为 false');
  }
  if (Object.hasOwn(out, 'allowAllWhenEmpty')) {
    if (out.allowAllWhenEmpty !== false) warnings.push('allowAllWhenEmpty 在云端强制为 false');
    out.allowAllWhenEmpty = false;
  }
  if (out.tools && typeof out.tools === 'object' && out.tools.crossChatSend !== undefined) {
    if (out.tools.crossChatSend !== false) warnings.push('tools.crossChatSend 在云端强制为 false');
    out.tools.crossChatSend = false;
  }
  if (Object.hasOwn(out, 'apiKey') || Object.hasOwn(out, 'authToken')) {
    deleteWithWarning(out, 'apiKey', warnings);
    deleteWithWarning(out, 'authToken', warnings);
  }
  return { patch: out, warnings, blocked: false };
}

function stripNestedBaseUrl(node, warnings, prefix, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return;
  for (const [key, value] of Object.entries(node)) {
    if (/baseurl|endpoint|proxyurl|apiurl/i.test(key) && typeof value === 'string') {
      delete node[key];
      warnings.push(`${prefix}${key} 可被用于 SSRF，已锁定`);
    } else if (value && typeof value === 'object') {
      stripNestedBaseUrl(value, warnings, `${prefix}${key}.`, depth + 1);
    }
  }
}

export function guardApiBody({ method, pathname, body }) {
  const verb = String(method || 'GET').toUpperCase();
  if (pathname === '/api/config' && verb === 'POST') {
    return { body: guardConfigPatch(body), modified: false };
  }
  if (pathname === '/api/media-data' && verb === 'POST') {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
      return { body, modified: false };
    }
    let removed = 0;
    const items = body.items.slice(0, 20).map((item) => {
      if (!item || typeof item !== 'object') return item;
      const next = { ...item };
      if (Object.hasOwn(next, 'path') || Object.hasOwn(next, 'file') || Object.hasOwn(next, 'localPath')) {
        removed += 1;
        delete next.path;
        delete next.file;
        delete next.localPath;
      }
      return next;
    });
    return { body: { ...body, items }, modified: true, warnings: removed ? ['本地文件路径在云端不可读取，已忽略'] : [] };
  }
  return { body, modified: false };
}
