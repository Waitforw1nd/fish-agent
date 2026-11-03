import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, cleanSegments } from '../src/core/protocol-v1.js';
import { restoreSession } from '../src/core/session-machine.js';
import { PetConnection } from '../src/client.js';

test('frame validation and bounded segments',()=>{
  assert.equal(parseFrame('{'),null); assert.equal(parseFrame({v:2,op:'ready',d:{}}),null);
  assert.equal(parseFrame({v:1,op:'msg.push',seq:-1,d:{segments:[]}}),null);
  assert.equal(cleanSegments([{type:'text',data:{text:'x'.repeat(11000)}}])[0].data.text.length,10000);
});
test('restart distinguishes unattempted and uncertain, including legacy items',()=>{
  const s=restoreSession({pending:[{id:'a',segments:[{type:'text',data:{text:'a'}}],attempted:false},{id:'b',segments:[{type:'text',data:{text:'b'}}],attempted:true},{id:'c',segments:[{type:'text',data:{text:'c'}}]}],messages:[{id:'a'},{id:'b'},{id:'c'}]});
  assert.deepEqual(s.messages.map(x=>x.sendState),['queued','uncertain','uncertain']);
});
test('one in flight, stable IDs and persist before sending',()=>{
  const sent=[]; let fail=false;let n=0;
  const p=new PetConnection({credentials:{},WebSocket:null,idGenerator:()=>String(++n),save:()=>{if(fail)throw Error('disk');}});
  p.stopped=false;p.ready=true;p.socket={readyState:1,send:x=>sent.push(JSON.parse(x))};
  p.sendText('first');p.sendText('second');assert.equal(sent.length,1);assert.equal(sent[0].id,'1');
  p.receive({v:1,op:'msg.ack',d:{id:'1',messageId:'m'}});assert.equal(sent.length,2);assert.equal(sent[1].id,'2');assert.equal(p.messages[0].sendState,'accepted');
  fail=true;assert.throws(()=>p.sendText('third'));assert.equal(p.pending.length,1);assert.equal(sent.length,2);p.stop();
});
test('push persistence failure leaves cursor and content unchanged',()=>{
  const p=new PetConnection({credentials:{},WebSocket:null,save:()=>{throw Error('disk');}});
  p.receive({v:1,op:'msg.push',seq:1,d:{messageId:'m',segments:[]}});assert.equal(p.seq,0);assert.equal(p.messages.length,0);p.stop();
});
test('replay gap makes attempted message uncertain and explicit retry restores queue',()=>{
  const p=new PetConnection({credentials:{},WebSocket:null,state:{seq:1,pending:[{id:'x',segments:[{type:'text',data:{text:'x'}}],attempted:false}],messages:[{id:'x'}]}});
  p.pending=p.pending.map(x=>({...x,attempted:true}));p.ready=false;p.socket={readyState:1,send:()=>{throw Error('must not send');}};
  p.receive({v:1,op:'ready',d:{serverSeq:3,replay:[{v:1,op:'msg.push',seq:3,d:{messageId:'m',segments:[]}}]}});
  assert.equal(p.messages.find(x=>x.id==='x').sendState,'uncertain');assert.equal(p.pending[0].uncertain,true);p.ready=false;assert.equal(p.retry('x'),true);assert.equal(p.pending[0].uncertain,false);p.stop();
});
test('server sequence rollback blocks recovery',()=>{
  const p=new PetConnection({credentials:{},WebSocket:null,state:{seq:2}});p.receive({v:1,op:'ready',d:{serverSeq:1,replay:[]}});assert.equal(p.currentStatus,'recovery_error');assert.equal(p.seq,2);p.stop();
});
test('queue budget counts UTF-8 bytes and does not evict pending',()=>{
  const p=new PetConnection({credentials:{},WebSocket:null});p.stopped=false;
  assert.throws(()=>p.sendSegments([{type:'text',data:{text:'鱼'.repeat(3*1024*1024)}}]),/待发送消息过多/);assert.equal(p.pending.length,0);p.stop();
});

test('connection generations, timeout, and stop clean up timers',()=>{
  const timers=new Map();let next=0;const sockets=[];
  class Socket {constructor(){this.handlers={};this.readyState=1;sockets.push(this);}on(name,fn){this.handlers[name]=fn;}send(){}terminate(){this.terminated=true;} }
  const p=new PetConnection({credentials:{deviceId:'d',deviceToken:'token',wsUrl:'ws://localhost/desktop/v1/ws'},WebSocket:Socket,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
  p.connect();const old=sockets[0];p.reconnect();assert.equal(old.terminated,true);assert.equal(sockets.length,2);old.handlers.open();assert.equal(timers.size,1);
  const [timerId,timeout]=[...timers.entries()][0];assert.equal(timeout.ms,10000);timers.delete(timerId);timeout.fn();assert.equal(sockets[1].terminated,true);p.stop();assert.equal(timers.size,0);
});


test('streamed replay gates sending until catch-up and uses configurable deadline',()=>{
 const timers=new Map(), sent=[];let n=0;const p=new PetConnection({credentials:{},WebSocket:null,replayTimeoutMs:10000,setTimer:(fn,ms)=>{const id=++n;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),idGenerator:()=> 'a'});
 p.stopped=false;p.socket={readyState:1,send:x=>sent.push(JSON.parse(x)),close(){}};p.sendText('hello');p.receive({v:1,op:'ready',d:{serverSeq:2,replay:[]}});
 assert.equal(sent.length,0);assert.ok([...timers.values()].some(x=>x.ms===10000));p.receive({v:1,op:'msg.push',seq:1,d:{messageId:'1',segments:[]}});assert.equal(sent.length,0);p.receive({v:1,op:'msg.push',seq:2,d:{messageId:'2',segments:[]}});assert.equal(sent[0].id,'a');p.stop();
});
test('failed removed message can be explicitly retried or discarded',()=>{
 const p=new PetConnection({credentials:{},WebSocket:null,idGenerator:()=> 'a'});p.stopped=false;p.sendText('hello');p.receive({v:1,op:'error',d:{id:'a',code:'INVALID_SEGMENTS'}});assert.equal(p.pending.length,0);assert.equal(p.retry('a'),true);assert.equal(p.pending.length,1);p.receive({v:1,op:'error',d:{id:'a',code:'INVALID_SEGMENTS'}});assert.equal(p.drop('a'),true);assert.equal(p.messages[0].sendState,'discarded');p.stop();
});
test('queued payload is copied and an unsolicited ack cannot remove it',()=>{
 const p=new PetConnection({credentials:{},WebSocket:null,idGenerator:()=> 'a'});p.stopped=false;const input=[{type:'text',data:{text:'original'}}];p.sendSegments(input);input[0].data.text='changed';p.receive({v:1,op:'msg.ack',d:{id:'a',messageId:'bad'}});assert.equal(p.pending.length,1);assert.equal(p.pending[0].segments[0].data.text,'original');p.stop();
});

test('ack deadline marks uncertainty and pauses later queued sends',()=>{
 const timers=new Map(),sent=[];let n=0,id=0;const p=new PetConnection({credentials:{},WebSocket:null,ackTimeoutMs:500,setTimer:(fn,ms)=>{const key=++n;timers.set(key,{fn,ms});return key;},clearTimer:key=>timers.delete(key),idGenerator:()=>String(++id)});
 p.stopped=false;p.ready=true;p.socket={readyState:1,send:x=>sent.push(JSON.parse(x)),close(){}};p.sendText('one');p.sendText('two');const [key,timer]=[...timers.entries()].find(([,t])=>t.ms===500);timers.delete(key);timer.fn();assert.equal(sent.length,1);assert.equal(p.messages[0].sendState,'uncertain');assert.equal(p.drop('1'),true);assert.equal(sent.length,2);p.stop();
});



test('corrupt queue blocks connection rather than silently dropping work',()=>{
 const p=new PetConnection({credentials:{},WebSocket:null,state:{pending:[{id:'bad id',segments:[]}]}});let notice='';p.on('notice',x=>notice=x);p.connect();assert.equal(p.currentStatus,'recovery_error');assert.match(notice,/损坏/);assert.equal(p.stopped,true);p.stop();
});

test('corrupt history blocks recovery without exposing malformed rows to renderer',()=>{
  for(const messages of [[null],[{role:'assistant',segments:[null]}],{}]) {
    const pet=new PetConnection({credentials:{},WebSocket:null,state:{seq:4,messages}});
    pet.connect();assert.equal(pet.currentStatus,'recovery_error');assert.deepEqual(pet.messages,[]);pet.stop();
  }
});

test('server errors never expose credential-like diagnostics in notices',()=>{
  const pet=new PetConnection({credentials:{},WebSocket:null}),notices=[];pet.on('notice',value=>notices.push(value));
  for(const code of ['IN_PROGRESS','UNKNOWN','__proto__']) pet.receive({v:1,op:'error',d:{code,message:'Authorization: Bearer fdt_PRIVATE_FIXTURE'}});
  assert.equal(notices.length,3);assert.ok(notices.every(value=>!value.includes('PRIVATE_FIXTURE')));pet.stop();
});
test('snapshot, event, and restored values do not alias callers',()=>{
 const original={pending:[{id:'a',segments:[{type:'text',data:{text:'hello'}}],attempted:false}],messages:[{id:'a'}]};const p=new PetConnection({credentials:{},WebSocket:null,state:original});original.pending[0].segments[0].data.text='bad';const snap=p.snapshot();snap.pending[0].segments[0].data.text='bad';const exposed=p.pending;exposed[0].segments[0].data.text='bad';assert.equal(p.pending[0].segments[0].data.text,'hello');p.stop();
});
test('socket send failure keeps persisted attempted request for recovery',()=>{
 const timers=new Map();let k=0;const p=new PetConnection({credentials:{},WebSocket:null,idGenerator:()=> 'a',setTimer:(fn,ms)=>{timers.set(++k,{fn,ms});return k;},clearTimer:key=>timers.delete(key)});p.stopped=false;p.ready=true;p.socket={readyState:1,send(){throw Error('closed');},terminate(){}};assert.doesNotThrow(()=>p.sendText('hello'));assert.equal(p.pending[0].attempted,true);assert.equal(p.currentStatus,'disconnected');assert.ok(timers.size);p.stop();
});
test('socket rejects pre-ready frames and acknowledgements for queued messages',()=>{
 const sockets=[];class Socket{constructor(){this.handlers={};this.readyState=1;sockets.push(this);}on(k,f){this.handlers[k]=f;}send(){}terminate(){}}const p=new PetConnection({credentials:{deviceId:'d',deviceToken:'t',wsUrl:'ws://localhost/desktop/v1/ws'},WebSocket:Socket,idGenerator:()=> 'a'});p.connect();p.sendText('one');const ws=sockets[0];const send=m=>ws.handlers.message(Buffer.from(JSON.stringify(m)),false);send({v:1,op:'msg.push',seq:1,d:{segments:[]}});send({v:1,op:'msg.ack',d:{id:'a'}});assert.equal(p.seq,0);assert.equal(p.pending.length,1);send({v:1,op:'ready',d:{serverSeq:1,replay:[]}});send({v:1,op:'msg.ack',d:{id:'a'}});assert.equal(p.pending.length,1);p.stop();
});

test('three opened recovery handshakes without ready pause; unopened failure does not count',()=>{
 const sockets=[],timers=new Map();let k=0;class Socket{constructor(){this.handlers={};this.readyState=1;sockets.push(this);}on(k,f){this.handlers[k]=f;}send(){}terminate(){}}const p=new PetConnection({credentials:{deviceId:'d',deviceToken:'t',wsUrl:'ws://localhost/desktop/v1/ws'},WebSocket:Socket,state:{seq:7},random:()=>0,setTimer:(fn,ms)=>{timers.set(++k,{fn,ms});return k;},clearTimer:key=>timers.delete(key)});
 const next=()=>{const entry=[...timers.entries()].find(([,t])=>t.ms<10000);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();};p.connect();sockets.at(-1).handlers.close(1011);assert.equal(p.recoveryHandshakeFailures,undefined);next();for(let i=0;i<3;i++){const ws=sockets.at(-1);ws.handlers.open();ws.handlers.close(1011);if(i<2){assert.equal(p.currentStatus,'disconnected');next();}}assert.equal(p.currentStatus,'recovery_error');assert.equal(timers.size,0);p.stop();
});
test('ready resets prior recovery handshake failures',()=>{
 const p=new PetConnection({credentials:{},WebSocket:null,state:{seq:1}});p.recoveryHandshakeFailures=2;p.receive({v:1,op:'ready',d:{serverSeq:1,replay:[]}});assert.equal(p.recoveryHandshakeFailures,0);p.stop();
});
test('input-only recovery also pauses after three opened handshakes without ready',()=>{
  const sockets = [], timers = new Map();
  let nextTimer = 0;
  class Socket {
    constructor() { this.handlers = {}; this.readyState = 1; sockets.push(this); }
    on(name, handler) { this.handlers[name] = handler; }
    send() {}
    terminate() {}
  }
  const p = new PetConnection({
    credentials: { deviceId: 'd', deviceToken: 't', wsUrl: 'ws://localhost/desktop/v1/ws' },
    WebSocket: Socket,
    state: { inputSeq: 7 },
    random: () => 0,
    setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimer: key => timers.delete(key)
  });
  const reconnect = () => {
    const entry = [...timers.entries()].find(([, timer]) => timer.ms < 10000);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  p.connect();
  sockets.at(-1).handlers.close(1011);
  assert.equal(p.recoveryHandshakeFailures, undefined);
  reconnect();
  for (let i = 0; i < 3; i++) {
    const ws = sockets.at(-1);
    ws.handlers.open();
    ws.handlers.close(1011);
    if (i < 2) { assert.equal(p.currentStatus, 'disconnected'); reconnect(); }
  }
  assert.equal(p.currentStatus, 'recovery_error');
  assert.equal(timers.size, 0);
  p.stop();
});
test('ready resets prior input-only recovery handshake failures',()=>{
  const p = new PetConnection({ credentials: {}, WebSocket: null, state: { inputSeq: 7 } });
  p.recoveryHandshakeFailures = 2;
  p.receive({ v: 1, op: 'ready', d: { serverSeq: 0, replay: [] } });
  assert.equal(p.recoveryHandshakeFailures, 0);
  p.stop();
});
test('heartbeat sends at 30 seconds and terminates after 90 seconds without activity',()=>{
 const timers=new Map(),sent=[];let k=0,time=0,terminated=false;const p=new PetConnection({credentials:{},WebSocket:null,now:()=>time,setTimer:(fn,ms)=>{timers.set(++k,{fn,ms});return k;},clearTimer:key=>timers.delete(key)});p.socket={readyState:1,send:x=>sent.push(JSON.parse(x)),terminate:()=>{terminated=true;}};p.receive({v:1,op:'ready',d:{serverSeq:0,replay:[]}});const tick=()=>{const [key,t]=[...timers.entries()].find(([,x])=>x.ms===30000);timers.delete(key);t.fn();};time=30000;tick();assert.equal(sent[0].op,'ping');time=91000;tick();assert.equal(terminated,true);p.stop();
});
test('reconnect backoff caps at 30 seconds base and authentication blocks automatic retries',()=>{
 const timers=new Map(),sockets=[];let k=0;class Socket{constructor(){this.handlers={};sockets.push(this);}on(k,f){this.handlers[k]=f;}terminate(){}}const p=new PetConnection({credentials:{wsUrl:'ws://localhost/desktop/v1/ws'},WebSocket:Socket,random:()=>0.5,setTimer:(fn,ms)=>{timers.set(++k,{fn,ms});return k;},clearTimer:key=>timers.delete(key)});p.connect();for(const delay of [1000,2000,4000,8000,16000,30000,30000]){sockets.at(-1).handlers.close(1011);const entry=[...timers.entries()].find(([,t])=>t.ms===delay);assert.ok(entry,`expected ${delay}`);timers.delete(entry[0]);entry[1].fn();}sockets.at(-1).handlers['unexpected-response'](null,{statusCode:401});assert.equal(p.currentStatus,'revoked');assert.equal(timers.size,0);p.reconnect();sockets.at(-1).handlers['unexpected-response'](null,{statusCode:403});assert.equal(p.currentStatus,'auth_blocked');assert.equal(timers.size,0);p.stop();
});
test('failed ACK persistence retains pending and blocks subsequent request',()=>{
 let fail=false,n=0;const sent=[];const p=new PetConnection({credentials:{},WebSocket:null,idGenerator:()=>String(++n),save:()=>{if(fail)throw Error('disk');}});p.stopped=false;p.ready=true;p.socket={readyState:1,send:x=>sent.push(JSON.parse(x)),close(){}};p.sendText('one');p.sendText('two');fail=true;p.receive({v:1,op:'msg.ack',d:{id:'1',messageId:'m'}});assert.equal(p.pending.length,2);assert.equal(p.inflight,'1');assert.equal(sent.length,1);assert.equal(p.messages[0].sendState,'awaiting_ack');p.stop();
});

test('200 replay messages and restart retain an actionable uncertain pending row',()=>{
 const seg=[{type:'text',data:{text:'queued'}}];const state={seq:0,pending:[{id:'p',segments:seg,attempted:true}],messages:[]};let saved;const p=new PetConnection({credentials:{},WebSocket:null,state,save:s=>{saved=s;}});p.ready=false;
 const replay=Array.from({length:200},(_,i)=>({v:1,op:'msg.push',seq:i+1,d:{messageId:String(i),segments:[{type:'text',data:{text:'answer'}}]}}));p.receive({v:1,op:'ready',d:{serverSeq:200,replay}});
 assert.equal(p.messages.length,200);assert.equal(p.messages.find(x=>x.id==='p')?.sendState,'uncertain');assert.equal(p.pending[0].segments[0].data.text,'queued');
 const restored=new PetConnection({credentials:{},WebSocket:null,state:saved});assert.equal(restored.messages.find(x=>x.id==='p')?.sendState,'uncertain');assert.equal(restored.drop('p'),true);assert.equal(restored.pending.length,0);p.stop();restored.stop();
});
test('pending display summaries fit budget without changing original payload',()=>{
 const image='x'.repeat(2700000);const segment=[{type:'image',data:{file:image}}];const pending=Array.from({length:3},(_,i)=>({id:String(i),segments:segment,attempted:true}));const p=new PetConnection({credentials:{},WebSocket:null,state:{pending,messages:[]}});assert.equal(p.currentStatus,'disconnected');assert.equal(p.messages.length,3);assert.ok(Buffer.byteLength(JSON.stringify(p.messages))<=8*1024*1024);assert.equal(p.pending[0].segments[0].data.file,image);p.stop();
});
