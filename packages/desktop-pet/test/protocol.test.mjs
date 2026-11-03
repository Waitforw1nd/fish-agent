import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDevice } from '../src/client.js';
const input={host:'https://example.com',code:'ABC12345'};
const response=wsUrl=>({deviceId:'dev',deviceToken:'fdt_abcdefghijklmnop123456',wsUrl});
test('bounded pairing errors show known reason without reflecting remote text',async()=>{
 await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response(JSON.stringify({code:'SEAT_LIMIT',message:'untrusted'}),{status:403})}),/席位/);
 await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response('x'.repeat(65537),{status:400})}),/配对失败 \(400\)/);
});
test('pairing rejects cross-port and transport downgrade',async()=>{
 for(const wsUrl of ['wss://example.com:444/desktop/v1/ws','ws://example.com/desktop/v1/ws']) await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response(JSON.stringify(response(wsUrl)),{status:200})}));
 await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response('x'.repeat(65537),{status:200})}),/过大/);
});
test('malformed pairing payloads and transport diagnostics produce only safe errors',async()=>{
 for(const value of [null,[],"PRIVATE_FIXTURE",{},response(null)]) {
  await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response(JSON.stringify(value))}),{message:'配对响应无效'});
 }
 for(const code of ['__proto__','toString','constructor']) {
  await assert.rejects(pairDevice({...input,fetchImpl:async()=>new Response(JSON.stringify({code,message:'PRIVATE_FIXTURE'}),{status:400})}),{message:'配对失败 (400)'});
 }
 await assert.rejects(pairDevice({...input,fetchImpl:async()=>{throw new Error('transport failed: code=PRIVATE_FIXTURE');}}),{message:'无法连接配对服务，请检查地址和网络'});
});
