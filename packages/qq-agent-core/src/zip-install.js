// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
//
// 2026-10 加固（云托管）：
//   · 解压前检查中央目录：多盘/zip64、加密条目、链接/特殊文件、路径与 Windows
//     保留名、重名（含大小写）、文件/目录冲突、单文件/总量/压缩比
//   · 解压时限制 inflate 输出（maxOutputLength）并校验声明大小与 CRC32
//   · 任何写入失败回滚整个落地目录，避免半截插件被加载
//   · 可选 Ed25519 签名（signature.json）；云环境可用
//     QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS=1 拒绝未签名包
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|vbe|sh|scr|msi|com|pif|reg|hta|lnk|url)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_RATIO = 200;
const MAX_NAME_BYTES = 200;
const MAX_DEPTH = 12;
const MAX_SIGNATURE_BYTES = 64 * 1024;

export const ZIP_LIMITS = Object.freeze({
  maxFiles: MAX_FILES,
  maxTotalUncompressed: MAX_TOTAL,
  maxFileUncompressed: MAX_FILE,
  maxRatio: MAX_RATIO,
  maxNameBytes: MAX_NAME_BYTES,
  maxDepth: MAX_DEPTH
});

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodeName(raw) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('zip 条目名不是合法 UTF-8');
  }
}

function flagOn(value) {
  return value === undefined || String(value).trim() === ''
    ? null
    : /^(1|true|yes|on)$/i.test(String(value).trim());
}

function requireSigned() {
  return flagOn(process.env.QQ_AGENT_REQUIRE_SIGNED_EXTENSIONS) === true;
}

/**
 * 解析并校验条目名。返回规范化名称（反斜杠 → /，保留末尾目录斜杠）。
 * 拒绝绝对路径、盘符、..、控制字符、Windows 非法字符/保留名、过深路径。
 */
function safeEntryName(rawName) {
  if (!rawName || rawName.includes('\0')) throw new Error('zip 条目名为空或含 NUL');
  if (Buffer.byteLength(rawName, 'utf8') > MAX_NAME_BYTES) throw new Error(`zip 条目名过长：${rawName.slice(0, 60)}…`);
  const name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`安装包包含绝对路径：${name}`);
  const isDir = name.endsWith('/');
  if (name.split('/').length > MAX_DEPTH + 1) throw new Error(`安装包路径层级过深：${name}`);
  const segments = name.split('/');
  const checkCount = isDir ? segments.length - 1 : segments.length;
  for (let i = 0; i < checkCount; i++) {
    const seg = segments[i];
    if (!seg || seg === '.' || seg === '..') throw new Error(`安装包包含非法路径：${name}`);
    if (/[<>:"|?*\u0000-\u001f\u007f]/.test(seg)) throw new Error(`安装包路径含 Windows 非法字符：${name}`);
    if (/[. ]$/.test(seg)) throw new Error(`安装包路径含非法结尾：${name}`);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) {
      throw new Error(`安装包路径使用 Windows 保留名：${name}`);
    }
  }
  if (BANNED_EXT.test(name)) throw new Error(`安装包包含禁止的文件类型：${name}`);
  return name;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。 */
function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length < 22) throw new Error('不是有效的 zip 文件');
  const sig = (off) => buffer.readUInt32LE(off);

  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const countOnDisk = buffer.readUInt16LE(eocd + 8);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || cdDisk !== 0 || countOnDisk !== count) {
    throw new Error('不支持多卷 zip');
  }
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('不支持 zip64 安装包');
  }
  if (count > MAX_FILES) throw new Error(`文件数量过多（${count} > ${MAX_FILES}）`);
  if (cdOffset + cdSize > buffer.length || cdOffset + cdSize > eocd) {
    throw new Error('zip 中央目录越界');
  }

  let ptr = cdOffset;
  const files = [];
  const seen = new Set();
  const fileKeys = new Set();
  let total = 0;
  let declaredTotal = 0;

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > eocd || sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const flags = buffer.readUInt16LE(ptr + 8);
    const method = buffer.readUInt16LE(ptr + 10);
    // bit 0 = 加密；bit 6 = 强加密；bit 13 = 掩码头
    if (flags & 0x0001 || flags & 0x0040 || flags & 0x2000) throw new Error('不支持加密的 zip 条目');
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式（method=${method}）`);
    const crc = buffer.readUInt32LE(ptr + 16);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompSize = buffer.readUInt32LE(ptr + 24);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) throw new Error('不支持 zip64 条目');
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const extAttrs = buffer.readUInt32LE(ptr + 38);
    const localOff = buffer.readUInt32LE(ptr + 42);
    if (ptr + 46 + nameLen + extraLen + commentLen > eocd) throw new Error('zip 中央目录条目越界');

    const rawName = decodeName(buffer.subarray(ptr + 46, ptr + 46 + nameLen));
    const name = safeEntryName(rawName);

    // 外部属性：Unix mode 高 16 位；低字节 bit4 = DOS 目录
    const unixType = (extAttrs >>> 16) & 0xf000;
    const isDir = name.endsWith('/') || unixType === 0x4000 || (extAttrs & 0x10) !== 0;
    if (unixType === 0xa000) throw new Error(`安装包包含符号链接：${name}`);
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) {
      throw new Error(`安装包包含特殊文件：${name}`);
    }

    // 重名（大小写不敏感，Windows 上 A.js 与 a.js 会互相覆盖）
    const key = name.replace(/\/+$/, '').toLowerCase();
    if (!key) throw new Error('安装包包含空路径条目');
    if (seen.has(key)) throw new Error(`安装包包含重复路径：${name}`);
    seen.add(key);

    let data = null;
    if (!isDir) {
      if (uncompSize > MAX_FILE) throw new Error(`单个文件超过 8MB：${name}`);
      declaredTotal += uncompSize;
      // 先按声明大小拒绝，避免"解压完才发现超总量"——否则仍然先吃掉内存/CPU
      if (declaredTotal > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
      if (compSize === 0 && uncompSize > 0) throw new Error(`压缩条目大小异常：${name}`);
      if (method === 0 && compSize !== uncompSize) throw new Error(`存储条目大小不一致：${name}`);
      if (uncompSize > 1024 * 1024 && compSize > 0 && uncompSize / compSize > MAX_RATIO) {
        throw new Error(`压缩比异常（疑似 zip 炸弹）：${name}`);
      }
      if (localOff + 30 > buffer.length || sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > buffer.length) throw new Error(`zip 条目数据越界：${name}`);
      const localName = decodeName(buffer.subarray(localOff + 30, localOff + 30 + lNameLen));
      if (localName.replace(/\\/g, '/') !== name) throw new Error(`zip 本地头与中央目录名称不一致：${name}`);
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let out;
      if (method === 0) {
        if (compSize !== uncompSize) throw new Error(`存储条目大小不一致：${name}`);
        out = Buffer.from(raw);
      } else {
        try {
          out = inflateRawSync(raw, { maxOutputLength: Math.min(MAX_FILE, uncompSize) + 1 });
        } catch {
          throw new Error(`解压失败或超过声明大小：${name}`);
        }
      }
      if (out.length !== uncompSize) throw new Error(`解压后大小与声明不符：${name}`);
      if (crc32(out) !== crc) throw new Error(`CRC 校验失败：${name}`);
      total += out.length;
      if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
      data = out;
      fileKeys.add(key);
    }
    files.push({ name, data, isDir, crc, compSize, uncompSize });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  // 文件/目录前缀冲突：`a`（文件）与 `a/b`（文件）在磁盘上无法共存，
  // 写一半才报 ENOTDIR 已经落盘了，必须在解压前拒绝。
  for (const entry of files) {
    if (entry.isDir) continue;
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/').toLowerCase();
      if (fileKeys.has(ancestor)) throw new Error(`安装包文件与目录路径冲突：${entry.name}`);
    }
  }

  // 安全规则（与后端一致）
  for (const e of files) {
    const parts = e.name.split('/');
    if (e.name.startsWith('/') || parts.includes('..')) throw new Error(`安装包包含非法路径：${e.name}`);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return files;
}

function isSignatureFileName(name) {
  // 只认包根或唯一根目录下的 signature.json；插件自己 lib/signature.json 之类
  // 的数据文件不能被误当成签名清单。
  const parts = String(name).split('/');
  return parts.length <= 2 && parts[parts.length - 1].toLowerCase() === 'signature.json';
}

function findSignatureEntry(entries) {
  const hits = entries.filter((e) => !e.isDir && isSignatureFileName(e.name));
  if (hits.length > 1) throw new Error('安装包包含多个 signature.json');
  return hits[0] || null;
}

function loadTrustedKeys(options = {}) {
  const input = options.trustedKeys;
  const keys = [];
  const push = (keyId, pem) => {
    const text = String(pem || '').trim();
    if (text) keys.push({ keyId: String(keyId ?? ''), pem: text });
  };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [keyId, pem] of Object.entries(input)) push(keyId, pem);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') push('', item);
      else if (item && typeof item === 'object') push(item.keyId, item.pem || item.publicKey);
    }
  }
  const envJson = String(process.env.QQ_AGENT_EXTENSION_PUBLIC_KEYS || '').trim();
  if (envJson) {
    let parsed;
    try { parsed = JSON.parse(envJson); } catch { throw new Error('QQ_AGENT_EXTENSION_PUBLIC_KEYS 不是合法 JSON'); }
    if (parsed && typeof parsed === 'object') {
      for (const [keyId, pem] of Object.entries(parsed)) push(keyId, pem);
    }
  }
  const envSingle = String(process.env.QQ_AGENT_EXTENSION_PUBLIC_KEY || '').trim();
  if (envSingle) push('', envSingle);
  return keys;
}

/** 签名覆盖的清单摘要：按名称排序的 `sha256(data)  name\n` 再哈希。 */
function manifestDigest(entries) {
  const lines = entries
    .filter((e) => !e.isDir && !isSignatureFileName(e.name))
    .map((e) => `${crypto.createHash('sha256').update(e.data).digest('hex')}  ${e.name}\n`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('')).digest();
}

/**
 * 校验可选签名。未签名返回 {signed:false}；签名无效/无公钥直接抛错。
 * signature.json 格式：
 *   { "algorithm": "ed25519", "keyId": "...", "signature": "<base64>" }
 */
export function verifyZipSignature(entries, options = {}) {
  const sigEntry = findSignatureEntry(entries);
  if (!sigEntry) {
    if (options.requireSignature ?? requireSigned()) {
      throw new Error('安装包未签名，已被拒绝（云环境默认只允许已签名扩展）');
    }
    return { signed: false };
  }
  if (sigEntry.data.length > MAX_SIGNATURE_BYTES) throw new Error('signature.json 过大');
  let meta;
  try { meta = JSON.parse(sigEntry.data.toString('utf8')); }
  catch { throw new Error('signature.json 不是合法 JSON'); }
  if (!meta || typeof meta !== 'object' || String(meta.algorithm || '').toLowerCase() !== 'ed25519') {
    throw new Error('不支持的签名算法（仅支持 ed25519）');
  }
  const keyId = String(meta.keyId ?? '');
  const sigText = String(meta.signature ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sigText)) throw new Error('signature.json 的 signature 不是合法 base64');
  const signature = Buffer.from(sigText, 'base64');
  if (!signature.length) throw new Error('signature.json 缺少签名');

  const keys = loadTrustedKeys(options);
  if (!keys.length) throw new Error('安装包带签名，但本机没有配置可信公钥');
  // 单公钥配置（QQ_AGENT_EXTENSION_PUBLIC_KEY / 只传一个 PEM）没有 keyId，
  // 应当能验证任意 keyId 的签名；keyId 只用于多公钥时选择。
  const candidates = keyId ? keys.filter((k) => k.keyId === keyId || !k.keyId) : keys;
  if (!candidates.length) throw new Error(`签名 keyId「${keyId}」不在可信公钥列表中`);
  const digest = manifestDigest(entries);
  for (const key of candidates) {
    try {
      if (crypto.verify(null, digest, key.pem, signature)) {
        return { signed: true, keyId: key.keyId || keyId, algorithm: 'ed25519' };
      }
    } catch { /* 公钥格式错误 → 尝试下一个 */ }
  }
  throw new Error('安装包签名校验失败');
}

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀、禁链接/加密/重名
 *   · 文件数与解压总量上限（zip 炸弹防护）、解压后 CRC/大小校验
 *   · 可选签名校验（未签名时是否拒绝由 env/options 决定）
 * 返回 [{ name, data }]（仅文件条目，目录跳过；signature.json 不落盘）。
 */
export function validateZipStructure(buffer, options = {}) {
  const entries = parseZip(buffer);
  const signature = verifyZipSignature(entries, options);
  return entries
    .filter((e) => !e.isDir)
    .filter((e) => !isSignatureFileName(e.name))
    .map((e) => ({ name: e.name, data: e.data, signature }));
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · zip 里通常有一层与包同名的根目录（服务端打包格式 `<id>/...`），剥掉它
 *   · 没有统一根目录时用 preferId（服务器告知的 id）
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景：同 id 覆盖会丢用户改动，
 *     而且插件热重载正在 watch 旧目录，覆盖写一半会加载出半截代码）
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '', ...options } = {}) {
  const entries = validateZipStructure(buffer, options);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');

  // 剥统一根目录：所有条目都共享同一个第一段时去掉它
  const names = entries.map((e) => e.name);
  const firstSeg = names[0].split('/')[0];
  const strip = firstSeg && names.every((n) => n.startsWith(firstSeg + '/')) ? firstSeg.length + 1 : 0;
  const relNames = names.map((n) => n.slice(strip));
  if (relNames.some((n) => !n)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');

  // 落地目录名：优先 zip 根目录名，其次 preferId。非法字符直接清洗，避免
  // 目录名穿越到 baseDir 之外（entry 名已经过 safeEntryName，这里只处理 dirName）。
  const sanitizeDir = (value) => {
    const v = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 64);
    return /^[a-zA-Z0-9]/.test(v) ? v : '';
  };
  const dirName = sanitizeDir(strip ? firstSeg : preferId) || sanitizeDir(preferId) || 'module';
  // 冲突递增。用 mkdir（不带 recursive）原子占位：既避免"先 exists 再 mkdir"的
  // 竞态，也保证回滚时 rm 的一定是我们刚创建的目录 —— 绝不会删掉已有的用户插件。
  fs.mkdirSync(baseDir, { recursive: true });
  let finalName = '';
  for (let n = 0; n <= 100; n++) {
    const candidate = n === 0 ? dirName : `${dirName}_${n}`;
    try {
      fs.mkdirSync(path.join(baseDir, candidate));
      finalName = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!finalName) throw new Error(`同名扩展目录过多（${dirName}_0…_100），请先清理`);
  const target = path.join(baseDir, finalName);

  try {
    for (let i = 0; i < entries.length; i++) {
      const rel = relNames[i];
      // 二次防线：拼接结果必须仍在 target 内（解析后 path.relative 检查）
      const dest = path.join(target, ...rel.split('/'));
      const relCheck = path.relative(target, dest);
      if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new Error(`安装包包含非法路径：${entries[i].name}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entries[i].data, { flag: 'wx' });
    }
  } catch (error) {
    // 半截插件会被热重载/下次启动加载，必须整体回滚
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 回滚失败保留原错误 */ }
    throw error;
  }
  return finalName;
}
