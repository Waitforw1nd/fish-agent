import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { validateManifest } from '../core/resource-manifest.js';

const MAX_PACK = 20 * 1024 * 1024;
const inside = (root, target) => { const rel = path.relative(root, target); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
async function readBounded(root, relative, limit) {
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new Error('Resource path escapes pack');
  const actual = await fs.realpath(candidate);
  if (!inside(root, actual)) throw new Error('Resource symlink escapes pack');
  const file = await fs.open(actual, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Resource too large or not a file');
    // Bound reads even if a concurrently modified file grows after stat.
    const data = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await file.read(data, count, data.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size) throw new Error('Resource changed while reading');
    return data.subarray(0, count);
  } finally { await file.close(); }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function validatePng(data) {
  if (data.length < 45 || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG');
  let pos=8, width, height, depth, color, seenHeader=false, ended=false, seenData=false, afterData=false;
  const chunks=[];
  while (pos+12 <= data.length) {
    const length=data.readUInt32BE(pos), end=pos+12+length;
    if (end > data.length) throw new Error('Invalid PNG chunk');
    const type=data.toString('ascii',pos+4,pos+8), body=data.subarray(pos+8,pos+8+length);
    if (crc32(data.subarray(pos+4,pos+8+length)) !== data.readUInt32BE(pos+8+length)) throw new Error('Invalid PNG checksum');
    if (!seenHeader) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Invalid PNG header');
      width=body.readUInt32BE(0); height=body.readUInt32BE(4); depth=body[8]; color=body[9];
      if (!width || !height || width>2048 || height>2048 || depth!==8 || ![2,6].includes(color) || body[10] || body[11] || body[12]) throw new Error('Unsupported PNG format');
      seenHeader=true;
    } else if (type === 'IHDR') throw new Error('Duplicate PNG header');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk type');
    if (type === 'IDAT') { if (afterData) throw new Error('Non-contiguous PNG data'); seenData=true; chunks.push(body); }
    else if (seenData) afterData=true;
    if (type === 'IEND') { if (length || !seenData || end !== data.length) throw new Error('Invalid PNG end'); ended=true; break; }
    // Reject animation and unrecognized critical chunks.
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT' || (/^[A-Z]/.test(type) && !['IHDR','IDAT','IEND'].includes(type))) throw new Error('Unsupported PNG chunk');
    pos=end;
  }
  if (!ended) throw new Error('Incomplete PNG');
  const row=width*(color===6?4:3)+1, expected=row*height;
  const compressed=Buffer.concat(chunks);
  const decoded=inflateSync(compressed, {maxOutputLength:expected, info:true});
  const raw=decoded.buffer;
  if (decoded.engine.bytesWritten !== compressed.length || raw.length!==expected) throw new Error('Invalid PNG dimensions');
  for (let y=0;y<height;y++) if (raw[y*row]>4) throw new Error('Invalid PNG filter');
}
async function loadOne(packDir) {
  const root = await fs.realpath(packDir);
  const manifestBytes = await readBounded(root, 'manifest.json', 64*1024);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  let size=manifestBytes.length, serializedSize=0;
  const license=await readBounded(root, manifest.license.file, 64*1024); size+=license.length;
  const assets=Object.create(null), cache=new Map();
  for (const [key, asset] of Object.entries(manifest.assets)) {
    let data=cache.get(asset.path);
    if (!data) { data=await readBounded(root,asset.path,MAX_PACK-size); size+=data.length; validatePng(data); cache.set(asset.path,data); }
    serializedSize += data.length;
    if (serializedSize > MAX_PACK) throw new Error('Resource references exceed budget');
    assets[key]=`data:image/png;base64,${data.toString('base64')}`;
  }
  if (size>MAX_PACK) throw new Error('Resource pack too large');
  return {id:manifest.id,name:manifest.name,manifest,assets};
}
// Invalid selected packs fall back to the trusted built-in pack. If that pack is
// invalid too, reject rather than sending unvalidated paths to the renderer.
export async function loadResourcePack(packDir, fallbackDir) {
  try { return await loadOne(packDir); }
  catch (error) { if (!fallbackDir || path.resolve(packDir) === path.resolve(fallbackDir)) throw error; return loadOne(fallbackDir); }
}
