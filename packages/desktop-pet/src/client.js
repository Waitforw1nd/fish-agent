import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readPairResponse } from './pair-response.js';
import { parseFrame, cleanSegments } from './core/protocol-v1.js';
import { restoreSession, setDelivery, protectPendingMessages } from './core/session-machine.js';
import { RECOVERY_CAPABILITIES, validRecoveryMetadata, matchesRecoveryCursor, mergeInput } from './core/recovery-contract.js';

export function endpoint(input, websocket = false) {
  let url; try { url = new URL(input); } catch { throw new Error('地址格式不正确'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowed = websocket ? ['wss:', ...(loopback ? ['ws:'] : [])] : ['https:', ...(loopback ? ['http:'] : [])];
  if (!allowed.includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('请使用 HTTPS 地址（本机测试可使用 HTTP）');
  return url;
}
export async function pairDevice({ host, code, deviceName, os, fetchImpl = fetch }) {
  const base = endpoint(host); const url = new URL('/desktop/v1/pair', base);
  if (!/^[A-Za-z0-9-]{4,32}$/.test(String(code || ''))) throw new Error('配对码格式不正确');
  let res;
  try { res = await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,deviceName,os}),redirect:'error',signal:AbortSignal.timeout(10000)}); }
  catch { throw new Error('无法连接配对服务，请检查地址和网络'); }
  if (!res.ok) {
    let result; try { result = await readPairResponse(res); } catch {}
    const reasons = {PAIRING_EXPIRED:'配对码已失效或已使用，请重新生成',INVALID_PAIRING:'配对码无效，请检查后重试',SEAT_LIMIT:'桌宠设备席位已满，请在面板管理设备'};
    const code = [result?.code,result?.error?.code].find(value => typeof value === 'string' && Object.hasOwn(reasons,value));
    throw new Error(code ? reasons[code] : `配对失败 (${res.status})`);
  }
  const result = await readPairResponse(res);
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.wsUrl !== 'string' || typeof result.deviceId !== 'string' || !/^[\w-]{1,128}$/.test(result.deviceId) || typeof result.deviceToken !== 'string' || !/^fdt_[A-Za-z0-9_-]{16,256}$/.test(result.deviceToken)) throw new Error('配对响应无效');
  const ws = endpoint(new URL(result.wsUrl,base).href,true);
  if (ws.hostname !== base.hostname || ws.port !== base.port || (base.protocol === 'https:' && ws.protocol !== 'wss:') || (base.protocol === 'http:' && ws.protocol !== 'ws:') || ws.pathname !== '/desktop/v1/ws') throw new Error('配对返回的连接地址无效');
  return {deviceId:result.deviceId,deviceToken:result.deviceToken,desktopUserId:String(result.desktopUserId || ''),tenantSlug:String(result.tenantSlug || ''),wsUrl:ws.href};
}
const bytes = x => Buffer.byteLength(JSON.stringify(x),'utf8');
const permissionNotices={TOKEN_REVOKED:'设备配对已被吊销，请重新配对',ENTRY_DISABLED:'桌宠入口已停用，请在面板检查',USER_FORBIDDEN:'当前用户无权使用此入口，请检查权限',TENANT_INACTIVE:'租户已停用或到期，请在面板检查'};
export class PetConnection extends EventEmitter {
  constructor({credentials,WebSocket,state={},save=()=>{},random=Math.random,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,idGenerator=randomUUID,replayTimeoutMs=10000,ackTimeoutMs=30000}) {
    super(); Object.assign(this,{credentials,WebSocket,save,random,setTimer,clearTimer,now,idGenerator,replayTimeoutMs,ackTimeoutMs}); try{Object.assign(this,restoreSession(state));}catch{this.invalidSession=true;Object.assign(this,{seq:0,pending:[],messages:[]});}
    for(const key of ['pending','messages']){let value=this[key];Object.defineProperty(this,key,{enumerable:true,get:()=>structuredClone(value),set:next=>{value=structuredClone(next);}});}
    this.attempt=0; this.stopped=true; this.ready=false; this.currentStatus=this.invalidSession?'recovery_error':'disconnected'; this.generation=0; this.inflight=null; this.timers=new Set(); this.blocked=!!this.invalidSession; this.disconnectedAt=null;this.capabilities=new Set();this.receiptQueries=new Set();
  }
  snapshot(){return structuredClone({seq:this.seq,inputSeq:this.inputSeq??0,...(this.epoch?{epoch:this.epoch}:{}),pending:this.pending,messages:this.messages});}
  commit(next){const copy=structuredClone(next);copy.messages=protectPendingMessages(copy.messages,copy.pending);this.save(structuredClone(copy)); Object.assign(this,copy);}
  persist(){this.save(this.snapshot());}
  status(value){this.currentStatus=value;this.emit('status',value);}
  schedule(fn,delay){const timer=this.setTimer(()=>{this.timers.delete(timer);fn();},delay);this.timers.add(timer);timer?.unref?.();return timer;}
  cancel(timer){if(timer){this.clearTimer(timer);this.timers.delete(timer);}}
  clearTimers(){for(const timer of this.timers)this.clearTimer(timer);this.timers.clear();this.timer=this.heartbeat=this.readyTimer=this.replayTimer=this.ackTimer=null;this.recovering=false;this.applyingReplay=false;this.receiptQueries.clear();}
  closeSocket(){const ws=this.socket;this.socket=null;this.generation++;if(ws){try{ws.terminate?.();if(!ws.terminate)ws.close();}catch{}}}
  connect(){
    if(this.invalidSession){this.status('recovery_error');this.emit('notice','本地待发送队列损坏或过大，请检查本地会话');return;}if(this.socket || this.timer)return; this.stopped=false;this.blocked=false;this.ready=false;this.status('connecting');const generation=++this.generation;
    let ws;try{ws=this.socket=new this.WebSocket(endpoint(this.credentials.wsUrl,true).href,{headers:{Authorization:`Bearer ${this.credentials.deviceToken}`},maxPayload:3*1024*1024,handshakeTimeout:10000});}catch(error){this.status('disconnected');this.scheduleReconnect();return;}
    const active=()=>generation===this.generation && ws===this.socket && !this.stopped;
    this.readyTimer=this.schedule(()=>{if(active())ws.terminate();},10000);
    let opened=false;ws.on('open',()=>{if(active()){opened=true;this.sendFrame('hello',{deviceId:this.credentials.deviceId,clientVersion:'1.0.0',resumeSeq:this.seq,inputResumeSeq:this.inputSeq??0,...(this.epoch?{epoch:this.epoch}:{}),caps:['text'],capabilities:RECOVERY_CAPABILITIES});}});
    ws.on('message',(data,binary)=>{if(!active())return;this.lastReceived=this.now();const frame=!binary && Buffer.byteLength(data)<=3*1024*1024 ? parseFrame(String(data)) : null;if(frame){this.invalidFrames=0;if(!this.ready && !['ready','ping','error'].includes(frame.op))return;if(frame.op==='msg.ack' && frame.d.id!==this.inflight && !this.pending.some(p=>p.id===frame.d.id && p.attempted && p.uncertain))return;if(frame.op==='error' && frame.d.id && frame.d.id!==this.inflight && !this.receiptQueries.has(frame.d.id))return;this.receive(frame);}else if((this.invalidFrames=(this.invalidFrames||0)+1)>=3){this.authBlock('recovery_error');this.emit('notice','服务端协议异常，请检查连接');}});
    ws.on('unexpected-response',(_req,res)=>{if(!active())return;if([401,403].includes(res.statusCode)){this.authBlock(res.statusCode===401?'revoked':'auth_blocked');let body='';res.on?.('data',part=>{if(body.length<=2048)body+=String(part);});res.on?.('end',()=>{if(!this.blocked||body.length>2048)return;try{const code=JSON.parse(body).code;if(Object.hasOwn(permissionNotices,code))this.emit('notice',permissionNotices[code]);}catch{}});res.resume?.();}else ws.terminate();});
    ws.on('error',()=>{});
    ws.on('close',(code,reason)=>{if(!active())return;const failedRecovery=opened && (this.recovering || (!this.ready && (this.seq>0 || (this.inputSeq??0)>0)));this.socket=null;this.ready=false;this.cancel(this.readyTimer);this.cancel(this.heartbeat);this.cancel(this.replayTimer);this.cancel(this.ackTimer);this.recovering=false;this.inflight=null;this.disconnectedAt=this.disconnectedAt ?? this.now();if(code===4001||code===4003){this.authBlock(code===4001?'revoked':'auth_blocked');const key=String(reason??'');if(Object.hasOwn(permissionNotices,key))this.emit('notice',permissionNotices[key]);return;}if(code===1008){this.authBlock('recovery_error');this.emit('notice','连接被协议策略拒绝，请检查会话恢复状态');return;}if(failedRecovery && (this.recoveryHandshakeFailures=(this.recoveryHandshakeFailures||0)+1)>=3){this.authBlock('recovery_error');this.emit('notice','多次连接后未能完成会话恢复，请检查服务状态或手动重试');return;}this.status('disconnected');this.scheduleReconnect();});
  }
  scheduleReconnect(){if(this.stopped||this.blocked||this.timer)return;const delay=Math.min(30000,1000*2**Math.min(this.attempt++,5))*(0.8+this.random()*0.4);this.timer=this.schedule(()=>{this.timer=null;this.connect();},delay);}
  reconnect(){if(this.socket && this.disconnectedAt===null)this.disconnectedAt=this.now();this.clearTimers();this.closeSocket();this.stopped=false;this.blocked=false;this.inflight=null;this.recoveryHandshakeFailures=0;this.connect();}
  authBlock(status){this.stopped=true;this.blocked=true;this.ready=false;this.clearTimers();this.closeSocket();this.status(status);}
  storageFailure(){this.recoverySaveFailed=true;this.disconnectedAt=this.disconnectedAt??this.now();this.authBlock('recovery_error');this.emit('notice','保存失败，连接与自动补发已暂停；恢复存储后手动重新连接。');}
  revoked(){this.authBlock('revoked');}
  stop(){if(this.socket && this.disconnectedAt===null)this.disconnectedAt=this.now();this.stopped=true;this.ready=false;this.clearTimers();this.closeSocket();this.inflight=null;}
  sendFrame(op,d={},extra={}){if(this.socket?.readyState!==1)return false;try{this.socket.send(JSON.stringify({v:1,op,ts:this.now(),...extra,d}));return true;}catch{const ws=this.socket;try{ws?.terminate?.();}catch{}if(ws===this.socket){this.clearTimers();this.closeSocket();this.ready=false;this.inflight=null;this.disconnectedAt=this.disconnectedAt ?? this.now();this.status('disconnected');this.scheduleReconnect();}return false;}}
  sendText(text,replyId=''){const value=String(text||'').trim();if(!value||value.length>10000)throw new Error('请输入不超过 10000 字的消息');const segments=[];if(replyId)segments.push({type:'reply',data:{id:String(replyId)}});segments.push({type:'text',data:{text:value}});return this.sendSegments(segments);}
  remember(messages,message){return [...messages,message];}
  sendSegments(segments){if(this.stopped)throw new Error('设备未连接，请重新配对');const id=this.idGenerator();const item={id,segments,attempted:false};let pending=[...this.pending,item];if(pending.length>100 || bytes(pending)>8*1024*1024)throw new Error('待发送消息过多');if(!/^[\w.-]{1,128}$/.test(id) || !Array.isArray(segments) || !segments.length || segments.length>32 || bytes({v:1,op:'msg.send',id,d:{segments}})>3*1024*1024 || cleanSegments(segments).length!==segments.length || segments.some(s=>s.type==='text' && s.data.text.length>10000))throw new Error('消息格式无效或过大');segments=JSON.parse(JSON.stringify(segments));pending=[...this.pending,{id,segments,attempted:false}];const messages=this.remember(this.messages,{role:'user',id,segments,pending:true,failed:false,sendState:'queued'});this.commit({...this.snapshot(),pending,messages});this.emit('messages',structuredClone(this.messages));this.pump();return id;}
  pump(){if(!this.ready||this.inflight||this.recovering||this.blocked||this.pending.some(x=>x.uncertain))return;const p=this.pending.find(x=>!x.failed);if(!p)return;const pending=this.pending.map(x=>x.id===p.id?{...x,attempted:true}:x);const next=setDelivery({...this.snapshot(),pending},p.id,'awaiting_ack');try{this.commit(next);}catch{this.storageFailure();return;}this.inflight=p.id;this.emit('messages',structuredClone(this.messages));if(!this.sendFrame('msg.send',{segments:p.segments},{id:p.id}))return;this.ackTimer=this.schedule(()=>{if(this.inflight!==p.id)return;const pending=this.pending.map(x=>x.id===p.id?{...x,uncertain:true}:x);try{this.commit(setDelivery({...this.snapshot(),pending},p.id,'uncertain'));this.inflight=null;this.emit('messages',structuredClone(this.messages));this.emit('notice','发送结果未确认，重试可能重复');}catch{this.storageFailure();}},this.ackTimeoutMs);}
  retry(id){let p=this.pending.find(x=>x.id===id);let pending;if(p){if(!p.uncertain && !p.failed)return false;pending=this.pending.map(x=>x.id===id?{...x,uncertain:false,failed:false}:x);}else{const message=this.messages.find(x=>x.id===id && x.sendState==='failed');if(!message)return false;p={id,segments:message.segments,attempted:false};pending=[...this.pending,p];if(pending.length>100 || bytes(pending)>8*1024*1024)throw new Error('待发送消息过多');}this.commit(setDelivery({...this.snapshot(),pending},id,'queued'));this.emit('messages',structuredClone(this.messages));this.pump();return true;}
  drop(id){const p=this.pending.find(x=>x.id===id);const message=this.messages.find(x=>x.id===id);if(!(p && (p.uncertain || p.failed)) && !(message?.sendState==='failed' && !p))return false;const pending=this.pending.filter(x=>x.id!==id);this.commit(setDelivery({...this.snapshot(),pending},id,'discarded'));this.emit('messages',structuredClone(this.messages));this.pump();return true;}
  poke(){if(this.ready)this.sendFrame('pet.poke');}
  heartbeatTick(){if(!this.ready)return;if(this.now()-this.lastReceived>90000){this.socket?.terminate();return;}if(this.sendFrame('ping'))this.heartbeat=this.schedule(()=>this.heartbeatTick(),30000);}
  recoveryFailure(message){this.authBlock('recovery_error');this.emit('notice',message);}
  recoveryFinish(){
    if(this.waitOutputEnd||this.waitInputEnd){this.recoveryFailure('历史回放未完成，自动发送已暂停，请手动重新连接');return;}
    this.recovering=false;this.cancel(this.replayTimer);this.attempt=0;this.recoveryHandshakeFailures=0;
    if(this.replayTarget>this.seq || this.inputReplayTarget>(this.inputSeq??0)){this.recoveryGap=true;this.emit('notice','部分历史无法恢复');}
    if(this.pending.some(p=>p.attempted)){
      const pending=this.pending.map(p=>p.attempted?{...p,uncertain:true}:p);let next={...this.snapshot(),pending};for(const p of pending)if(p.uncertain)next=setDelivery(next,p.id,'uncertain');
      try{this.commit(next);this.emit('messages',structuredClone(this.messages));}catch{this.storageFailure();return;}
    }
    this.disconnectedAt=null;this.status('connected');
    if(this.capabilities.has('receipt.v1'))for(const p of this.pending)if(p.attempted && !p.failed){this.receiptQueries.add(p.id);if(!this.sendFrame('msg.status',{}, {id:p.id}))break;}
    if(!this.recoveryGap)this.emit('notice','');
    this.pump();
  }
  receiveRecovery(m){
    if(m.op==='msg.status'){
      if(!this.capabilities.has('receipt.v1')||!this.receiptQueries.has(m.d.id))return true;
      if(m.d.status!=='in_progress')this.receiptQueries.delete(m.d.id);
      if(m.d.status==='accepted')this.receive({v:1,op:'msg.ack',d:m.d});
      else this.emit('notice',m.d.status==='in_progress'?'消息仍在处理，等待最终确认':'云端未保留接收结果，重试可能重复，请选择重试或放弃');
      return true;
    }
    if(m.op==='input.push'){
      if(!this.capabilities.has('input-history.v1')||this.recoverySaveFailed||m.inputSeq<=(this.inputSeq??0))return true;
      if(m.inputSeq>(this.inputSeq??0)+1){if(m.inputSeq!==this.allowedInputGapSeq){this.recoveryFailure('用户消息回放存在未声明缺口，自动发送已暂停');return true;}this.recoveryGap=true;this.emit('notice','部分用户消息历史无法恢复');}
      this.allowedInputGapSeq=null;
      const clean=cleanSegments(m.d.segments);
      if(clean.length!==m.d.segments.length)this.emit('notice','部分用户消息内容无法显示');
      try{this.commit(mergeInput(this.snapshot(),{...m,d:{...m.d,segments:clean}},this.credentials.deviceId));this.emit('messages',structuredClone(this.messages));}catch{this.storageFailure();}
      return true;
    }
    if(m.op==='replay.end'||m.op==='input.replay.end'){
      const input=m.op==='input.replay.end', capability=input?'input-history.v1':'recovery.v1';
      if(!this.capabilities.has(capability)||!this.recovering)return true;
      const target=input?this.inputReplayTarget:this.replayTarget;
      if(!validRecoveryMetadata(m.d,input)||m.d.epoch!==this.epoch||(input?m.d.inputReplayTo:m.d.replayTo)!==target){this.recoveryFailure('回放结束标记不一致，自动发送已暂停');return true;}
      const cursor=input?(this.inputSeq??0):this.seq;
      const from=input?m.d.inputReplayFrom:m.d.replayFrom;
      if(from!==(input?this.inputReplayFrom:this.outputReplayFrom)||(target>cursor&&from<=target)){this.recoveryFailure('回放结束时仍缺少声明的消息，自动发送已暂停');return true;}
      if(input)this.waitInputEnd=false;else this.waitOutputEnd=false;
      this.recoveryGap ||= input?m.d.inputHasGap:m.d.hasGap;
      if(!this.waitInputEnd&&!this.waitOutputEnd)this.recoveryFinish();
      return true;
    }
    return false;
  }
  receive(input){
    const m=parseFrame(input);if(!m)return;
    if(this.receiveRecovery(m))return;
    if(m.op==='ready'){
      if(this.ready)return;this.cancel(this.readyTimer);if(m.d.serverSeq!==undefined && m.d.serverSeq<this.seq){this.blocked=true;this.ready=false;this.clearTimers();this.closeSocket();this.status('recovery_error');this.emit('notice','会话序号回退，自动发送已暂停');return;}
      this.capabilities=new Set(Array.isArray(m.d.capabilities)?m.d.capabilities.filter(c=>RECOVERY_CAPABILITIES.includes(c)):[]);
      this.waitOutputEnd=this.capabilities.has('recovery.v1');this.waitInputEnd=this.capabilities.has('input-history.v1');
      if(this.epoch && ((!this.waitOutputEnd && !this.waitInputEnd) || (this.seq>0 && !this.waitOutputEnd) || ((this.inputSeq??0)>0 && !this.waitInputEnd))){this.recoveryFailure('云端恢复能力已改变，自动发送已暂停');return;}
      if((this.waitOutputEnd&&(!validRecoveryMetadata(m.d)||!matchesRecoveryCursor(m.d,this.seq)))||(this.waitInputEnd&&(!validRecoveryMetadata(m.d,true)||!matchesRecoveryCursor(m.d,this.inputSeq??0,true)))||((this.waitOutputEnd||this.waitInputEnd)&&this.epoch&&this.epoch!==m.d.epoch)){this.recoveryFailure('云端会话恢复标记已改变或无效，自动发送已暂停');return;}
      if(this.waitOutputEnd||this.waitInputEnd){try{this.commit({...this.snapshot(),epoch:m.d.epoch});}catch{this.storageFailure();return;}}
      this.receiptQueries.clear();this.ready=true;this.replayTarget=m.d.serverSeq ?? this.seq;this.inputReplayTarget=this.waitInputEnd?m.d.inputServerSeq:(this.inputSeq??0);this.recovering=true;this.recoveryGap=!!(m.d.hasGap||m.d.inputHasGap);this.recoverySaveFailed=false;this.applyingReplay=true;
      this.allowedOutputGapSeq=this.waitOutputEnd&&m.d.hasGap?m.d.replayFrom:null;this.allowedInputGapSeq=this.waitInputEnd&&m.d.inputHasGap?m.d.inputReplayFrom:null;
      this.outputReplayFrom=m.d.replayFrom;this.inputReplayFrom=m.d.inputReplayFrom;
      if(this.recoveryGap)this.emit('notice','云端历史保留窗口已有缺口，未确认消息将查询接收结果');
      if((m.d.replay||[]).length>200)this.emit('notice','回放条目超出上限，部分历史可能无法恢复');
      for(const x of (m.d.replay||[]).slice(0,200)){if(x?.op==='msg.push' && parseFrame(x) && (m.d.serverSeq===undefined || x.seq<=m.d.serverSeq))this.receive(x);else{this.recoveryGap=true;this.emit('notice','回放包含无效条目，部分历史可能无法恢复');}if(this.blocked || this.recoverySaveFailed)return;}
      this.applyingReplay=false;
      if(this.recoverySaveFailed)return;
      this.lastReceived=this.now();this.heartbeat=this.schedule(()=>this.heartbeatTick(),30000);
      if(this.replayTarget>this.seq||this.waitOutputEnd||this.waitInputEnd){this.emit('notice','正在恢复历史消息，待发送消息暂缓');this.replayTimer=this.schedule(()=>this.recoveryFinish(),this.replayTimeoutMs);}else this.recoveryFinish();return;
    }
    if(m.op==='msg.ack'){const id=m.d.id;if(!this.pending.some(x=>x.id===id && x.attempted))return;const pending=this.pending.filter(x=>x.id!==id);try{this.commit(setDelivery({...this.snapshot(),pending},id,'accepted',{messageId:String(m.d.messageId||'').slice(0,128)}));}catch{this.storageFailure();return;}this.receiptQueries.delete(id);if(this.inflight===id){this.inflight=null;this.cancel(this.ackTimer);}this.emit('messages',structuredClone(this.messages));this.pump();return;}
    if(m.op==='msg.push'){if(this.recoverySaveFailed || m.seq<=this.seq)return;const gap=m.seq>this.seq+1;if(gap){if(this.capabilities.has('recovery.v1')&&m.seq!==this.allowedOutputGapSeq){this.recoveryFailure('回复回放存在未声明缺口，自动发送已暂停');return;}this.recoveryGap=true;this.emit('notice','部分历史无法恢复');}this.allowedOutputGapSeq=null;const clean=cleanSegments(m.d.segments);if(clean.length!==m.d.segments.length || m.d.segments.some(s=>s?.type==='text' && s.data?.text?.length>10000))this.emit('notice','部分消息内容无法显示');const messages=this.remember(this.messages,{role:'assistant',messageId:String(m.d.messageId||'').slice(0,128),segments:clean});let next={...this.snapshot(),seq:m.seq,messages};if(gap && !this.recovering){next.pending=this.pending.map(p=>p.attempted?{...p,uncertain:true}:p);for(const p of next.pending)if(p.uncertain)next=setDelivery(next,p.id,'uncertain');}try{this.commit(next);}catch{this.storageFailure();return;}if(gap && !this.recovering){this.cancel(this.ackTimer);this.inflight=null;}this.emit('messages',structuredClone(this.messages));if(this.recovering && !this.applyingReplay && !this.recoverySaveFailed && !this.waitOutputEnd && !this.waitInputEnd && this.seq>=this.replayTarget){this.cancel(this.replayTimer);this.recoveryFinish();}return;}
    if(m.op==='msg.echo'){const id=String(m.d.messageId||'').slice(0,128);if(id&&!this.messages.some(x=>x.messageId===id)){try{this.commit({...this.snapshot(),messages:this.remember(this.messages,{role:'user',messageId:id,segments:cleanSegments(m.d.segments)})});this.emit('messages',structuredClone(this.messages));}catch{this.storageFailure();}}return;}
    if(m.op==='state' && ['idle','thinking','talking','sleeping'].includes(m.d.mood))this.emit('mood',m.d.mood);
    if(m.op==='ping')this.sendFrame('pong');
    if(m.op==='error'){
      const code=m.d.code;const id=typeof m.d.id==='string'?m.d.id:this.inflight;
      if(code==='RESUME_INVALID'){this.recoveryFailure('云端会话版本或恢复游标已失效，自动发送已暂停；请检查云端后重新配对');return;}
      if(Object.hasOwn(permissionNotices,code)){this.authBlock(code==='TOKEN_REVOKED'?'revoked':'auth_blocked');this.emit('notice',permissionNotices[code]);return;}
      if(code==='INGEST_FAILED' && id && this.pending.some(p=>p.id===id)){
        const pending=this.pending.map(p=>p.id===id?{...p,failed:false,uncertain:true}:p);
        try{this.commit(setDelivery({...this.snapshot(),pending},id,'uncertain'));if(this.inflight===id){this.inflight=null;this.cancel(this.ackTimer);}this.emit('messages',structuredClone(this.messages));}catch{this.storageFailure();return;}
      }
      if(['INVALID_SEGMENTS','INVALID_MESSAGE'].includes(code) && id && this.pending.some(p=>p.id===id)){
        const pending=code==='INVALID_SEGMENTS'?this.pending.filter(p=>p.id!==id):this.pending.map(p=>p.id===id?{...p,failed:true}:p);
        try{this.commit(setDelivery({...this.snapshot(),pending},id,'failed'));if(this.inflight===id){this.inflight=null;this.cancel(this.ackTimer);}this.emit('messages',structuredClone(this.messages));this.pump();}catch{this.storageFailure();}
      }
      if(['TOKEN_REVOKED','INVALID_TOKEN'].includes(code))this.revoked();
      else {
        const messages={INVALID_SEGMENTS:'消息内容不受支持，请检查后重试',INVALID_MESSAGE:'消息格式无效，请检查后重试',INGEST_FAILED:'入口处理或保存失败，发送结果未确认；重试可能重复',IN_PROGRESS:'消息仍在处理，正在等待确认'};
        this.emit('notice',Object.hasOwn(messages,code)?messages[code]:'服务端返回错误，请检查连接或联系管理员');
      }
    }
  }
}


