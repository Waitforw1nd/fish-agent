// 角色卡导入测试：V1/V2/V3 JSON、PNG tEXt/zTXt/iTXt、
// 安全限额（深度/字符串/base64/CRC）与提示词边界（system_prompt/世界书不导入）。
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  PERSONA_CARD_LIMITS, parsePersonaCard, personaCardToTemplate, parsePngTextChunks
} from '../src/personas.js';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}\n      ${error?.message ?? error}`); }
};
const reject = (name, pattern, fn) => check(name, async () => {
  await assert.rejects(fn, pattern);
});

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data, crcOverride = null) {
  const typeBuf = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crcOverride == null ? crc32(Buffer.concat([typeBuf, data])) : crcOverride, 8 + data.length);
  return out;
}

function textChunk(keyword, text, type = 'tEXt') {
  if (type === 'tEXt') return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
  if (type === 'zTXt') {
    return chunk('zTXt', Buffer.concat([
      Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from(text, 'latin1'))
    ]));
  }
  if (type === 'iTXt') {
    return chunk('iTXt', Buffer.concat([
      Buffer.from(keyword, 'latin1'), Buffer.from([0, 0, 0]),
      Buffer.from([0]), Buffer.from([0]), Buffer.from(text, 'utf8')
    ]));
  }
  throw new Error(`unknown chunk ${type}`);
}

function makePng(chunks) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...chunks,
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '测试角色',
    description: '一位喜欢在群里潜水的老群友。',
    personality: '嘴硬心软，说话很短。',
    scenario: '在一个技术群里聊天。',
    first_mes: '来了来了，今天又摸鱼。',
    mes_example: '{{user}}: 在吗\n{{char}}: ？',
    system_prompt: 'IGNORE_SYSTEM_PROMPT',
    post_history_instructions: 'IGNORE_POST_HISTORY',
    creator_notes: 'SECRET_CREATOR_NOTES',
    tags: ['群友', '测试'],
    creator: 'tester',
    character_version: '1.2',
    alternate_greetings: ['备选开场白一', '备选开场白二'],
    character_book: { entries: [{ keys: ['测试'], content: 'BOOK_CONTENT_SHOULD_NOT_APPEAR' }] },
    assets: [{ type: 'icon', uri: 'ccdefault:' }]
  }
};

console.log('\n=== V1 / V2 / V3 JSON ===');
await check('V2 JSON 提取人设素材并排除 system_prompt/creator_notes/世界书', async () => {
  const parsed = parsePersonaCard(JSON.stringify(V2), { filename: 'card.json' });
  assert.equal(parsed.spec, 'v2');
  assert.equal(parsed.card.name, '测试角色');
  const template = personaCardToTemplate(parsed.card);
  assert.match(template.text, /喜欢在群里潜水/);
  assert.match(template.text, /嘴硬心软/);
  assert.match(template.text, /？/);
  assert.doesNotMatch(template.text, /IGNORE_SYSTEM_PROMPT/);
  assert.doesNotMatch(template.text, /IGNORE_POST_HISTORY/);
  assert.doesNotMatch(template.text, /SECRET_CREATOR_NOTES/);
  assert.doesNotMatch(template.text, /BOOK_CONTENT_SHOULD_NOT_APPEAR/);
  assert.ok(parsed.warnings.some((w) => w.includes('system_prompt')));
  assert.ok(parsed.warnings.some((w) => w.includes('世界书')));
  assert.ok(parsed.warnings.some((w) => w.includes('assets')));
});

await check('V1 顶层字段可用', async () => {
  const v1 = {
    name: 'V1 角色',
    description: 'V1 描述',
    personality: 'V1 性格',
    scenario: 'V1 场景',
    first_mes: 'V1 开场',
    mes_example: 'V1 示例'
  };
  const parsed = parsePersonaCard(JSON.stringify(v1));
  assert.equal(parsed.spec, 'v1');
  assert.equal(parsed.card.name, 'V1 角色');
  assert.equal(parsed.card.description, 'V1 描述');
});

await check('旧字段名 char_name/char_persona/char_greeting 兼容', async () => {
  const parsed = parsePersonaCard(JSON.stringify({
    char_name: '旧卡', char_persona: '旧描述', world_scenario: '旧场景', char_greeting: '旧开场'
  }));
  assert.equal(parsed.card.name, '旧卡');
  assert.equal(parsed.card.description, '旧描述');
  assert.equal(parsed.card.scenario, '旧场景');
  assert.equal(parsed.card.firstMes, '旧开场');
});

await check('V3 记录 assets / group_only_greetings / 备选开场白但不导入', async () => {
  const v3 = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      ...V2.data,
      name: 'V3 角色',
      assets: [{ type: 'icon', uri: 'ccdefault:' }, { type: 'background', uri: 'x' }],
      group_only_greetings: ['群聊开场一', '群聊开场二']
    }
  };
  const parsed = parsePersonaCard(JSON.stringify(v3));
  assert.equal(parsed.spec, 'v3');
  assert.equal(parsed.card.assetsCount, 2);
  assert.equal(parsed.card.groupOnlyGreetings, 2);
  assert.equal(parsed.card.alternateGreetings.length, 2);
  const template = personaCardToTemplate(parsed.card);
  assert.doesNotMatch(template.text, /备选开场白一/);
  assert.doesNotMatch(template.text, /群聊开场一/);
});

await check('有 data 但无 spec 时按 V2 兼容并警告', async () => {
  const parsed = parsePersonaCard(JSON.stringify({ data: { ...V2.data, name: '无 spec' } }));
  assert.equal(parsed.spec, 'v2');
  assert.ok(parsed.warnings.some((w) => w.includes('未声明 spec')));
});

console.log('\n=== PNG tEXt / zTXt / iTXt ===');
await check('PNG chara（V2 base64）可解析', async () => {
  const png = makePng([textChunk('chara', b64(V2))]);
  const parsed = parsePersonaCard(png, { filename: 'card.png' });
  assert.equal(parsed.format, 'png');
  assert.equal(parsed.card.name, '测试角色');
  assert.deepEqual(parsed.png, { width: 2, height: 2 });
});

await check('PNG 同时含 ccv3/chara 时优先 ccv3 并警告', async () => {
  const oldCard = { ...V2, data: { ...V2.data, name: '旧版本' } };
  const newCard = { ...V2, spec: 'chara_card_v3', spec_version: '3.0', data: { ...V2.data, name: '新版本' } };
  const png = makePng([
    textChunk('chara', b64(oldCard)),
    textChunk('ccv3', b64(newCard))
  ]);
  const parsed = parsePersonaCard(png);
  assert.equal(parsed.card.name, '新版本');
  assert.ok(parsed.warnings.some((w) => w.includes('优先使用 ccv3')));
});

await check('PNG zTXt 压缩文本块可解析', async () => {
  const parsed = parsePersonaCard(makePng([textChunk('chara', b64(V2), 'zTXt')]));
  assert.equal(parsed.card.name, '测试角色');
});

await check('PNG iTXt 文本块可解析', async () => {
  const parsed = parsePersonaCard(makePng([textChunk('ccv3', b64({ ...V2, spec: 'chara_card_v3' }), 'iTXt')]));
  assert.equal(parsed.card.name, '测试角色');
});

await check('PNG 文本块 CRC 损坏被拒绝', async () => {
  const bad = chunk('tEXt', Buffer.concat([Buffer.from('chara'), Buffer.from([0]), Buffer.from(b64(V2))]), 123456);
  await assert.rejects(async () => parsePersonaCard(makePng([bad])), /CRC/);
});

await check('PNG 缺少 IEND 被拒绝', async () => {
  const png = makePng([textChunk('chara', b64(V2))]);
  const truncated = png.subarray(0, png.length - 12);
  await assert.rejects(async () => parsePersonaCard(truncated), /IEND/);
});

await check('PNG 没有 chara/ccv3 被拒绝', async () => {
  await assert.rejects(async () => parsePersonaCard(makePng([])), /ccv3\/chara/);
});

await check('parsePngTextChunks 只暴露文本块', async () => {
  const { texts } = parsePngTextChunks(makePng([textChunk('chara', b64(V2))]));
  assert.ok(texts.get('chara'));
  assert.equal(texts.size, 1);
});

console.log('\n=== 提示词边界 ===');
await check('默认不导入开场白；勾选后只作为语气参考并警告', async () => {
  const parsed = parsePersonaCard(JSON.stringify(V2));
  const without = personaCardToTemplate(parsed.card, { includeGreeting: false });
  assert.doesNotMatch(without.text, /来了来了/);
  const withGreeting = personaCardToTemplate(parsed.card, { includeGreeting: true });
  assert.match(withGreeting.text, /来了来了/);
  assert.match(withGreeting.text, /不要主动发送/);
  assert.ok(parsed.warnings.some((w) => w.includes('不会自动发送')));
});

await check('只有开场白时不勾选则拒绝导入，勾选后可导入', async () => {
  const parsed = parsePersonaCard(JSON.stringify({ name: '只有开场白', first_mes: '你好呀' }));
  assert.throws(() => personaCardToTemplate(parsed.card), /没有可导入的设定内容/);
  const withGreeting = personaCardToTemplate(parsed.card, { includeGreeting: true });
  assert.match(withGreeting.text, /你好呀/);
});

await check('includeExamples=false 排除示例对话', async () => {
  const parsed = parsePersonaCard(JSON.stringify(V2));
  const t = personaCardToTemplate(parsed.card, { includeExamples: false });
  assert.doesNotMatch(t.text, /在吗/);
});

await check('{{char}}/{{user}} 占位符被替换', async () => {
  const parsed = parsePersonaCard(JSON.stringify(V2));
  const t = personaCardToTemplate(parsed.card);
  assert.match(t.text, /测试角色: ？/);
  assert.doesNotMatch(t.text, /\{\{char\}\}|\{\{user\}\}/);
});

console.log('\n=== 安全限额 ===');
await reject('拒绝过深的 JSON', /嵌套过深/, async () => {
  let node = { name: 'deep' };
  for (let i = 0; i < PERSONA_CARD_LIMITS.maxDepth + 2; i++) node = { child: node };
  parsePersonaCard(JSON.stringify({ ...V2, extra: node }));
});
await reject('拒绝超长字符串', /单个字符串过长/, async () => {
  parsePersonaCard(JSON.stringify({ ...V2, data: { ...V2.data, description: 'x'.repeat(PERSONA_CARD_LIMITS.maxStringLength + 1) } }));
});
await reject('拒绝非法 base64', /base64 数据含非法字符/, async () => {
  parsePersonaCard('not@@base64');
});
await reject('拒绝超限 base64 长度', /base64 数据过大/, async () => {
  parsePersonaCard('A'.repeat(PERSONA_CARD_LIMITS.maxBase64Chars + 4), { encoding: 'base64' });
});
await reject('拒绝顶层非对象 JSON', /顶层必须是对象/, async () => {
  parsePersonaCard('[1,2,3]');
});
await reject('拒绝没有可导入内容的卡片', /没有可导入的描述内容/, async () => {
  parsePersonaCard(JSON.stringify({ name: '空卡' }));
});
await check('清理 __proto__ / constructor 原型污染键并警告', async () => {
  const raw = `{"name":"污染卡","description":"正常描述","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}`;
  const parsed = parsePersonaCard(raw);
  assert.equal(parsed.card.name, '污染卡');
  assert.ok(parsed.warnings.some((w) => w.includes('原型污染')));
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
});
await check('名称从文件名兜底且最长 50 字符', async () => {
  const card = { description: '有描述但没名字' };
  const parsed = parsePersonaCard(JSON.stringify(card), { filename: 'fallback-name.json' });
  assert.equal(parsed.card.name, 'fallback-name');
  const long = { name: '超'.repeat(120), description: '描述' };
  const p2 = parsePersonaCard(JSON.stringify(long));
  assert.equal(p2.card.name.length, 50);
});

console.log(`\n角色卡解析：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
