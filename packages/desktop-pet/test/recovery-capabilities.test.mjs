import test from 'node:test';
import assert from 'node:assert/strict';
import { PetConnection } from '../src/client.js';
import { parseFrame } from '../src/core/protocol-v1.js';
import { RECOVERY_CAPABILITIES } from '../src/core/recovery-contract.js';

const segments = text => [{type:'text',data:{text}}];
const output = (serverSeq = 0, extra = {}) => ({epoch:'epoch-1',serverSeq,oldestSeq:1,replayFrom:serverSeq?1:1,replayTo:serverSeq,hasGap:false,...extra});
const input = (inputServerSeq = 0, extra = {}) => ({epoch:'epoch-1',inputServerSeq,inputOldestSeq:1,inputReplayFrom:1,inputReplayTo:inputServerSeq,inputHasGap:false,...extra});
function fixture(t, state = {}, save = () => {}) {
  const sent = [], timers = new Map(); let key = 0, id = 0;
  const pet = new PetConnection({credentials:{deviceId:'device-a'},WebSocket:null,state,save,
    idGenerator:()=>`local-${++id}`,setTimer:(fn,ms)=>{timers.set(++key,{fn,ms});return key;},clearTimer:k=>timers.delete(k)});
  pet.stopped = false; pet.socket = {readyState:1,send:value=>sent.push(JSON.parse(value)),close(){}};
  t.after(()=>pet.stop()); return {pet,sent,timers};
}
const ready = (pet, out = output(), ins = input()) => pet.receive({v:1,op:'ready',d:{capabilities:RECOVERY_CAPABILITIES,replay:[],...out,...ins}});
const finish = (pet, out = output(), ins = input()) => {pet.receive({v:1,op:'replay.end',d:out});pet.receive({v:1,op:'input.replay.end',d:ins});};
const inputPush = (inputSeq, messageId, clientMessageId, deviceId = 'device-a') => ({v:1,op:'input.push',inputSeq,d:{messageId,clientMessageId,deviceId,segments:segments('input')}});

test('inline replay stops immediately on a recovery failure',t=>{
  const saved=[];const {pet,sent,timers}=fixture(t,{},value=>saved.push(value));
  pet.sendText('queued');
  const push=seq=>({v:1,op:'msg.push',seq,d:{messageId:`mid-${seq}`,segments:segments('reply')}});
  pet.receive({v:1,op:'ready',d:{capabilities:RECOVERY_CAPABILITIES,...output(2),...input(),replay:[push(2),push(1)]}});
  assert.equal(pet.currentStatus,'recovery_error');assert.equal(pet.ready,false);
  assert.equal(pet.seq,0);assert.equal(saved.at(-1).seq,0);
  assert.deepEqual(sent,[]);assert.equal(timers.size,0);
});

test('valid inline output and streamed input finish both replays before sending',t=>{
  const {pet,sent}=fixture(t);pet.sendText('queued');
  const out=output(1),ins=input(1);
  const push={v:1,op:'msg.push',seq:1,d:{messageId:'reply-1',segments:segments('reply')}};
  pet.receive({v:1,op:'ready',d:{capabilities:RECOVERY_CAPABILITIES,...out,...ins,replay:[push]}});
  assert.equal(pet.seq,1);assert.notEqual(pet.currentStatus,'connected');assert.deepEqual(sent,[]);
  pet.receive({v:1,op:'replay.end',d:out});pet.receive(inputPush(1,'input-1','remote','device-b'));
  assert.deepEqual(sent,[]);pet.receive({v:1,op:'input.replay.end',d:ins});
  assert.equal(pet.inputSeq,1);assert.equal(pet.currentStatus,'connected');assert.deepEqual(sent.map(x=>x.op),['msg.send']);
});

test('streamed replay failure never reports connected',t=>{
  const {pet}=fixture(t);const statuses=[];pet.on('status',value=>statuses.push(value));
  ready(pet,output(1),input());
  pet.receive({v:1,op:'replay.end',d:output(1)});
  assert.equal(pet.currentStatus,'recovery_error');assert.equal(statuses.includes('connected'),false);
});

test('legacy inline replay still sends an unattempted queued message',t=>{
  const {pet,sent}=fixture(t);pet.sendText('queued');
  pet.receive({v:1,op:'ready',d:{serverSeq:1,replay:[{v:1,op:'msg.push',seq:1,d:{messageId:'reply-1',segments:segments('reply')}}]}});
  assert.equal(pet.seq,1);assert.equal(pet.currentStatus,'connected');assert.deepEqual(sent.map(x=>x.op),['msg.send']);
});

test('negotiated replay waits for both end markers before sending queued text',t=>{
  const {pet,sent} = fixture(t); pet.sendText('queued'); ready(pet);
  assert.equal(pet.epoch,'epoch-1'); assert.equal(sent.length,0);
  pet.receive({v:1,op:'replay.end',d:output()}); assert.equal(sent.length,0);
  pet.receive({v:1,op:'input.replay.end',d:input()}); assert.equal(sent[0].op,'msg.send');
});

test('disconnect after ready but before both replay ends counts as failed recovery',()=>{
  const sockets=[],timers=new Map();let key=0;
  class Socket { constructor(){this.handlers={};this.readyState=1;sockets.push(this);} on(name,fn){this.handlers[name]=fn;} send(){} terminate(){} }
  const pet=new PetConnection({credentials:{deviceId:'d',deviceToken:'t',wsUrl:'ws://localhost/desktop/v1/ws'},WebSocket:Socket,random:()=>0,
    setTimer:(fn,ms)=>{timers.set(++key,{fn,ms});return key;},clearTimer:k=>timers.delete(k)});
  pet.connect();pet.sendText('queued');
  for(let i=0;i<3;i++){
    const ws=sockets.at(-1);ws.handlers.open();
    const deliver=frame=>ws.handlers.message(Buffer.from(JSON.stringify(frame)),false);
    deliver({v:1,op:'ready',d:{capabilities:RECOVERY_CAPABILITIES,replay:[],...output(),...input()}});
    deliver({v:1,op:'replay.end',d:output()});
    assert.equal(pet.recoveryHandshakeFailures||0,i);
    ws.handlers.close(1011);
    if(i<2){const entry=[...timers.entries()].find(([,timer])=>timer.ms<10000);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();}
  }
  assert.equal(pet.currentStatus,'recovery_error');assert.equal(pet.pending[0].attempted,false);assert.equal(timers.size,0);pet.stop();
});

test('only completed dual replay clears recovery failure count',t=>{
  const {pet}=fixture(t);pet.recoveryHandshakeFailures=2;ready(pet);
  assert.equal(pet.recoveryHandshakeFailures,2);
  pet.receive({v:1,op:'replay.end',d:output()});assert.equal(pet.recoveryHandshakeFailures,2);
  pet.receive({v:1,op:'input.replay.end',d:input()});assert.equal(pet.recoveryHandshakeFailures,0);
});

test('restart queries durable receipt instead of resending ambiguous work',t=>{
  const state = {pending:[{id:'a',segments:segments('once'),attempted:true}]};
  const {pet,sent} = fixture(t,state); ready(pet); finish(pet);
  assert.deepEqual(sent.map(x=>[x.op,x.id]),[['msg.status','a']]);
  pet.receive({v:1,op:'msg.status',d:{id:'a',status:'accepted',messageId:'accepted-a'}});
  assert.equal(pet.pending.length,0); assert.equal(pet.messages[0].sendState,'accepted');
  assert.equal(sent.some(x=>x.op==='msg.send'),false);
});

test('a recovery capability downgrade cannot silently resend an attempted message',t=>{
  const state={epoch:'epoch-1',pending:[{id:'a',segments:segments('once'),attempted:true}]};
  const {pet,sent}=fixture(t,state);
  pet.receive({v:1,op:'ready',d:{replay:[],serverSeq:0}});
  assert.equal(pet.currentStatus,'recovery_error');assert.equal(sent.length,0);
  const partial=fixture(t,state);
  partial.pet.receive({v:1,op:'ready',d:{capabilities:['recovery.v1'],replay:[],...output()}});
  partial.pet.receive({v:1,op:'replay.end',d:output()});
  assert.equal(partial.pet.pending[0].uncertain,true);assert.equal(partial.sent.length,0);
});

test('missing capability for an existing output or input cursor pauses without saving a new cursor',t=>{
  for(const kind of ['output','input']){
    const state={epoch:'epoch-1',seq:kind==='output'?3:0,inputSeq:kind==='input'?4:0};
    const saved=[];const {pet,sent}=fixture(t,state,value=>saved.push(value));
    const capabilities=kind==='output'?['input-history.v1']:['recovery.v1'];
    const metadata=kind==='output'?{serverSeq:3,...input(0)}:output(0);
    pet.receive({v:1,op:'ready',d:{capabilities,replay:[],...metadata}});
    assert.equal(pet.currentStatus,'recovery_error');
    assert.equal(pet.seq,state.seq);assert.equal(pet.inputSeq,state.inputSeq);
    assert.deepEqual(saved,[]);assert.deepEqual(sent,[]);
  }
});

test('a first connection to a legacy server still sends queued text',t=>{
  const {pet,sent}=fixture(t);pet.sendText('legacy');
  pet.receive({v:1,op:'ready',d:{replay:[],serverSeq:0}});
  assert.equal(pet.currentStatus,'connected');assert.equal(pet.epoch,undefined);
  assert.deepEqual(sent.map(x=>x.op),['msg.send']);
});

test('legacy server reconnect preserves an unacknowledged attempt as uncertain',t=>{
  const {pet,sent}=fixture(t);
  pet.receive({v:1,op:'ready',d:{replay:[],serverSeq:0}});
  const id=pet.sendText('once');pet.sendText('later');
  assert.equal(sent.filter(x=>x.op==='msg.send').length,1);
  // A short disconnect leaves the in-memory attempted item intact; there is no
  // receipt capability to distinguish a lost ACK from an unaccepted message.
  pet.ready=false;pet.inflight=null;pet.disconnectedAt=pet.now();
  pet.receive({v:1,op:'ready',d:{replay:[],serverSeq:0}});
  assert.equal(pet.pending[0].id,id);assert.equal(pet.pending[0].uncertain,true);
  assert.equal(pet.messages[0].sendState,'uncertain');
  assert.equal(sent.filter(x=>x.op==='msg.send').length,1);
});

test('unknown receipt stays uncertain and in-progress can receive a later acknowledgement',t=>{
  for (const status of ['unknown','in_progress']) {
    const {pet,sent} = fixture(t,{pending:[{id:'a',segments:segments('once'),attempted:true}]});
    ready(pet); finish(pet); pet.receive({v:1,op:'msg.status',d:{id:'a',status}});
    assert.equal(pet.pending[0].uncertain,true); assert.equal(sent.length,1);
    if(status==='in_progress'){pet.receive({v:1,op:'msg.ack',d:{id:'a',messageId:'done'}});assert.equal(pet.pending.length,0);}
    else {pet.retry('a');assert.equal(sent.at(-1).op,'msg.send');}
  }
});

test('own input history merges local row while another device with same client ID remains distinct',t=>{
  const {pet} = fixture(t); const id=pet.sendText('input'); ready(pet,output(),input(2));
  pet.receive(inputPush(1,'mid-a',id)); pet.receive(inputPush(2,'mid-b',id,'device-b'));
  pet.receive(inputPush(1,'mid-a',id)); finish(pet,output(),input(2));
  assert.equal(pet.messages.length,2);assert.equal(pet.messages[0].id,id);assert.equal(pet.inputSeq,2);
  assert.equal(pet.snapshot().inputSeq,2);
});

test('undeclared output and input gaps stop before advancing the persisted cursor',t=>{
  for(const kind of ['output','input']){
    const {pet} = fixture(t);ready(pet,output(2),input(2));
    pet.receive(kind==='output'?{v:1,op:'msg.push',seq:2,d:{messageId:'m',segments:segments('late')}}:inputPush(2,'m','a'));
    assert.equal(pet.currentStatus,'recovery_error');assert.equal(pet.seq,0);assert.equal(pet.inputSeq,0);
  }
});

test('an empty replay cannot conceal an undeclared output or input gap',t=>{
  for(const kind of ['output','input']){
    const {pet,sent}=fixture(t);pet.sendText('queued');
    const out=kind==='output'?output(2,{replayFrom:3}):output();
    const ins=kind==='input'?input(2,{inputReplayFrom:3}):input();
    ready(pet,out,ins);
    assert.equal(pet.currentStatus,'recovery_error');
    assert.equal(pet.seq,0);assert.equal(pet.inputSeq,0);assert.deepEqual(sent,[]);
  }
});

test('declared retention gap accepts only available frames and does not synthesize a cursor',t=>{
  const {pet} = fixture(t);const out=output(5,{oldestSeq:5,replayFrom:5,hasGap:true});
  ready(pet,out);assert.equal(pet.seq,0);
  pet.receive({v:1,op:'msg.push',seq:5,d:{messageId:'m',segments:segments('retained')}});finish(pet,out);
  assert.equal(pet.seq,5);assert.equal(pet.messages.length,1);assert.equal(pet.recoveryGap,true);
  const {pet:empty} = fixture(t);const expired=output(5,{oldestSeq:6,replayFrom:6,hasGap:true});
  ready(empty,expired);finish(empty,expired);assert.equal(empty.seq,0,'only a real received frame advances the cursor');
});

test('missing end marker, missing declared frame, or changed epoch prevents automatic sends',t=>{
  const {pet,timers,sent} = fixture(t);pet.sendText('queued');ready(pet);
  const deadline=[...timers.values()].find(x=>x.ms===10000);deadline.fn();
  assert.equal(pet.currentStatus,'recovery_error');assert.equal(sent.length,0);
  const {pet:missing} = fixture(t);ready(missing,output(1));finish(missing,output(1));assert.equal(missing.currentStatus,'recovery_error');
  const {pet:epoch} = fixture(t,{epoch:'previous'});ready(epoch);assert.equal(epoch.currentStatus,'recovery_error');assert.equal(epoch.epoch,'previous');
});

test('input cursor is not advanced when persistence fails',t=>{
  let fail=false;const {pet}=fixture(t,{},()=>{if(fail)throw Error('disk');});ready(pet,output(),input(1));fail=true;
  pet.receive(inputPush(1,'mid','a'));assert.equal(pet.inputSeq,0);assert.equal(pet.messages.length,0);assert.equal(pet.currentStatus,'recovery_error');
});

test('ambiguous ingest failure is uncertain and blocks the next message',t=>{
  const {pet,sent}=fixture(t);ready(pet);finish(pet);const id=pet.sendText('one');pet.sendText('two');
  pet.receive({v:1,op:'error',d:{id,code:'INGEST_FAILED'}});
  assert.equal(pet.messages[0].sendState,'uncertain');assert.equal(pet.pending[0].failed,false);assert.equal(sent.filter(x=>x.op==='msg.send').length,1);
});

test('malformed receipts/input identities are rejected and permissions use fixed messages',t=>{
  assert.equal(parseFrame({v:1,op:'msg.status',d:{id:'a',status:'accepted'}}),null);
  assert.equal(parseFrame({...inputPush(1,'m','a'),inputSeq:-1}),null);
  for(const code of ['ENTRY_DISABLED','USER_FORBIDDEN','TENANT_INACTIVE','TOKEN_REVOKED','RESUME_INVALID']){
    const {pet}=fixture(t);const notices=[];pet.on('notice',n=>notices.push(n));pet.receive({v:1,op:'error',d:{code,message:'PRIVATE_FIXTURE'}});
    assert.equal(pet.stopped,true);assert.ok(notices.length);assert.ok(notices.every(n=>!n.includes('PRIVATE_FIXTURE')));
  }
});
