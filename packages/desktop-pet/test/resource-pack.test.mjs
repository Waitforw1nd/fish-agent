import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResourcePack } from '../src/main/resource-pack-loader.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/pets');
const base=path.join(root,'placeholder'), alt=path.join(root,'placeholder-alt');
async function fixture(fn) { const tmp=await mkdtemp(path.join(os.tmpdir(),'fish-pack-')); try { await cp(base,path.join(tmp,'pack'),{recursive:true}); await fn(path.join(tmp,'pack'),tmp); } finally {await rm(tmp,{recursive:true,force:true});} }
test('two original packs can be loaded and replaced',async()=>{ const a=await loadResourcePack(base), b=await loadResourcePack(alt); assert.notEqual(a.id,b.id); assert.notEqual(a.assets.base,b.assets.base); assert.match(a.assets.base,/^data:image\/png;base64,/); });
test('invalid manifest, paths, bytes and dimensions fall back',async()=>fixture(async(dir)=>{
  const original=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  for (const change of [m=>m.schemaVersion=2,m=>m.assets.base.path='../idle.png',m=>m.assets.base.path='C:/idle.png']) {
    const m=structuredClone(original); change(m); await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m)); assert.equal((await loadResourcePack(dir,alt)).id,'fish.placeholder-alt');
  }
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(original));
  const png=await readFile(path.join(dir,'idle.png')); png.writeUInt32BE(3000,16); await writeFile(path.join(dir,'idle.png'),png); assert.equal((await loadResourcePack(dir,alt)).id,'fish.placeholder-alt');
  await rm(path.join(dir,'idle.png')); assert.equal((await loadResourcePack(dir,alt)).id,'fish.placeholder-alt');
}));
test('symlink outside pack is rejected',async t=>fixture(async(dir,tmp)=>{
  await rm(path.join(dir,'idle.png'));
  try { await symlink(path.join(base,'idle.png'),path.join(dir,'idle.png')); } catch(e) { if (['EPERM','EACCES'].includes(e.code)) {t.skip('symlink privilege unavailable'); return;} throw e; }
  await assert.rejects(loadResourcePack(dir)); assert.equal((await loadResourcePack(dir,alt)).id,'fish.placeholder-alt');
}));
test('directory junction outside pack is rejected',async()=>fixture(async(dir,tmp)=>{
  const external=path.join(tmp,'outside'); await cp(base,external,{recursive:true});
  await symlink(external,path.join(dir,'linked'),'junction');
  const manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')); manifest.assets.base.path='linked/idle.png';
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(loadResourcePack(dir)); assert.equal((await loadResourcePack(dir,alt)).id,'fish.placeholder-alt');
}));
test('prototype keys, inherited references and unsafe paths are rejected',async()=>fixture(async(dir)=>{
  const original=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  const variants=[
    JSON.parse('{"__proto__":{"type":"image","path":"idle.png"}}'),
    {constructor:{type:'image',path:'idle.png'}},
  ];
  for (const assets of variants) { const m=structuredClone(original); m.assets=assets; await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m)); await assert.rejects(loadResourcePack(dir)); }
  for (const bad of ['//server/a.png','/tmp/a.png','sub/../idle.png','https://x/a.png','sub\\idle.png']) { const m=structuredClone(original); m.assets.base.path=bad; await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m)); await assert.rejects(loadResourcePack(dir)); }
  const m=structuredClone(original); m.actions.idle.asset='constructor'; await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m)); await assert.rejects(loadResourcePack(dir));
}));
test('manifest and referenced image budget are bounded',async()=>fixture(async(dir)=>{
  await writeFile(path.join(dir,'manifest.json'),' '.repeat(65537)); await assert.rejects(loadResourcePack(dir));
  const m=JSON.parse(await readFile(path.join(base,'manifest.json'),'utf8'));
  const png=await readFile(path.join(base,'idle.png'));
  function crc32(bytes) { let c=0xffffffff; for (const b of bytes) { c^=b; for(let i=0;i<8;i++) c=(c>>>1)^(0xedb88320&-(c&1)); } return (c^0xffffffff)>>>0; }
  const data=Buffer.alloc(400000), chunk=Buffer.alloc(data.length+12); chunk.writeUInt32BE(data.length); chunk.write('tEXt',4); data.copy(chunk,8); chunk.writeUInt32BE(crc32(chunk.subarray(4,8+data.length)),8+data.length);
  await writeFile(path.join(dir,'idle.png'),Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)]));
  m.assets={}; for(let i=0;i<64;i++) m.assets['a'+i]={type:'image',path:'idle.png'}; m.actions.idle.asset='a0';
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m)); await assert.rejects(loadResourcePack(dir),/budget/);
}));
test('PNG dimensions and decompression are checked after valid checksums',async()=>fixture(async(dir)=>{
  function crc32(bytes) { let c=0xffffffff; for (const b of bytes) {c^=b; for(let i=0;i<8;i++) c=(c>>>1)^(0xedb88320&-(c&1));} return (c^0xffffffff)>>>0; }
  const png=await readFile(path.join(base,'idle.png'));
  const huge=Buffer.from(png); huge.writeUInt32BE(2049,16); huge.writeUInt32BE(crc32(huge.subarray(12,29)),29); await writeFile(path.join(dir,'idle.png'),huge); await assert.rejects(loadResourcePack(dir),/PNG format/);
  const incorrect=Buffer.from(png); incorrect.writeUInt32BE(255,16); incorrect.writeUInt32BE(crc32(incorrect.subarray(12,29)),29); await writeFile(path.join(dir,'idle.png'),incorrect); await assert.rejects(loadResourcePack(dir));
}));
