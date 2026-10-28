// 角色卡导入 HTTP 路由测试：preview 不落盘、import 写入 customPersonas、
// 名称截断/警告透传、旧的人设模板列表与删除接口保持兼容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-persona-route-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { createRoutes } = await import('../src/routes.js');
const { getConfig, updateConfig } = await import('../src/config.js');

const noop = () => {};
const routes = createRoutes({
  readBody: async (req) => req.body,
  log: noop,
  store: {}, memory: {}, sessions: {}, onebot: {}, orchestrator: {},
  emit: noop, localVersion: '0', compareSemver: () => 0, UPDATE_INFO_URL: '',
  sanitizeConfig: (x) => x, keyEndpointAllowed: () => true, sanitizeProvider: (x) => x,
  authorize: () => true,
  buildUsageStats: () => ({}), buildUsageBreakdown: () => ({}),
  reloadSkills: async () => ({})
});

const findRoute = (method, pattern) => {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `缺少路由 ${method} ${pattern}`);
  return r.handler;
};
const call = async (handler, body) => {
  const req = { body };
  const res = {};
  const result = await handler({
    req, res,
    url: new URL('http://127.0.0.1/'),
    pathname: '/',
    method: 'POST',
    match: null,
    json: (target, status, data) => {
      target.status = status;
      target.data = data;
      return data;
    }
  });
  return { res, result };
};

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '路由测试角色',
    description: '来自角色卡的描述',
    personality: '性格素材',
    scenario: '场景素材',
    mes_example: '示例对话',
    first_mes: '开场白不自动发送',
    system_prompt: 'SYSTEM_SHOULD_NOT_APPEAR',
    creator_notes: 'CREATOR_NOTES_SHOULD_NOT_APPEAR',
    character_book: { entries: [{ content: 'BOOK_SHOULD_NOT_APPEAR' }] }
  }
};

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}\n      ${error?.message ?? error}`); }
};

await check('preview 解析成功且不写入 customPersonas', async () => {
  updateConfig({ customPersonas: [] });
  const before = getConfig().customPersonas.length;
  const handler = findRoute('POST', '/api/persona-cards/preview');
  const { res } = await call(handler, { text: JSON.stringify(V2), filename: 'card.json' });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.card.spec, 'v2');
  assert.match(res.data.card.template.text, /来自角色卡的描述/);
  assert.doesNotMatch(res.data.card.template.text, /SYSTEM_SHOULD_NOT_APPEAR|CREATOR_NOTES|BOOK_SHOULD_NOT_APPEAR/);
  assert.ok(res.data.card.warnings.some((w) => w.includes('system_prompt')));
  assert.equal(getConfig().customPersonas.length, before);
});

await check('preview 非法输入返回 400', async () => {
  const handler = findRoute('POST', '/api/persona-cards/preview');
  const { res } = await call(handler, { text: '{"name":"空卡"}' });
  assert.equal(res.status, 400);
  assert.equal(res.data.ok, false);
  assert.match(res.data.error, /没有可导入/);
});

await check('import 写入 customPersonas（含 imported/cardMeta）', async () => {
  updateConfig({ customPersonas: [] });
  const handler = findRoute('POST', '/api/persona-cards/import');
  const { res } = await call(handler, {
    text: JSON.stringify(V2),
    name: '导入的人设',
    includeGreeting: true,
    includeExamples: true
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  const customs = getConfig().customPersonas;
  assert.equal(customs.length, 1);
  assert.equal(customs[0].name, '导入的人设');
  assert.equal(customs[0].imported, true);
  assert.equal(customs[0].cardMeta.spec, 'v2');
  assert.match(customs[0].text, /开场白不自动发送/);
  assert.match(customs[0].text, /# 角色卡：导入的人设/);
});

await check('persona-templates 列表返回导入元数据', async () => {
  const handler = findRoute('GET', '/api/persona-templates');
  const { res } = await call(handler, null);
  assert.equal(res.status, 200);
  const custom = res.data.templates.find((t) => t.id === 'custom_0');
  assert.ok(custom);
  assert.equal(custom.imported, true);
  assert.equal(custom.builtin, false);
  assert.equal(custom.cardMeta.spec, 'v2');
});

await check('导入名称超长截断到 50 字符', async () => {
  updateConfig({ customPersonas: [] });
  const handler = findRoute('POST', '/api/persona-cards/import');
  const { res } = await call(handler, { text: JSON.stringify(V2), name: '长'.repeat(120) });
  assert.equal(res.status, 200);
  assert.equal(getConfig().customPersonas[0].name.length, 50);
});

await check('DELETE persona-templates/custom_N 仍可用', async () => {
  updateConfig({ customPersonas: [{ name: 'a', text: 'x' }, { name: 'b', text: 'y' }] });
  const route = routes.find((x) => x.method === 'DELETE'
    && x.pattern instanceof RegExp
    && x.pattern.test('/api/persona-templates/custom_0'));
  assert.ok(route, '缺少 DELETE /api/persona-templates/(custom_N) 路由');
  const req = { body: {} };
  const resObj = {};
  await route.handler({
    req, res: resObj, url: new URL('http://127.0.0.1/'), pathname: '/api/persona-templates/custom_0',
    method: 'DELETE', match: ['/api/persona-templates/custom_0', 'custom_0'],
    json: (target, status, data) => { target.status = status; target.data = data; return data; }
  });
  assert.equal(resObj.status, 200);
  const names = getConfig().customPersonas.map((p) => p.name);
  assert.deepEqual(names, ['b']);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n角色卡路由：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
