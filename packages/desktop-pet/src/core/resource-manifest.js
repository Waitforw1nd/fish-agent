const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 120;
const key = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export function isSafeResourcePath(value) {
  return typeof value === 'string' && value.length <= 240 && /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9_.\/-]+$/.test(value) && !value.includes('//');
}
export function validateManifest(m) {
  const fail = () => { throw new Error('Invalid resource manifest'); };
  if (!object(m) || m.schemaVersion !== 1 || !text(m.id) || !/^[a-zA-Z0-9_.-]+$/.test(m.id) || !text(m.name) || !text(m.version) || !text(m.author) || !object(m.license) || !text(m.license.id) || !isSafeResourcePath(m.license.file)) fail();
  if (!object(m.canvas) || !Number.isInteger(m.canvas.width) || !Number.isInteger(m.canvas.height) || m.canvas.width < 1 || m.canvas.height < 1 || m.canvas.width > 2048 || m.canvas.height > 2048) fail();
  if (!object(m.anchor) || ![m.anchor.x, m.anchor.y].every(n => typeof n === 'number' && n >= 0 && n <= 1)) fail();
  const h = m.hitBox;
  if (!object(h) || ![h.x,h.y,h.width,h.height].every(n => typeof n === 'number' && n >= 0 && n <= 1) || !h.width || !h.height || h.x+h.width > 1 || h.y+h.height > 1) fail();
  if (!object(m.assets) || !Object.keys(m.assets).length || Object.keys(m.assets).length > 64) fail();
  for (const [k,a] of Object.entries(m.assets)) if (!key(k) || !object(a) || a.type !== 'image' || !isSafeResourcePath(a.path) || !a.path.toLowerCase().endsWith('.png')) fail();
  if (!object(m.actions) || !Object.keys(m.actions).length || Object.keys(m.actions).length > 64) fail();
  for (const [k,a] of Object.entries(m.actions)) if (!key(k) || !object(a) || !key(a.asset) || !Object.hasOwn(m.assets,a.asset) || typeof a.loop !== 'boolean') fail();
  if (!key(m.fallbackAction) || !Object.hasOwn(m.actions,m.fallbackAction)) fail();
  for (const map of [m.activityMap,m.emotionMap]) {
    if (!object(map) || Object.keys(map).length > 64) fail();
    for (const [k,v] of Object.entries(map)) if (!key(k) || !key(v)) fail();
  }
  return m;
}
