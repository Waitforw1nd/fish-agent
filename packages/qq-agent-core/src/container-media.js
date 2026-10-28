import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';

export async function inlineImage(source, limit) {
  const value = String(source || '').trim();
  let bytes;
  const encoded = value.match(/^(?:base64:\/\/|data:image\/[\w.+-]+;base64,)([A-Za-z0-9+/]*={0,2})$/i);
  if (encoded) {
    if (encoded[1].length > Math.ceil(limit / 3) * 4) throw new Error('图片超过大小上限');
    bytes = Buffer.from(encoded[1], 'base64');
  } else if (/^https?:\/\//i.test(value)) {
    ({ buffer: bytes } = await safeFetchBinary(value, limit, { denyPrivate: true }));
  } else {
    let file;
    try { file = value.startsWith('file:') ? fileURLToPath(value) : path.resolve(value); } catch { throw new Error('图片路径无效'); }
    const rootPath = path.join(DATA_DIR, 'sticker-images');
    if (fs.lstatSync(rootPath).isSymbolicLink()) throw new Error('图片目录不能是符号链接');
    const root = fs.realpathSync(rootPath);
    const real = fs.realpathSync(file);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('图片路径不在受控数据目录');
    const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      const resolvedStat = fs.statSync(real);
      if (stat.dev !== resolvedStat.dev || stat.ino !== resolvedStat.ino) throw new Error('图片路径已变化');
      if (!stat.isFile() || stat.size > limit) throw new Error('图片无效或超过大小上限');
      bytes = Buffer.alloc(limit + 1);
      const size = fs.readSync(fd, bytes, 0, limit + 1, 0);
      bytes = bytes.subarray(0, size);
    } finally { fs.closeSync(fd); }
  }
  if (!bytes?.length || bytes.length > limit) throw new Error('图片为空或超过大小上限');
  return `base64://${bytes.toString('base64')}`;
}
