import { asArray, asString, toObject } from './core.js';

export function normalizeAgentConfig(payload) {
  const root = toObject(payload);
  const config = toObject(root.config || root.settings || root);
  return { config, agentRunning: Boolean(root.agentRunning), lockedFields: asArray(root.lockedFields).map(String) };
}

export function normalizeAgentContacts(payload) {
  const source = toObject(payload);
  const item = (value, kind) => ({
    id: asString(value?.id ?? value?.groupId ?? value?.group_id ?? value?.userId ?? value?.user_id ?? value?.uin),
    name: asString(value?.name ?? value?.groupName ?? value?.group_name ?? value?.nickname ?? value?.remark),
    kind
  });
  return {
    online: Boolean(source.online),
    groups: asArray(source.groups).map((v) => item(v, 'group')).filter((v) => v.id),
    friends: asArray(source.friends).map((v) => item(v, 'private')).filter((v) => v.id)
  };
}

export function normalizeExtensions(payload) {
  const root = toObject(payload);
  const list = Array.isArray(payload) ? payload : root.extensions || root.items || [...asArray(root.plugins), ...asArray(root.skills)];
  return asArray(list).map((item) => ({
    ...toObject(item),
    id: asString(item?.id ?? item?.extId ?? item?.name),
    name: asString(item?.name ?? item?.id, '未命名扩展'),
    type: asString(item?.type ?? item?.kind, 'plugin'),
    version: asString(item?.version),
    source: asString(item?.source ?? item?.origin),
    blocked: Boolean(item?.blocked)
  })).filter((item) => item.id);
}

export function normalizeAgentList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  const root = toObject(payload);
  for (const key of [...keys, 'items', 'list']) if (Array.isArray(root[key])) return root[key];
  return [];
}
