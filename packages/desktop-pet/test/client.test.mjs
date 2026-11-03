import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PetConnection, pairDevice, endpoint } from '../src/client.js';
const require=createRequire(import.meta.url); let ws; try { ws=require('ws'); } catch { ws=require('../../qq-agent-core/node_modules/ws'); } const {WebSocket,WebSocketServer}=ws;
const waitFor=async(fn)=>{const end=Date.now()+4000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timed out');};

test('a synchronous socket send failure cancels timers from the failed connection',()=>{
  const timers=new Set();
  const pet=new PetConnection({credentials:{},WebSocket:null,random:()=>0,
    setTimer:(fn,delay)=>{const timer={fn,delay};timers.add(timer);return timer;},
    clearTimer:timer=>timers.delete(timer)});
  pet.stopped=false;pet.ready=true;pet.recovering=true;
  pet.socket={readyState:1,send(){throw new Error('send failed');},terminate(){}};
  pet.heartbeat=pet.schedule(()=>{},30000);
  pet.replayTimer=pet.schedule(()=>pet.recoveryFinish(),10000);
  const previous=[pet.heartbeat,pet.replayTimer];
  assert.equal(pet.sendFrame('ping'),false);
  for(const timer of previous)assert.equal(timers.has(timer),false);
  assert.equal(pet.recovering,false);
  assert.equal(timers.size,1); // only the reconnect backoff remains
  pet.stop();
});

test('a failed heartbeat does not schedule another heartbeat on a closed socket',()=>{
  const timers=new Set();
  const pet=new PetConnection({credentials:{},WebSocket:null,now:()=>1000,random:()=>0,
    setTimer:(fn,delay)=>{const timer={fn,delay};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
  pet.stopped=false;pet.ready=true;pet.lastReceived=1000;
  pet.socket={readyState:1,send(){throw new Error('send failed');},terminate(){}};
  pet.heartbeatTick();
  assert.deepEqual([...timers].map(timer=>timer.delay),[800]);
  pet.stop();
});

test('HTTP and WebSocket redirects never forward pairing codes or device tokens',async t=>{
  let leaked=0;const sink=http.createServer((_req,res)=>{leaked++;res.end();});sink.on('upgrade',(_req,socket)=>{leaked++;socket.destroy();});
  await new Promise(r=>sink.listen(0,'127.0.0.1',r));
  const redirect=http.createServer((_req,res)=>{res.writeHead(307,{location:`http://127.0.0.1:${sink.address().port}/stolen`});res.end();});
  redirect.on('upgrade',(_req,socket)=>socket.end(`HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${sink.address().port}/stolen\r\nContent-Length: 0\r\n\r\n`));
  await new Promise(r=>redirect.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>redirect.close(r));await new Promise(r=>sink.close(r));});
  const base=`http://127.0.0.1:${redirect.address().port}`;
  await assert.rejects(pairDevice({host:base,code:'ABC12345',deviceName:'test',os:'win32'}));
  const pet=new PetConnection({credentials:{deviceId:'dev',deviceToken:'fdt_fixture',wsUrl:base.replace('http:','ws:')+'/desktop/v1/ws'},WebSocket});t.after(()=>pet.stop());
  pet.connect();await waitFor(()=>pet.currentStatus==='disconnected');pet.stop();
  assert.equal(leaked,0);
});

test('secure addresses and pairing bind the WebSocket to the same origin',async()=>{
  assert.throws(()=>endpoint('http://example.com')); assert.throws(()=>endpoint('https://user:pass@example.com')); assert.throws(()=>endpoint('ws://example.com',true));
  const credentials=await pairDevice({host:'http://127.0.0.1:1234',code:'ABC12345',deviceName:'test',os:'win32',fetchImpl:async(url,opts)=>{assert.equal(url.pathname,'/desktop/v1/pair');assert.equal(JSON.parse(opts.body).code,'ABC12345');return {ok:true,json:async()=>({deviceId:'dev_1',deviceToken:'fdt_abcdefghijklmnop123456',desktopUserId:'1',tenantSlug:'test',wsUrl:'ws://127.0.0.1:1234/desktop/v1/ws'})};}});
  assert.equal(credentials.deviceId,'dev_1');
  await assert.rejects(pairDevice({host:'https://example.com',code:'ABC12345',fetchImpl:async()=>({ok:true,json:async()=>({...credentials,wsUrl:'wss://evil.example/desktop/v1/ws'})})}));
});

test('local socket authenticates, resumes replay, explicitly retries unacknowledged ID, and stops after revocation',async t=>{
  const server=http.createServer();const wss=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{for(const ws of wss.clients)ws.terminate();wss.close(()=>server.close(r));}));
  let connections=0;const hellos=[],ids=[];
  wss.on('connection',(ws,req)=>{connections++;assert.equal(req.headers.authorization,'Bearer fdt_abcdefghijklmnop123456');const n=connections;
    ws.on('message',data=>{const m=JSON.parse(data);if(m.op==='hello'){hellos.push(m.d.resumeSeq);ws.send(JSON.stringify({v:1,op:'ready',d:{replay:n===1?[{v:1,op:'msg.push',seq:1,d:{messageId:'one',segments:[{type:'text',data:{text:'hello'}}]}}]:[],serverSeq:1}}));}if(m.op==='msg.send'){ids.push(m.id);if(n===1)ws.close(1011,'retry');else ws.send(JSON.stringify({v:1,op:'msg.ack',d:{id:m.id,messageId:'server-id'}}));}});
  });
  // Accelerate only reconnect backoff: shortening the ready and ACK deadlines
  // to the same 20 ms made slow CI scheduling race the actual socket traffic.
  let state={};const pet=new PetConnection({credentials:{deviceId:'dev',deviceToken:'fdt_abcdefghijklmnop123456',wsUrl:`ws://127.0.0.1:${server.address().port}/desktop/v1/ws`},WebSocket,random:()=>0,setTimer:(fn,ms)=>setTimeout(fn,ms>=800&&ms<10000?20:ms),save:s=>{state=structuredClone(s);}});t.after(()=>pet.stop());
  const statuses=[];pet.on('status',s=>statuses.push(s));pet.connect();await waitFor(()=>pet.ready);assert.equal(pet.seq,1);const id=pet.sendText('hi');await waitFor(()=>connections===2 && pet.ready && pet.pending[0]?.uncertain);assert.equal(ids.length,1);assert.equal(pet.retry(id),true);await waitFor(()=>ids.length===2 && pet.pending.length===0);assert.equal(ids[0],ids[1]);assert.deepEqual(hellos,[0,1]);assert.equal(state.messages.filter(m=>m.role==='assistant').length,1);assert.equal(state.messages.find(m=>m.role==='user').pending,false);
  for(const ws of wss.clients)ws.close(4001,'revoked');await waitFor(()=>statuses.includes('revoked'));const count=connections;await new Promise(r=>setTimeout(r,100));assert.equal(connections,count);assert.equal(pet.stopped,true);
});


test('image attachments are bounded and validated by magic bytes',async()=>{const {imageSegment}=await import('../src/image.js');const png=Buffer.from('89504e470d0a1a0a00000000','hex');assert.equal(imageSegment(png).data.file,`base64://${png.toString('base64')}`);assert.throws(()=>imageSegment(Buffer.from('<script>')));assert.throws(()=>imageSegment(Buffer.alloc(2*1024*1024+1)));});

test('renderer uses text nodes and never fetches remote image URLs',async()=>{
  let jsdom;try{jsdom=require('jsdom');}catch{jsdom=require('../../qq-agent-core/node_modules/jsdom');}const {JSDOM}=jsdom;const fs=await import('node:fs');
  const html=fs.readFileSync(new URL('../src/index.html',import.meta.url),'utf8');const script=fs.readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
  const dom=new JSDOM(html,{runScripts:'outside-only'});let onMessages;dom.window.pet={onStatus(){},onMood(){},onMessages(fn){onMessages=fn;},onNotice(){},init:async()=>({paired:true,messages:[]}),poke(){},hide(){}};dom.window.eval(script);
  onMessages([{role:'assistant',segments:[{type:'text',data:{text:'<img src=x onerror=alert(1)>'}},{type:'image',data:{file:'https://evil.example/image.png'}},{type:'image',data:{file:'base64://iVBORw0KGgoAAA=='}}]}]);
  const box=dom.window.document.getElementById('messages');assert.match(box.textContent,/<img src=x/);assert.equal(box.querySelectorAll('img').length,1);assert.match(box.querySelector('img').src,/^data:image\/png;base64,/);dom.window.close();
});


test('pair response size is bounded before JSON parsing',async()=>{const {readPairResponse}=await import('../src/pair-response.js');const huge=new Response('x'.repeat(65537));await assert.rejects(readPairResponse(huge),/过大/);const valid=new Response('{"ok":true}');assert.deepEqual(await readPairResponse(valid),{ok:true});});

test('malicious replay is bounded and does not recursively process nested ready frames',()=>{const pet=new PetConnection({credentials:{},WebSocket:null});let saved;pet.save=s=>{saved=s;};const repeated=Array.from({length:205},(_,i)=>({v:1,op:'msg.push',seq:i+1,d:{messageId:String(i),segments:[{type:'text',data:{text:'x'.repeat(15000)}}]}}));repeated.unshift({v:1,op:'ready',d:{replay:[]}});pet.receive({v:1,op:'ready',d:{replay:repeated}});assert.equal(pet.seq,199);assert.equal(saved.messages.length,199);assert.equal(saved.messages[0].segments[0].data.text.length,10000);pet.stop();});

test('Linux plaintext fallback is rejected even when Electron reports encryption available', async () => {
  const { secureStorageAvailable } = await import('../src/secure-storage.js');
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  assert.equal(secureStorageAvailable(storage, 'linux'), false);
  assert.equal(secureStorageAvailable(storage, 'win32'), true);
  storage.getSelectedStorageBackend = () => 'gnome_libsecret'; assert.equal(secureStorageAvailable(storage, 'linux'), true);
  storage.isEncryptionAvailable = () => false; assert.equal(secureStorageAvailable(storage, 'darwin'), false);
});

test('permanently rejected messages leave the retry queue with a visible failure state', () => {
  const pet = new PetConnection({ credentials: {}, WebSocket: null }); pet.stopped = false;
  pet.sendText('message'); const id = pet.pending[0].id;
  pet.receive({ v: 1, op: 'error', d: { id, code: 'INVALID_SEGMENTS', message: 'invalid reply' } });
  assert.equal(pet.pending.length, 0); assert.equal(pet.messages[0].failed, true); assert.equal(pet.messages[0].pending, false); pet.stop();
});

test('real replay storage failure pauses connection, and manual recovery saves each sequence once',async t=>{
  const server=http.createServer(),wss=new WebSocketServer({server});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{for(const peer of wss.clients)peer.terminate();wss.close(()=>server.close(resolve));}));
  const frame={v:1,op:'msg.push',seq:1,d:{messageId:'reply',segments:[{type:'text',data:{text:'retained'}}]}};
  const resumes=[];wss.on('connection',peer=>peer.on('message',raw=>{
    const message=JSON.parse(raw);if(message.op!=='hello')return;resumes.push(message.d.resumeSeq);
    peer.send(JSON.stringify({v:1,op:'ready',d:{serverSeq:1,replay:[frame]}}));peer.send(JSON.stringify(frame));
  }));
  let fail=true,saved;const statuses=[];
  const pet=new PetConnection({credentials:{deviceId:'d',deviceToken:'fixture',wsUrl:`ws://127.0.0.1:${server.address().port}/desktop/v1/ws`},WebSocket,
    save:state=>{if(fail)throw Error('disk unavailable');saved=structuredClone(state);}});
  t.after(()=>pet.stop());pet.on('status',status=>statuses.push(status));pet.connect();
  await waitFor(()=>pet.currentStatus==='recovery_error');assert.equal(pet.seq,0);assert.equal(pet.ready,false);assert.equal(pet.stopped,true);assert.equal(pet.timer,null);assert.ok(!statuses.includes('connected'));
  fail=false;pet.reconnect();await waitFor(()=>pet.ready&&pet.seq===1);await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(resumes,[0,0]);assert.equal(saved.messages.length,1);assert.equal(saved.seq,1);assert.equal(pet.messages.length,1);
});
