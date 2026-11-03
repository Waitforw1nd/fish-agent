import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-processing-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.QQ_AGENT_CLOUD = '1';
const { DesktopChannelClient } = await import('../modules/headless/desktop-channel.js');
const { DEFAULT_CONFIG, deepMerge, setRuntimeConfig } = await import('../src/config.js');
const { CONNECTION_DEFAULTS } = await import('../modules/headless/connection.js');
const { createHeadlessApp } = await import('../modules/headless/index.js');
const { skillManager } = await import('../src/skills/manager.js');
const user = '7459086882832384';
const event = {v:1,op:'msg.send',id:'failure-1',d:{segments:[{type:'text',data:{text:'fixture message'}}]}};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for(let i=0;i<300;i++){const value=fn();if(value)return value;await delay(10);}throw new Error('timeout'); }

test('desktop tools cannot touch shared stickers and reminder cancellation is scoped', async () => {
  const {buildToolDefs,executeTool}=await import('../src/tools.js');
  const {ReminderStore}=await import('../src/reminders.js');
  const defs=buildToolDefs(), reminders=new ReminderStore();
  const own=reminders.add({chatKey:'private:'+user,text:'own',dueAt:Date.now()+60000});
  const other=reminders.add({chatKey:'private:123',text:'other',dueAt:Date.now()+60000});
  const fired=reminders.add({chatKey:'private:'+user,text:'fired',dueAt:Date.now()+60000});reminders.markFired(fired.id);
  let touched=0;const stickers=new Proxy({}, {get(){touched++;throw Error('shared stickers accessed');}});
  const ctx={chatKey:'private:'+user,stickers,reminders};
  for(const name of ['send_sticker','list_stickers','get_sticker_image','sticker_note','collect_sticker']) {
    const result=await executeTool(defs,ctx,name,{stickerId:'x',messageId:'x'});
    assert.equal(result.isError,true,name);
  }
  assert.equal(touched,0);
  for(const onebot of [{platformFor:()=> 'qq'}, {platformFor:()=>{throw Error('unknown');}}]) {
    assert.equal((await executeTool(defs,{...ctx,onebot},'list_stickers',{})).isError,true);
  }
  assert.equal((await executeTool(defs,ctx,'cancel_reminder',{id:other.id})).isError,true);
  assert.equal((await executeTool(defs,ctx,'cancel_reminder',{id:fired.id})).isError,true);
  assert.equal(reminders.pending('private:123')[0].id,other.id);
  assert.equal((await executeTool(defs,ctx,'cancel_reminder',{id:own.id})).isError,undefined);
  const official = { chatKey: 'private:qqbot_user_OpenID', reminders };
  const rejected = await executeTool(defs, official, 'set_reminder', { text: 'should not be lost', delayMinutes: 1 });
  assert.equal(rejected.isError, true); assert.deepEqual(reminders.pending(official.chatKey), []);
  const allowed = await executeTool(defs, ctx, 'set_reminder', { text: 'desktop reminder', delayMinutes: 1 });
  assert.equal(allowed.isError, undefined); assert.equal(reminders.pending(ctx.chatKey).length, 1);
  let listed=0;const qq={chatKey:'private:123',stickers:{list:async()=>{listed++;return {stickers:[]};}}};
  assert.equal((await executeTool(defs,qq,'list_stickers',{})).isError,undefined);assert.equal(listed,1);
  const noIdentity={stickers};assert.equal((await executeTool(defs,noIdentity,'list_stickers',{})).isError,true);assert.equal(touched,0);
});

test('desktop prompt does not sync or include shared sticker content', async t => {
  const requests=[];const model=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fake',model:'fixture',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  setRuntimeConfig(deepMerge(DEFAULT_CONFIG,{api:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'test-key',model:'fixture'},wakeDelayMs:10,extensions:{hotReload:false},proactive:{enabled:false},connection:structuredClone(CONNECTION_DEFAULTS),channels:{desktop:{enabled:true}}}));
  const app=createHeadlessApp({env:{QQ_AGENT_HOST:'127.0.0.1',QQ_AGENT_PORT:'0',QQ_AGENT_TOKEN:'fixture-token',QQ_AGENT_ALLOWED_HOSTS:''},log:()=>{}});let ws;let syncs=0;
  app.stickers.sync=async()=>{syncs++;return {entries:[{id:'private-sticker',desc:'SECRET_STICKER_FIXTURE'}]};};
  t.after(async()=>{ws?.terminate();await app.stop();app.server.closeAllConnections();await new Promise(r=>model.close(r));});
  const port=await app.start();ws=new WebSocket(`ws://127.0.0.1:${port}/channels/desktop/ws`,{headers:{'x-console-token':'fixture-token','x-fish-device-id':'device1','x-fish-desktop-user':user}});const frames=[];ws.on('message',x=>frames.push(JSON.parse(x)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({v:1,op:'hello',d:{deviceId:'device1'}}));await waitFor(()=>frames.some(x=>x.op==='ready'));ws.send(JSON.stringify({...event,id:'prompt-check',d:{segments:[{type:'text',data:{text:'prompt isolation fixture'}}]}}));
  await waitFor(()=>requests.length>0);assert.equal(syncs,0);assert.doesNotMatch(JSON.stringify(requests),/SECRET_STICKER_FIXTURE/);
});

test('same client ID across devices has isolated in-progress receipts and distinct durable messages',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-cross-device-'));const server=http.createServer();
  let release, calls=0;const gate=new Promise(r=>{release=r;});
  const client=new DesktopChannelClient({server,dataDir,token:()=> 'fixture',onEvent:async()=>{calls++;if(calls===1)await gate;}});
  const sockets=[];t.after(async()=>{release();for(const socket of sockets)socket.terminate();client.close();await new Promise(r=>server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  await client.connect();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  async function attach(device){const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/channels/desktop/ws`,{headers:{'x-console-token':'fixture','x-fish-device-id':device,'x-fish-desktop-user':user}});sockets.push(ws);const frames=[];ws.on('message',raw=>frames.push(JSON.parse(raw)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({v:1,op:'hello',d:{deviceId:device,capabilities:['receipt.v1','input-history.v1']}}));await waitFor(()=>frames.find(x=>x.op==='input.replay.end'));return {ws,frames};}
  const a=await attach('a'), b=await attach('b');const message={...event,id:'same-id'};
  a.ws.send(JSON.stringify(message));await waitFor(()=>calls===1);
  b.ws.send(JSON.stringify({v:1,op:'msg.status',id:message.id}));await waitFor(()=>b.frames.find(x=>x.op==='msg.status'));assert.equal(b.frames.find(x=>x.op==='msg.status').d.status,'unknown');
  b.ws.send(JSON.stringify(message));release();await waitFor(()=>a.frames.find(x=>x.op==='msg.ack')&&b.frames.find(x=>x.op==='msg.ack'));
  assert.equal(calls,2);assert.notEqual(a.frames.find(x=>x.op==='msg.ack').d.messageId,b.frames.find(x=>x.op==='msg.ack').d.messageId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir,'desktop-outbox.json'),'utf8'))[user].seen.map(x=>x[0]).sort(),['a:same-id','b:same-id']);
});

test('a failure after chat persistence never turns into an accepted retry, even after restart', async t => {
  setRuntimeConfig(deepMerge(DEFAULT_CONFIG,{extensions:{hotReload:false},proactive:{enabled:false},connection:structuredClone(CONNECTION_DEFAULTS),channels:{desktop:{enabled:true}}}));
  const original=skillManager.runMessageCommands; let calls=0, app, ws;
  skillManager.runMessageCommands=async()=>{calls++;throw new Error('fault after persistence');};
  const boot=async()=>{app=createHeadlessApp({env:{QQ_AGENT_HOST:'127.0.0.1',QQ_AGENT_PORT:'0',QQ_AGENT_TOKEN:'fixture-token',QQ_AGENT_ALLOWED_HOSTS:''},log:()=>{}});const port=await app.start();ws=new WebSocket(`ws://127.0.0.1:${port}/channels/desktop/ws`,{headers:{'x-console-token':'fixture-token','x-fish-device-id':'device1','x-fish-desktop-user':user}});const frames=[];ws.on('message',x=>frames.push(JSON.parse(x)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});ws.send(JSON.stringify({v:1,op:'hello',d:{deviceId:'device1',resumeSeq:0}}));await waitFor(()=>frames.find(x=>x.op==='ready'));return frames;};
  const stop=async()=>{ws?.terminate();await app?.stop();app?.server.closeAllConnections();};
  t.after(async()=>{skillManager.runMessageCommands=original;await stop();fs.rmSync(dir,{recursive:true,force:true});});
  let frames=await boot(); ws.send(JSON.stringify(event));await waitFor(()=>frames.find(x=>x.op==='error'&&x.d.id===event.id));assert.equal(calls,1);assert.ok(app.store.findByMid('private:'+user, 'desktop-'+(await import('node:crypto')).createHash('sha256').update(user+':device1:'+event.id).digest('hex')));
  ws.send(JSON.stringify(event));await waitFor(()=>frames.filter(x=>x.d?.id===event.id).length===2);assert.equal(frames.filter(x=>x.d?.id===event.id).at(-1).op,'error');assert.equal(calls,1);
  await stop(); frames=await boot();ws.send(JSON.stringify(event));await waitFor(()=>frames.find(x=>x.d?.id===event.id));assert.equal(frames.find(x=>x.d?.id===event.id).op,'error');assert.equal(calls,1);
  // Successful processing clears the marker. Loss of only the ACK index must
  // retain the existing history-based deduplication without rerunning commands.
  skillManager.runMessageCommands=async()=>{calls++;return {handled:false};};
  const ok={...event,id:'success-1'};
  ws.send(JSON.stringify(ok));await waitFor(()=>frames.find(x=>x.op==='msg.ack'&&x.d.id===ok.id));assert.equal(calls,2);
  await stop();
  const file=path.join(dir,'desktop-outbox.json');const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const state of Object.values(saved))state.seen=[];
  fs.writeFileSync(file,JSON.stringify(saved));
  frames=await boot();ws.send(JSON.stringify(ok));await waitFor(()=>frames.find(x=>x.d?.id===ok.id));
  assert.equal(frames.find(x=>x.d?.id===ok.id).op,'msg.ack');assert.equal(calls,2);
});
