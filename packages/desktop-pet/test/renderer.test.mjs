import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=require('../../qq-agent-core/node_modules/jsdom'));}
const html=fs.readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('../src/renderer.js',import.meta.url),'utf8');
function fixture(t){
  const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());
  let resolve;const events={},calls=[];
  dom.window.pet={init:()=>new Promise(r=>resolve=r),send:async value=>{calls.push(['send',value]);},unpair:async()=>calls.push(['unpair']),setExpanded:async value=>value,hide(){},reconnect(){},retry:async id=>calls.push(['retry',id]),drop:async id=>calls.push(['drop',id])};
  for(const name of ['Status','Mood','Messages','Notice','Expanded','Layout'])dom.window.pet['on'+name]=fn=>{events[name]=fn;return()=>delete events[name];};
  dom.window.eval(script);return {dom,events,calls,resolve};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('late init cannot overwrite newer status, history or error events',async t=>{
  const {dom,events,resolve}=fixture(t);
  events.Status('connected');events.Messages([{role:'assistant',segments:[{type:'text',data:{text:'新的回复'}}]}]);events.Notice('新的通知');
  resolve({paired:true,status:'connecting',messages:[],notice:'旧通知'});await tick();
  assert.equal(dom.window.document.getElementById('status').textContent,'已连接');assert.match(dom.window.document.getElementById('messages').textContent,/新的回复/);assert.equal(dom.window.document.getElementById('notice').textContent,'新的通知');
});
test('unreadable local credentials still expose a deliberate clear operation',async t=>{
  const {dom,resolve,calls}=fixture(t);resolve({paired:false,hasStoredData:true,status:'unpaired',messages:[],notice:'无法读取本机加密会话'});await tick();
  const button=dom.window.document.getElementById('unpair');assert.equal(button.hidden,false);button.click();await tick();assert.equal(button.hidden,true);assert.deepEqual(calls,[['unpair']]);
});
test('IME confirmation and Shift+Enter do not send, Enter sends once',async t=>{
  const {dom,resolve,calls}=fixture(t);resolve({paired:true,status:'connected',messages:[]});await tick();const input=dom.window.document.getElementById('text');input.value='你好';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(calls.length,0);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await tick();assert.deepEqual(calls,[['send','你好']]);
});
test('uncertain actions stay explicit and hostile text stays text',async t=>{
  const {dom,events,resolve,calls}=fixture(t);resolve({paired:true,status:'connected',messages:[]});await tick();events.Messages([{role:'user',id:'c-1',sendState:'uncertain',segments:[{type:'text',data:{text:'<script>bad()</script>'}}]}]);
  const box=dom.window.document.getElementById('messages');assert.equal(box.querySelector('script'),null);assert.match(box.textContent,/重试可能重复/);box.querySelectorAll('button')[0].click();await tick();assert.deepEqual(calls,[['retry','c-1']]);
  events.Status('disconnected');events.Mood('thinking');assert.equal(dom.window.document.getElementById('activity').textContent,'陪你聊一会儿');
});

test('an IPC send in progress cannot duplicate input or erase a newly typed draft or notice',async t=>{
  const {dom,resolve,events}=fixture(t);resolve({paired:true,status:'connected',messages:[]});await tick();
  let release;const sent=[];dom.window.pet.send=text=>{sent.push(text);return new Promise(r=>release=r);};
  const input=dom.window.document.getElementById('text'),form=dom.window.document.getElementById('form');
  input.value='first';form.requestSubmit();form.requestSubmit();assert.deepEqual(sent,['first']);
  input.value='next draft';events.Notice('保存失败，需要处理');release();await tick();
  assert.equal(input.value,'next draft');assert.equal(dom.window.document.getElementById('notice').textContent,'保存失败，需要处理');
  form.requestSubmit();assert.deepEqual(sent,['first','next draft']);release();await tick();assert.equal(input.value,'');
});

test('late init cannot revert a successful pairing',async t=>{
  const {dom,resolve,events}=fixture(t);dom.window.pet.pair=async()=>{};
  dom.window.document.getElementById('pairButton').click();await tick();events.Status('connected');
  resolve({paired:false,hasStoredData:false,status:'unpaired',messages:[]});await tick();
  assert.equal(dom.window.document.getElementById('chat').hidden,false);
  assert.equal(dom.window.document.getElementById('pair').hidden,true);
  assert.equal(dom.window.document.getElementById('unpair').hidden,false);
});
