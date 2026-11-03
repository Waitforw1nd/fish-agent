export async function readPairResponse(res, limit = 65536) {
  const declared=Number(res.headers?.get?.('content-length'));
  if(Number.isFinite(declared) && declared>limit) throw new Error('配对响应过大');
  if (!res.body?.getReader) return res.json();
  const reader=res.body.getReader();const chunks=[];let size=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('配对响应过大');}chunks.push(value);} }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {throw new Error('配对响应无效');}
}
