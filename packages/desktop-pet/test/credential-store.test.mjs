import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from '../src/main/credential-store.js';
const mockStorage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from('encrypted:'+Buffer.from(text).toString('base64')),decryptString:data=>Buffer.from(data.toString().slice(10),'base64').toString()};
test('credential store persists atomically, rejects unavailable storage and preserves last snapshot',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-pet-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'device.enc');
  const store=createCredentialStore({file,storage:mockStorage,platform:'win32'});
  assert.deepEqual(store.load(),{});store.save({credentials:{deviceToken:'fdt_fixture'},state:{seq:2}});
  assert.equal(fs.readFileSync(file,'utf8').includes('fdt_fixture'),false);assert.equal(store.load().state.seq,2);
  const denied=createCredentialStore({file,storage:{...mockStorage,isEncryptionAvailable:()=>false},platform:'win32'});
  assert.throws(()=>denied.save({state:{seq:3}}),/安全存储/);assert.equal(store.load().state.seq,2);
  fs.mkdirSync(file+'.tmp');assert.throws(()=>store.save({state:{seq:4}}),/保存/);assert.equal(store.load().state.seq,2);store.clear();assert.deepEqual(store.load(),{});
});

test('encryption failures preserve existing ciphertext and expose no plaintext or raw exception',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-pet-encrypt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'device.enc'),store=createCredentialStore({file,storage:mockStorage,platform:'win32'});
  store.save({state:{seq:1}});const original=fs.readFileSync(file);
  const broken=createCredentialStore({file,platform:'win32',storage:{...mockStorage,encryptString(){throw Error('PRIVATE_FIXTURE');}}});
  assert.throws(()=>broken.save({credentials:{deviceToken:'PRIVATE_FIXTURE'}}),error=>/加密失败/.test(error.message)&&!String(error.stack).includes('PRIVATE_FIXTURE'));
  assert.deepEqual(fs.readFileSync(file),original);assert.equal(fs.existsSync(file+'.tmp'),false);
});
