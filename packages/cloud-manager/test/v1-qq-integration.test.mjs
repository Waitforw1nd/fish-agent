import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { startManager, loginAdmin, waitFor, fixture } from './helpers.mjs';
const { WebSocketServer } = createRequire(import.meta.url)('ws');

async function fixtureServer() {
  const sends = [], calls = [], sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ url: req.url, body }); res.setHeader('content-type', 'application/json');
    if (req.url === '/app/getAppAccessToken') return res.end(JSON.stringify({access_token:'local-token',expires_in:3600}));
    if (req.url === '/gateway/bot') return res.end(JSON.stringify({url:`ws://127.0.0.1:${server.address().port}/official`}));
    if (req.url.startsWith('/v2/users/')) { sends.push({url:req.url,body}); return res.end(JSON.stringify({id:'reply-official'})); }
    if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'deepseek-chat'}]}));
    if (req.url === '/v1/chat/completions') {
      const done = body.messages.some(m => m.role === 'tool' && m.name === 'send_message');
      return res.end(JSON.stringify({id:'local',model:'deepseek-chat',usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25},choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:`call-${calls.length}`,type:'function',function:{name:done?'finish':'send_message',arguments:JSON.stringify(done?{reason:'done'}:{messages:['local fixture reply']})}}]}}]}));
    }
    res.writeHead(404).end('{}');
  });
  const wss = new WebSocketServer({server}); let onebot, official;
  wss.on('connection',(ws,req) => {
    sockets.add(ws); ws.on('close',()=>sockets.delete(ws));
    if(req.url==='/official') { official=ws; ws.send(JSON.stringify({op:10,d:{heartbeat_interval:30000}})); ws.on('message',raw=>{const m=JSON.parse(raw);if(m.op===2)ws.send(JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'local-session',user:{id:'bot',username:'Fish'}}}));else if(m.op===1)ws.send(JSON.stringify({op:11,d:null}));}); }
    else { onebot=ws; ws.on('message',raw=>{const m=JSON.parse(raw);let data={};if(m.action==='get_login_info') data={user_id:10000,nickname:'Fish'};if(m.action==='send_private_msg'){sends.push({action:m.action,params:m.params});data={message_id:12345};} ws.send(JSON.stringify({status:'ok',retcode:0,data,echo:m.echo}));}); }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {base:`http://127.0.0.1:${server.address().port}`, sends,calls, get onebot(){return onebot;},get official(){return official;},async close(){for(const s of sockets)s.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

test('QQ OneBot and official gateway traverse real tenant agents and Relay locally', {timeout:90000}, async t=>{
  const f=await fixtureServer();t.after(()=>f.close());
  const pids=[];
  const env=await startManager({agentEntry:fixture('v1-qq-agent.mjs')});t.after(async()=>{await env.stop();for(const pid of pids)assert.throws(()=>process.kill(pid,0));});const {manager}=env;const admin=await loginAdmin(manager);
  assert.equal((await admin.call('/api/admin/upstream',{method:'PUT',body:{baseUrl:f.base,apiKey:'local-fixture-key'}})).status,200);
  const links=new Map();manager.agent.setLinksResolver(tenant=>({qq:links.get(tenant.id),bili:null}));
  for(const kind of ['onebot','official']) {
    const created=await admin.createTenant({name:`v1-${kind}`,slug:`v1-${kind}`,planId:'starter'});assert.equal(created.status,201,created.text);const id=created.json.tenant.id;const tenant=manager.tenants.row(id);
    manager.db.prepare('INSERT INTO qq_accounts(tenant_id,driver,state,updated_at) VALUES(?,?,?,?)').run(id,kind==='onebot'?'napcat':'qqbot','prepared',Date.now());
    links.set(id,kind==='onebot'?{enabled:true,driver:'fixture',apiTransport:'ws',wsUrl:f.base.replace('http:','ws:')+'/onebot',httpUrl:f.base,uin:'10000'}:{enabled:true,driver:'qqbot',appId:'1905870123',intents:1<<25});
    if(kind==='official')manager.secrets.set(id,'qq.qqbot.appSecret','local-secret');
    await manager.agent.ensure(tenant);const configPath=manager.agent.configPath(tenant);const config=JSON.parse(fs.readFileSync(configPath,'utf8'));config.allow={groups:[],private:[kind==='onebot'?'123456':'qqbot_user_OpenID_Aa']};config.v1FixtureBase=f.base;config.wakeDelayMs=10;config.extensions={hotReload:false};config.proactive={enabled:false};fs.writeFileSync(configPath,JSON.stringify(config));
    await manager.agent.start(tenant);const pid=manager.supervisor.status(id,'agent').pid;assert.ok(pid);pids.push(pid);
    const ws=await waitFor(()=>{return kind==='onebot'?f.onebot:f.official;},{timeoutMs:10000,label:`${kind} connected`});
    if(kind==='official') await new Promise(r=>setTimeout(r,200));
    const event=kind==='onebot'?{post_type:'message',message_type:'private',self_id:10000,user_id:123456,message_id:321,time:Math.floor(Date.now()/1000),sender:{user_id:123456,nickname:'local'},message:[{type:'text',data:{text:'hello local fish'}}]}:{op:0,t:'C2C_MESSAGE_CREATE',s:2,d:{id:'message-local',timestamp:new Date().toISOString(),author:{user_openid:'OpenID_Aa'},content:'hello local fish'}};
    ws.send(JSON.stringify(event));
    await waitFor(()=>f.sends.find(s=>kind==='onebot'?s.action==='send_private_msg':s.url?.includes('/v2/users/OpenID_Aa')),{timeoutMs:25000,label:`${kind} reply`});
    const entry=kind==='onebot'?'qq_protocol':'qq_official';
    await waitFor(()=>manager.db.prepare('SELECT COUNT(*) n FROM ledger WHERE tenant_id=? AND entry=?').get(id,entry).n,{timeoutMs:10000,label:`${kind} ledger`});
    const ledger=manager.db.prepare('SELECT platform,chat_key,prompt_tokens,completion_tokens FROM ledger WHERE tenant_id=? AND entry=?').all(id,entry);assert.ok(ledger.every(x=>x.platform===(kind==='onebot'?'qq':'qqbot') && x.chat_key===(kind==='onebot'?'private:123456':'private:qqbot_user_OpenID_Aa') && x.prompt_tokens+x.completion_tokens>0));
    await waitFor(()=>{const meters=manager.billingProvider.usage({tenantId:id}).map(x=>x.meter);return [`${entry}.message.in`,`${entry}.message.out`,`${entry}.llm.tokens`,...(kind==='official'?[`${entry}.api.call`]:[])].every(x=>meters.includes(x));},{timeoutMs:15000,label:`${kind} meters`});
    const beforeCalls=f.calls.filter(x=>x.url==="/v1/chat/completions").length;const beforeSends=f.sends.length;ws.send(JSON.stringify(event));await new Promise(r=>setTimeout(r,1000));assert.equal(f.calls.filter(x=>x.url==="/v1/chat/completions").length,beforeCalls);assert.equal(f.sends.length,beforeSends);assert.equal(manager.billingProvider.usage({tenantId:id,meter:entry+".message.in"})[0].quantity,1);
    if(kind==='official'){const send=f.sends.find(s=>s.url?.includes('/v2/users/OpenID_Aa'));assert.equal(send.body.msg_id,'message-local');assert.match(send.body.content,/local fixture reply/);assert.equal(f.sends.filter(s=>s.url?.includes('/v2/users/OpenID_Aa')).length,1);}
    await manager.agent.stop(tenant);assert.equal(manager.supervisor.status(id,'agent').state,'stopped');assert.throws(()=>process.kill(pid,0));
    const usage=await admin.call("/api/tenants/"+id+"/billing/entries/"+entry+"/usage");assert.equal(usage.status,200,usage.text);assert.ok(usage.json.usage.some(x=>x.meter===entry+".hosting.seconds" && x.quantity>0));assert.ok(usage.json.usage.some(x=>x.meter===entry+".llm.tokens" && x.quantity>0));
    console.log("validated " + entry + " pid=" + pid + " stopped; meters=" + JSON.stringify(usage.json.usage.map(({meter,quantity})=>({meter,quantity}))));
  }
});








