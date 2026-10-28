// zip 安装安全测试：解压前的中央目录校验、解压时的 CRC/大小校验、
// 路径/链接/加密/重名/zip 炸弹/签名门禁，以及正常安装闭环。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { validateZipStructure, unzipToModuleDir } from '../src/zip-install.js';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}\n      ${error?.message ?? error}`); }
};

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

/**
 * 手写 zip（与 market.js 的 writer 同格式），用于构造恶意/边界样本。
 * entry 可选：method/flags/extAttrs/crc/compSize/uncompSize/rawPayload/localName/diskNumber。
 */
function makeZip(entries, { comment = '', diskNumber = 0, entryCount = null } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const payload = e.rawPayload ? Buffer.from(e.rawPayload)
      : method === 8 ? deflateRawSync(data, { level: 9 }) : data;
    const compSize = e.compSize ?? payload.length;
    const uncompSize = e.uncompSize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const localNameBuf = Buffer.from(e.localName ?? e.name, 'utf8');
    const flags = e.flags ?? 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compSize, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(localNameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, localNameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compSize, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(e.extAttrs ?? 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);
    offset += lfh.length + localNameBuf.length + payload.length;
  }
  const cdStart = offset;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22 + Buffer.byteLength(comment));
  const count = entryCount ?? entries.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(diskNumber, 4);
  eocd.writeUInt16LE(diskNumber, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(Buffer.byteLength(comment), 20);
  eocd.write(comment, 22);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const skillJs = Buffer.from('export function setup() {}\n');

function assertReject(name, pattern, fn) {
  return check(name, async () => {
    await assert.rejects(fn, pattern);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-zip-sec-'));

console.log('\n=== 正常安装闭环 ===');
await check('合法 zip 可解析并列出文件', async () => {
  const zip = makeZip([
    { name: 'demo-skill/skill.json', data: JSON.stringify({ id: 'demo-skill' }) },
    { name: 'demo-skill/index.js', data: skillJs }
  ]);
  const entries = validateZipStructure(zip);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.signature.signed === false));
});

await check('合法 zip 解压到 skills/ 且剥掉统一根目录', async () => {
  const root = path.join(tmp, 'root-ok');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  const zip = makeZip([
    { name: 'demo-skill/skill.json', data: JSON.stringify({ id: 'demo-skill' }) },
    { name: 'demo-skill/index.js', data: skillJs }
  ]);
  const name = await unzipToModuleDir(zip, { root, type: 'skill' });
  assert.equal(name, 'demo-skill');
  assert.equal(fs.readFileSync(path.join(root, 'skills', name, 'index.js'), 'utf8'), skillJs.toString());
});

console.log('\n=== 路径 / 结构攻击 ===');
await assertReject('拒绝 ../ 路径穿越', /非法路径|绝对路径|路径层级/, async () => {
  validateZipStructure(makeZip([{ name: '../evil.js', data: skillJs }]));
});
await assertReject('拒绝绝对路径', /绝对路径/, async () => {
  validateZipStructure(makeZip([{ name: '/etc/evil.js', data: skillJs }]));
});
await assertReject('拒绝 Windows 盘符', /绝对路径/, async () => {
  validateZipStructure(makeZip([{ name: 'C:\\evil.js', data: skillJs }]));
});
await assertReject('拒绝反斜杠穿越', /非法路径/, async () => {
  validateZipStructure(makeZip([{ name: '..\\evil.js', data: skillJs }]));
});
await assertReject('拒绝中间 ..', /非法路径/, async () => {
  validateZipStructure(makeZip([{ name: 'a/../../evil.js', data: skillJs }]));
});
await assertReject('拒绝符号链接条目', /符号链接/, async () => {
  validateZipStructure(makeZip([{ name: 'link.js', data: skillJs, extAttrs: (0xa000 << 16) >>> 0 }]));
});
await assertReject('拒绝加密条目', /加密/, async () => {
  validateZipStructure(makeZip([{ name: 'a.js', data: skillJs, flags: 1 }]));
});
await assertReject('拒绝不支持的压缩方式', /压缩方式/, async () => {
  validateZipStructure(makeZip([{ name: 'a.js', data: skillJs, method: 99 }]));
});
await assertReject('拒绝大小写重名', /重复路径/, async () => {
  validateZipStructure(makeZip([
    { name: 'A.js', data: skillJs },
    { name: 'a.js', data: skillJs }
  ]));
});
await assertReject('拒绝文件/目录路径冲突', /冲突/, async () => {
  validateZipStructure(makeZip([
    { name: 'a', data: skillJs },
    { name: 'a/b.js', data: skillJs }
  ]));
});
await assertReject('拒绝 Windows 保留名', /保留名/, async () => {
  validateZipStructure(makeZip([{ name: 'CON.js', data: skillJs }]));
});
await assertReject('拒绝可执行文件', /禁止的文件类型/, async () => {
  validateZipStructure(makeZip([{ name: 'run.bat', data: Buffer.from('@echo off') }]));
});
await assertReject('拒绝多卷 zip', /多卷/, async () => {
  validateZipStructure(makeZip([{ name: 'a.js', data: skillJs }], { diskNumber: 1 }));
});
await assertReject('拒绝 zip64 标记', /zip64/, async () => {
  validateZipStructure(makeZip([{ name: 'a.js', data: skillJs }], { entryCount: 0xffff }));
});
await assertReject('拒绝本地头与中央目录名称不一致', /名称不一致/, async () => {
  validateZipStructure(makeZip([{ name: 'a.js', data: skillJs, localName: 'b.js' }]));
});

console.log('\n=== 大小 / 压缩炸弹 ===');
await assertReject('拒绝单个文件超过 8MB', /单个文件超过/, async () => {
  validateZipStructure(makeZip([{ name: 'huge.bin', data: Buffer.alloc(9 * 1024 * 1024, 1), method: 0 }]));
});
await assertReject('拒绝高压缩比 zip 炸弹', /压缩比异常/, async () => {
  validateZipStructure(makeZip([{ name: 'bomb.txt', data: Buffer.alloc(2 * 1024 * 1024, 0x61) }]));
});
await assertReject('拒绝 CRC 不匹配', /CRC/, async () => {
  const data = Buffer.from('hello');
  validateZipStructure(makeZip([{ name: 'a.txt', data, method: 0, crc: (crc32(data) + 1) >>> 0 }]));
});
await assertReject('拒绝声明大小与实际不符', /大小与声明不符|解压失败/, async () => {
  validateZipStructure(makeZip([{ name: 'a.txt', data: Buffer.from('hello'), method: 8, uncompSize: 200 }]));
});

console.log('\n=== 签名门禁 ===');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const signEntries = (entries, key = privateKey, keyId = 'test-key') => {
  const lines = entries
    .map((e) => `${crypto.createHash('sha256').update(Buffer.from(e.data)).digest('hex')}  ${e.name}\n`)
    .sort();
  const digest = crypto.createHash('sha256').update(lines.join('')).digest();
  const signature = crypto.sign(null, digest, key).toString('base64');
  return { name: 'signature.json', data: Buffer.from(JSON.stringify({ algorithm: 'ed25519', keyId, signature })) };
};
const unsignedEntries = [
  { name: 'signed-skill/skill.json', data: JSON.stringify({ id: 'signed-skill' }) },
  { name: 'signed-skill/index.js', data: skillJs }
];

await check('被篡改的签名被拒绝', async () => {
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  const tampered = signed.map((e) => e.name.endsWith('index.js') ? { ...e, data: Buffer.from('evil()') } : e);
  await assert.rejects(
    async () => validateZipStructure(makeZip(tampered), { trustedKeys: { 'test-key': pubPem } }),
    /签名校验失败/
  );
});

await check('未配置可信公钥时带签名也拒绝', async () => {
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  await assert.rejects(
    async () => validateZipStructure(makeZip(signed)),
    /没有配置可信公钥/
  );
});

await check('公钥不匹配时拒绝', async () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const otherPub = other.publicKey.export({ type: 'spki', format: 'pem' });
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  await assert.rejects(
    async () => validateZipStructure(makeZip(signed), { trustedKeys: { 'test-key': otherPub } }),
    /签名校验失败/
  );
});

await check('有效签名通过并过滤 signature.json', async () => {
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  const entries = validateZipStructure(makeZip(signed), { trustedKeys: { 'test-key': pubPem } });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.signature.signed === true && e.signature.keyId === 'test-key'));
});

await check('单公钥环境变量可验证任意 keyId 的签名', async () => {
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  const old = process.env.QQ_AGENT_EXTENSION_PUBLIC_KEY;
  process.env.QQ_AGENT_EXTENSION_PUBLIC_KEY = pubPem;
  try {
    const entries = validateZipStructure(makeZip(signed));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].signature.signed, true);
  } finally {
    if (old === undefined) delete process.env.QQ_AGENT_EXTENSION_PUBLIC_KEY;
    else process.env.QQ_AGENT_EXTENSION_PUBLIC_KEY = old;
  }
});

await check('有效签名可安装且 signature.json 不落盘', async () => {
  const root = path.join(tmp, 'root-signed');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  const signed = [...unsignedEntries, signEntries(unsignedEntries)];
  const name = await unzipToModuleDir(makeZip(signed), { root, type: 'skill', trustedKeys: { 'test-key': pubPem } });
  assert.ok(fs.existsSync(path.join(root, 'skills', name, 'skill.json')));
  assert.ok(!fs.existsSync(path.join(root, 'skills', name, 'signature.json')));
});

await check('QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS=1 拒绝未签名包', async () => {
  const old = process.env.QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS;
  process.env.QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS = '1';
  try {
    await assert.rejects(async () => validateZipStructure(makeZip(unsignedEntries)), /未签名/);
  } finally {
    if (old === undefined) delete process.env.QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS;
    else process.env.QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS = old;
  }
});

console.log('\n=== 落地目录名 ===');
await check('preferId 中的穿越字符被清洗且不逃出 root', async () => {
  const root = path.join(tmp, 'root-dirname');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  const zip = makeZip([{ name: 'skill.json', data: '{"id":"x"}' }]);
  const name = await unzipToModuleDir(zip, { root, type: 'skill', preferId: '../../evil' });
  assert.ok(!name.includes('/') && !name.includes('..'));
  assert.ok(fs.existsSync(path.join(root, 'skills', name, 'skill.json')));
});

await check('租户 ZIP 安装、重载失败回滚及清单校验', async () => {
  const { installExtensionZip } = await import('../src/extension-install.js');
  const oldIsolation = process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED;
  process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED = '1';
  const oldSkills = process.env.QQ_AGENT_SKILLS_DIR;
  const oldPlugins = process.env.QQ_AGENT_PLUGINS_DIR;
  process.env.QQ_AGENT_SKILLS_DIR = path.join(tmp, 'tenant', 'skills');
  process.env.QQ_AGENT_PLUGINS_DIR = path.join(tmp, 'tenant', 'plugins');
  const make = (code) => makeZip([{ name: 'skill.json', data: '{"id":"upload-test"}' }, { name: 'index.js', data: code }]);
  const target = path.join(process.env.QQ_AGENT_SKILLS_DIR, 'upload-test', 'index.js');
  try {
    await installExtensionZip(make('first'), { reload: async () => ({ loaded: [{ id: 'upload-test' }], failed: [] }) });
    await assert.rejects(() => installExtensionZip(make('broken'), { reload: async ({ reason }) => reason === 'zip-install' ? { loaded: [], failed: [{ id: 'upload-test', error: 'failed' }] } : { loaded: [{ id: 'upload-test' }], failed: [] } }), /failed/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'first');
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = installExtensionZip(make('second'), { reload: async () => { started(); await new Promise(resolve => { release = resolve; }); return { loaded: [{ id: 'upload-test' }], failed: [] }; } });
    await entered;
    const { loadPlugins } = await import('../src/plugin-loader.js');
    await loadPlugins({ log: () => {} });
    assert.equal(fs.readFileSync(target, 'utf8'), 'second', '首次扫描不能恢复正在安装的备份');
    await assert.rejects(() => installExtensionZip(make('third'), { reload: async () => ({}) }), /正在安装/);
    release();
    await pending;
    delete process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED;
    await assert.rejects(() => installExtensionZip(make('unsafe'), { reload: async () => ({}) }), /隔离未确认/);
    process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED = '1';
    await assert.rejects(() => installExtensionZip(makeZip([{ name: '../escape', data: 'x' }]), { reload: async () => ({}) }), /非法路径/);
    await assert.rejects(() => installExtensionZip(makeZip([{ name: 'skill.json', data: '{"id":"x"}' }]), { reload: async () => ({}) }), /入口/);
  } finally {
    if (oldIsolation === undefined) delete process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED; else process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED = oldIsolation;
    if (oldSkills === undefined) delete process.env.QQ_AGENT_SKILLS_DIR; else process.env.QQ_AGENT_SKILLS_DIR = oldSkills;
    if (oldPlugins === undefined) delete process.env.QQ_AGENT_PLUGINS_DIR; else process.env.QQ_AGENT_PLUGINS_DIR = oldPlugins;
  }
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nzip 安装安全：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
