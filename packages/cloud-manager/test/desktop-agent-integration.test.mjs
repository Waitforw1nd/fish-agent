import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { startManager, loginAdmin, request, waitFor } from './helpers.mjs';
import { REPO_ROOT } from '../src/config.js';
const {WebSocket}=createRequire(import.meta.url)('ws');

function localModel() {
  let calls=0;const server=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer local-fixture-key'){res.writeHead(401).end();return;}
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'deepseek-chat'}]}));return;}
    let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);calls++;
    const done=body.messages.some(m=>m.role==='tool'&&m.name==='send_message');const name=done?'finish':'send_message';const args=done?{reason:'done'}:{messages:['local fixture reply']};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`local-${calls}`,model:'deepseek-chat',usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25},choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:`call-${calls}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
  });return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({base:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();}),get calls(){return calls;}})));
}
async function connect(base,device,seq=0){const ws=new WebSocket(base.replace('http:','ws:')+'/desktop/v1/ws',{headers:{authorization:`Bearer ${device.deviceToken}`}});const messages=[];ws.on('message',raw=>{try{messages.push(JSON.parse(raw));}catch{}});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({v:1,op:'hello',d:{deviceId:device.deviceId,resumeSeq:seq}}));await waitFor(()=>messages.find(m=>m.op==='ready'),{label:'desktop ready'});return {ws,messages};}

test('real headless desktop reaches local Relay, meters, replays and isolates tenants', {timeout:45000}, async t=>{
  const model=await localModel();t.after(()=>model.close());const entry=path.join(REPO_ROOT,'packages','qq-agent-core','modules','headless','server.js');const env=await startManager({agentEntry:entry});t.after(()=>env.stop());const {manager}=env;const admin=await loginAdmin(manager);const base=`http://127.0.0.1:${manager.config.panelPort}`;
  const configured=await admin.call('/api/admin/upstream',{method:'PUT',body:{baseUrl:model.base,apiKey:'local-fixture-key'}});assert.equal(configured.status,200,configured.text);
  async function makeTenant(slug){const created=await admin.createTenant({name:slug,slug,planId:'starter'});assert.equal(created.status,201,created.text);const id=created.json.tenant.id;const enabled=await admin.call(`/api/tenants/${id}/entries/desktop`,{method:'PUT',body:{enabled:true}});assert.equal(enabled.status,200,enabled.text);const code=await admin.call(`/api/tenants/${id}/desktop/pairing-codes`,{method:'POST'});assert.equal(code.status,201,code.text);const pair=await request(base,{method:'POST',path:'/desktop/v1/pair',body:{code:code.json.code,deviceName:'local test',os:'win32'}});assert.equal(pair.status,200,pair.text);const started=await admin.startTenant(id);assert.equal(started.status,200,`${started.text}\n${manager.supervisor.logs(id,'agent').join('\n')}`);assert.equal(manager.supervisor.status(id,'qq').state,'stopped');return{id,device:pair.json};}
  const a=await makeTenant('desktop-e2e-a'),b=await makeTenant('desktop-e2e-b');const first=await connect(base,a.device);const second=await connect(base,b.device);t.after(()=>{first.ws.terminate();second.ws.terminate();});
  first.ws.send(JSON.stringify({v:1,op:'msg.send',id:'client-local-1',d:{segments:[{type:'text',data:{text:'hello local fish'}}]}}));
  await waitFor(()=>first.messages.find(m=>m.op==='msg.ack'&&m.d?.id==='client-local-1'),{timeoutMs:15000,label:'ingestion ack'});
  const push=await waitFor(()=>first.messages.find(m=>m.op==='msg.push'),{timeoutMs:20000,label:'LLM reply'});assert.match(JSON.stringify(push.d.segments),/local fixture reply/);assert.equal(second.messages.some(m=>m.op==='msg.push'),false);assert.ok(model.calls>0);
  await waitFor(()=>manager.db.prepare("SELECT COUNT(*) n FROM ledger WHERE tenant_id=? AND platform='desktop' AND entry='desktop'").get(a.id).n>0,{timeoutMs:10000,label:'desktop ledger'});
  await waitFor(()=>{const meters=manager.billingProvider.usage({tenantId:a.id}).map(x=>x.meter);return ['desktop.llm.tokens','desktop.message.in','desktop.message.out'].every(x=>meters.includes(x));},{timeoutMs:15000,label:'desktop meter flush'});
  assert.equal(manager.billingProvider.usage({tenantId:b.id}).some(x=>x.meter.startsWith('desktop.message.')||x.meter==='desktop.llm.tokens'),false);
  first.ws.close();await new Promise(resolve=>first.ws.once('close',resolve));const replay=await connect(base,a.device,0);t.after(()=>replay.ws.terminate());await waitFor(()=>replay.messages.some(m=>m.op==='msg.push'&&m.seq===push.seq));const pushes=replay.messages.filter(m=>m.op==='msg.push');assert.equal(pushes.some(m=>m.d?.messageId!==push.d.messageId),false);
  // Simulate a crash after history persistence but before the ACK index was stored.
  assert.equal((await admin.call(`/api/tenants/${a.id}/stop`, {method:'POST'})).status,200);
  const outboxFile=path.join(manager.tenants.row(a.id).data_dir,'data','desktop-outbox.json');
  const outbox=JSON.parse(fs.readFileSync(outboxFile,'utf8'));
  for(const user of Object.values(outbox)) user.seen=[];
  fs.writeFileSync(outboxFile,JSON.stringify(outbox));
  assert.equal((await admin.startTenant(a.id)).status,200);
  const recovered=await connect(base,a.device,push.seq);t.after(()=>recovered.ws.terminate());
  const callsBefore=model.calls;
  recovered.ws.send(JSON.stringify({v:1,op:'msg.send',id:'client-local-1',d:{segments:[{type:'text',data:{text:'hello local fish'}}]}}));
  await waitFor(()=>recovered.messages.some(m=>m.op==='msg.ack'&&m.d?.id==='client-local-1'));
  await new Promise(r=>setTimeout(r,5200)); // Cross the real meter spool flush interval.
  assert.equal(model.calls,callsBefore,'recovered input must not run the model twice');
  assert.equal(manager.billingProvider.usage({tenantId:a.id,meter:'desktop.message.in'})[0].quantity,1);
  const closed=new Promise(resolve=>recovered.ws.once('close',resolve));const revoked=await admin.call(`/api/tenants/${a.id}/desktop/devices/${a.device.deviceId}`,{method:'DELETE'});assert.equal(revoked.status,200,revoked.text);assert.equal(await closed,4001);
});
