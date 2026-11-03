const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[\w.-]{1,128}$/.test(x);
export function parseFrame(raw) {
  let m; try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!record(m) || m.v !== 1 || typeof m.op !== 'string' || m.op.length > 64 || !record(m.d)) return null;
  if (m.op === 'msg.push' && (!Number.isSafeInteger(m.seq) || m.seq < 1 || !Array.isArray(m.d.segments))) return null;
  if (m.op === 'msg.echo' && !Array.isArray(m.d.segments)) return null;
  if (m.op === 'input.push' && (!Number.isSafeInteger(m.inputSeq) || m.inputSeq < 1 || !Array.isArray(m.d.segments) || !id(m.d.messageId) || !id(m.d.clientMessageId) || typeof m.d.deviceId !== 'string' || !/^[\w-]{1,128}$/.test(m.d.deviceId))) return null;
  if (m.op === 'msg.status' && (!id(m.d.id) || !['accepted','in_progress','unknown'].includes(m.d.status) || (m.d.status === 'accepted' && !id(m.d.messageId)))) return null;
  if (m.op === 'msg.ack' && !id(m.d.id)) return null;
  if (m.op === 'ready' && ((m.d.serverSeq !== undefined && (!Number.isSafeInteger(m.d.serverSeq) || m.d.serverSeq < 0)) || (m.d.replay !== undefined && !Array.isArray(m.d.replay)))) return null;
  if (m.op === 'error' && (typeof m.d.code !== 'string' || m.d.code.length > 128)) return null;
  return m;
}
export function cleanSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.slice(0,32).flatMap(s => {
    if (s?.type === 'text' && typeof s.data?.text === 'string') return [{type:'text',data:{text:s.data.text.slice(0,10000)}}];
    if (['face','reply'].includes(s?.type)) return [{type:s.type,data:{id:String(s.data?.id || '').slice(0,128)}}];
    if (s?.type === 'image' && typeof s.data?.file === 'string' && s.data.file.length <= 2796300) return [{type:'image',data:{file:s.data.file}}];
    return [];
  });
}
