// Reproduce the regression without modifying the checked-out client.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const file = new URL('../../packages/desktop-pet/src/client.js', import.meta.url);
let source = await readFile(file, 'utf8');
const guard = 'if(this.blocked || this.recoverySaveFailed)return;';
assert.equal(source.split(guard).length, 2);
source = source.replace(guard, '').replace(/from '(\.\/[^']+)'/g, (_, specifier) => `from '${new URL(specifier, file).href}'`);
const { PetConnection } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const pet = new PetConnection({credentials:{deviceId:'device-a'},WebSocket:null,idGenerator:()=> 'local-1'});
pet.stopped=false;pet.socket={readyState:1,send(){},close(){}};
pet.sendText('queued');
const push=seq=>({v:1,op:'msg.push',seq,d:{messageId:`mid-${seq}`,segments:[{type:'text',data:{text:'reply'}}]}});
pet.receive({v:1,op:'ready',d:{capabilities:['recovery.v1','receipt.v1','input-history.v1'],epoch:'epoch-1',serverSeq:2,oldestSeq:1,replayFrom:1,replayTo:2,hasGap:false,inputServerSeq:0,inputOldestSeq:1,inputReplayFrom:1,inputReplayTo:0,inputHasGap:false,replay:[push(2),push(1)]}});
try { assert.equal(pet.currentStatus,'recovery_error'); } finally { pet.stop(); }
