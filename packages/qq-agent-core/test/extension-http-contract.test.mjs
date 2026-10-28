import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-http-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
process.env.QQ_AGENT_SKILLS_DIR = path.join(tmp, 'skills');
process.env.QQ_AGENT_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED = '1';
process.env.QQ_AGENT_CLOUD = '1';
const { createHeadlessApp } = await import('../modules/headless/index.js');
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
const { getTool } = await import('../src/tool-registry.js');
function zip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), n = Buffer.from(name), compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(8,8); h.writeUInt32LE(crc,14); h.writeUInt32LE(compressed.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(n.length,26);
    locals.push(h,n,compressed);
    const c=Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(8,10); c.writeUInt32LE(crc,16); c.writeUInt32LE(compressed.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(n.length,28); c.writeUInt32LE(offset,42); central.push(c,n); offset+=h.length+n.length+compressed.length;
  }
  const dir=Buffer.concat(central), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length,8); end.writeUInt16LE(Object.keys(files).length,10); end.writeUInt32LE(dir.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,dir,end]);
}
test('real core HTTP upload loads and calls tool, with fail-closed and request validation', async t => {
  setRuntimeConfig(deepMerge(DEFAULT_CONFIG, { extensions: { hotReload: false }, proactive: { enabled: false } }));
  const env = { QQ_AGENT_HOST: '127.0.0.1', QQ_AGENT_PORT: '0', QQ_AGENT_TOKEN: 'fixture-token' };
  const app = createHeadlessApp({ env, log: () => {} });
  t.after(async () => { await app.stop(); app.server.closeAllConnections(); fs.rmSync(tmp,{recursive:true,force:true}); });
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const status = await (await fetch(`${base}/api/skills`, { headers: { 'x-console-token': 'fixture-token' } })).json();
  for (const id of ['anti-ban-guard', 'trpg-dice-hook', 'bili-watcher', 'bili-agent-pack']) assert.ok(status.skills.some(skill => skill.id === id), `missing builtin ${id}`);
  assert.equal(status.skills.find(skill => skill.id === 'anti-ban-guard').enabled, false);
  assert.equal(status.skills.find(skill => skill.id === 'bili-watcher').enabled, true);
  assert.equal(status.skills.find(skill => skill.id === 'trpg-dice-hook').enabled, true);
  const post = (body, headers={}) => fetch(`${base}/api/skills/install-zip`, { method:'POST', headers: { 'content-type':'application/json', 'x-console-token':'fixture-token', ...headers }, body: JSON.stringify(body) });
  const data = zip({ 'skill.json': JSON.stringify({id:'http-fixture'}), 'index.js': "export function setup(api){api.registerTool({id:'probe',name:'probe',execute:()=>({content:'installed'})})}" }).toString('base64');
  delete process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED;
  assert.equal((await post({base64:data})).status,400);
  process.env.QQ_AGENT_EXTENSION_ISOLATION_CONFIRMED='1';
  assert.equal((await post({base64:data},{origin:'http://evil.example'})).status,403);
  assert.equal((await post({base64:'AB=='})).status,400);
  const response=await post({base64:data}); assert.equal(response.status,200,await response.text());
  assert.equal((await getTool('http-fixture__probe').execute({},{})).content,'installed');
});
