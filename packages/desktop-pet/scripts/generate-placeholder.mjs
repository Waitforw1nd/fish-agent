// Original geometric fish, generated entirely from elementary shapes; no external artwork.
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../resources/pets');
function crc32(bytes) { let c=0xffffffff; for(const b of bytes){c^=b;for(let i=0;i<8;i++) c=(c>>>1)^(0xedb88320&-(c&1));} return (c^0xffffffff)>>>0; }
function chunk(type,data) { const name=Buffer.from(type), out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,data])),data.length+8);return out; }
export function placeholderPng(alt) {
  const w=256,h=256, rows=Buffer.alloc((w*4+1)*h), body=alt?[244,159,93,255]:[75,177,191,255], fin=alt?[214,107,75,255]:[45,125,158,255];
  const ellipse=(x,y,cx,cy,rx,ry)=>((x-cx)/rx)**2+((y-cy)/ry)**2<=1;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    let color=[0,0,0,0];
    if ((x>=32&&x<=92&&Math.abs(y-130)<(x-32)*0.8) || ellipse(x,y,145,130,79,56)) color=fin;
    if (ellipse(x,y,145,127,73,50)) color=body;
    if (ellipse(x,y,165,145,36,20)) color=alt?[255,207,160,255]:[168,226,219,255];
    if (ellipse(x,y,180,113,8,8)) color=[30,55,66,255];
    if (ellipse(x,y,182,110,2,2)) color=[255,255,255,255];
    if (ellipse(x,y,127,130,12,19)) color=fin;
    const p=y*(w*4+1)+1+x*4; rows.set(color,p);
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) for (const [dir,id,name,alt] of [['placeholder','fish.placeholder','小青鱼',false],['placeholder-alt','fish.placeholder-alt','小橙鱼',true]]) {
  const dest=path.join(root,dir); await mkdir(dest,{recursive:true});
  const manifest={schemaVersion:1,id,version:'0.1.0',name,author:'Fish project',license:{id:'LicenseRef-Fish-Owned',file:'LICENSE.txt'},canvas:{width:256,height:256},anchor:{x:0.5,y:1},hitBox:{x:0.13,y:0.27,width:0.75,height:0.5},assets:{base:{type:'image',path:'idle.png'}},actions:{idle:{asset:'base',loop:true}},activityMap:{idle:'idle',thinking:'idle',talking:'idle',sleeping:'idle'},emotionMap:{neutral:'idle'},fallbackAction:'idle'};
  await writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(path.join(dest,'idle.png'),placeholderPng(alt));
  await writeFile(path.join(dest,'LICENSE.txt'),'Original geometric fish artwork created for the Fish project using scripts/generate-placeholder.mjs. No third-party artwork is used. The Fish project may use, modify, and distribute this placeholder artwork.\n');
}
