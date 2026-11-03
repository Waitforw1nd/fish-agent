// Pure snapshot transitions: callers commit the result before performing network I/O.
export function setDelivery(snapshot, id, sendState, patch = {}) {
  return {...snapshot, messages:snapshot.messages.map(m => m.id === id ? {...m, ...patch, sendState, pending:['queued','awaiting_ack'].includes(sendState), failed:sendState === 'failed'} : m)};
}
const utf8Size = value => new TextEncoder().encode(JSON.stringify(value)).length;
// Pending payloads live in the queue. Display copies may be summarized when history is full.
export function protectPendingMessages(messages, pending) {
  const ids = new Set(pending.map(p=>p.id));
  const seen=new Set();const rows = Array.isArray(messages) ? messages.filter(m=>{if(!ids.has(m?.id))return true;if(m.role!=='user' || seen.has(m.id))return false;seen.add(m.id);return true;}) : [];
  for (const p of pending) {
    const index=rows.findIndex(m=>m?.id===p.id && m.role==='user');const existing=index>=0?rows[index]:null;
    const sendState = p.uncertain ? 'uncertain' : p.failed ? 'failed' : p.attempted ? 'awaiting_ack' : 'queued';
    const row={...existing,role:'user',id:p.id,segments:existing?.segments ?? p.segments,sendState,pending:['queued','awaiting_ack'].includes(sendState),failed:sendState==='failed'};
    if(index>=0)rows[index]=row;else rows.push(row);
  }
  while(rows.length>200){const i=rows.findIndex(m=>!ids.has(m?.id));if(i<0)break;rows.splice(i,1);}
  while(utf8Size(rows)>8*1024*1024){
    const i=rows.findIndex(m=>!ids.has(m?.id));if(i>=0){rows.splice(i,1);continue;}
    const j=rows.findIndex(m=>!m.displaySummary);if(j<0)break;
    const row=rows[j];const text=(row.segments||[]).filter(s=>s?.type==='text').map(s=>String(s.data?.text||'')).join(' ').slice(0,512);
    rows[j]={role:'user',id:row.id,segments:[{type:'text',data:{text:text ? `${text}…` : '[待处理消息]'}}],sendState:row.sendState,pending:row.pending,failed:row.failed,displaySummary:true};
  }
  return rows;
}
export function restoreSession(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('会话数据损坏');
  const raw = state.pending ?? [];
  const validSegment=s=>s && typeof s==='object' && s.data && typeof s.data==='object' && ((s.type==='text' && typeof s.data.text==='string' && s.data.text.length<=10000) || (s.type==='image' && typeof s.data.file==='string' && s.data.file.length<=2796300) || (['face','reply'].includes(s.type) && typeof s.data.id==='string' && s.data.id.length<=128));
  if (!Array.isArray(raw) || raw.length > 100 || new TextEncoder().encode(JSON.stringify(raw)).length > 8*1024*1024 || raw.some(p => !p || typeof p.id !== 'string' || !/^[\w.-]{1,128}$/.test(p.id) || !Array.isArray(p.segments) || !p.segments.length || p.segments.length > 32 || !p.segments.every(validSegment) || new TextEncoder().encode(JSON.stringify({v:1,op:'msg.send',id:p.id,d:{segments:p.segments}})).length>3*1024*1024)) throw new Error('待发送队列损坏或过大');
  if (new Set(raw.map(p=>p.id)).size !== raw.length || (state.seq !== undefined && (!Number.isSafeInteger(state.seq) || state.seq < 0))) throw new Error('会话数据损坏');
  if ((state.epoch !== undefined && (typeof state.epoch !== 'string' || !/^[\w.-]{1,128}$/.test(state.epoch))) || (state.inputSeq !== undefined && (!Number.isSafeInteger(state.inputSeq) || state.inputSeq < 0))) throw new Error('恢复标记损坏');
  if (state.messages !== undefined && (!Array.isArray(state.messages) || state.messages.some(m =>
    !m || typeof m !== 'object' || Array.isArray(m) || (!raw.some(p => p.id === m.id)
      && (!['user','assistant'].includes(m.role) || !Array.isArray(m.segments) || !m.segments.every(validSegment)))))) throw new Error('历史消息损坏');
  const pending = JSON.parse(JSON.stringify(raw)).map(p => ({...p, uncertain:p.attempted !== false || !!p.uncertain}));
  let messages = Array.isArray(state.messages) ? JSON.parse(JSON.stringify(state.messages.slice(-200))) : [];
  while(messages.length && new TextEncoder().encode(JSON.stringify(messages)).length>8*1024*1024) messages.shift();
  let snapshot = {seq:state.seq ?? 0, inputSeq:state.inputSeq ?? 0, ...(state.epoch ? {epoch:state.epoch} : {}), pending, messages:protectPendingMessages(messages,pending)};
  for (const p of pending) snapshot = setDelivery(snapshot, p.id, p.uncertain ? 'uncertain' : 'queued');
  return snapshot;
}
