import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Gateway } from '../src/gateway.js';

test('gateway tenant upload authorization, origin, content type and size', async t => {
  let forwarded = 0;
  const upstream = http.createServer((req,res) => { forwarded++; req.resume(); res.end('{}'); });
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const tenants = { bySlug: slug => ({id:slug,slug}), roleFor: (user,id) => user.id === id ? user.role : null, assertActive() {} };
  const gateway = new Gateway({config:{baseDomain:'example.test',publicScheme:'http',cookieSecure:false,apiMaxBodyBytes:1024,gatewayTimeoutMs:5000},tenants,auth:{resolve:req => req.headers.authorization ? {user:{id:'a',role:req.headers.authorization}} : null},agentRuntime:{port:()=>upstream.address().port,supervisor:{status:()=>({state:'running'})},consoleHeaders:()=>({})}});
  const server=http.createServer(async (req,res)=>{ if (!await gateway.handle(req,res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();});
  const send=(host,headers={},body='{}')=>new Promise((resolve,reject)=>{ const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/skills/install-zip',method:'POST',headers:{host,origin:`http://${host}`,'content-type':'application/json',...headers}},res=>{res.resume();resolve({status:res.statusCode});}); req.on('error',reject); req.end(body); });
  assert.equal((await send('a.example.test')).status,401);
  assert.equal((await send('b.example.test',{authorization:'owner'})).status,403);
  assert.equal((await send('a.example.test',{authorization:'viewer'})).status,403);
  assert.equal((await send('a.example.test',{authorization:'owner',origin:'http://evil.test'})).status,403);
  assert.equal((await send('a.example.test',{authorization:'owner','content-type':'text/plain'})).status,403);
  const oversized = await new Promise((resolve,reject) => {
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/skills/install-zip',method:'POST',headers:{host:'a.example.test',origin:'http://a.example.test',authorization:'owner','content-type':'application/json','content-length':String(12*1024*1024+1)}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject); req.flushHeaders();
  });
  assert.equal(oversized,413);
  assert.equal(forwarded,0);
  assert.equal((await send('a.example.test',{authorization:'owner'})).status,200);
  assert.equal(forwarded,1);
});
