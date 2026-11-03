import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { trustedHandler, restrictWindow } from '../src/main/security.js';
import { petWindowOptions } from '../src/main/window-controller.js';

test('actual preload exposes fixed commands and strips IPC event objects from subscriptions', () => {
  const ipc = new EventEmitter(), calls = []; let api;
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve(); };
  vm.runInNewContext(fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'pet'); api = value; } } }; }
  });
  assert.deepEqual(Object.keys(api).sort(), ['init','pair','send','retry','drop','reconnect','unpair','hide','quit','setExpanded','regions','drag','setPack','onStatus','onMood','onMessages','onNotice','onLayout','onExpanded'].sort());
  assert.ok(Object.isFrozen(api)); assert.equal(api.invoke, undefined); assert.equal(api.sendSync, undefined);
  api.send('<script>text only</script>'); api.pair('https://example.invalid', 'ABCD2345');
  assert.equal(calls[0][0], 'pet:send'); assert.equal(calls[0][1], '<script>text only</script>');
  assert.equal(calls[1][0], 'pet:pair'); assert.equal(calls[1][1].host, 'https://example.invalid');
  const received=[]; const dispose=api.onMessages((...args)=>received.push(args));
  ipc.emit('messages', { token:'PRIVATE_FIXTURE', sender:ipc }, ['safe']);
  assert.deepEqual(received, [[['safe']]]); dispose(); assert.equal(ipc.listenerCount('messages'),0);
});

test('IPC rejects foreign windows, subframes, navigation and malformed arguments before side effects', () => {
  const page='file:///fixture/index.html', frame={url:page};
  const window={isDestroyed:()=>false,webContents:{mainFrame:frame}}, options={getWindow:()=>window,page};
  const event={sender:window.webContents,senderFrame:frame}; let calls=0;
  const send=trustedHandler('pet:send', text=>{calls++;return text;},options);
  assert.equal(send(event,'hello'),'hello');
  for(const bad of [{sender:{},senderFrame:frame},{sender:window.webContents,senderFrame:{url:page}},{sender:window.webContents}]) assert.throws(()=>send(bad,'hello'));
  frame.url='https://example.invalid'; assert.throws(()=>send(event,'hello')); frame.url=page;
  for(const args of [[null],[{}],[''],['x'.repeat(10001)],['hello','extra']]) assert.throws(()=>send(event,...args));
  assert.throws(()=>trustedHandler('shell:execute',()=>{},options));
  const pair=trustedHandler('pet:pair',()=>{calls++;},options);
  assert.throws(()=>pair(event,{host:'https://example.invalid',code:'ABCD2345',headers:{authorization:'private'}}));
  const init=trustedHandler('pet:init',()=>{calls++;},options); assert.throws(()=>init(event,'extra'));
  assert.equal(calls,1);
});

test('window policy denies navigation, popups, webviews, downloads and unneeded permissions', () => {
  const contents=new EventEmitter(), session=new EventEmitter(); let popup,request,check;
  Object.assign(session,{setPermissionRequestHandler:fn=>request=fn,setPermissionCheckHandler:fn=>check=fn});
  Object.assign(contents,{session,setWindowOpenHandler:fn=>popup=fn}); restrictWindow({webContents:contents});
  assert.deepEqual(popup({url:'https://example.invalid'}),{action:'deny'});
  for(const name of ['will-navigate','will-frame-navigate','will-redirect','will-attach-webview']) {
    let denied=false; contents.emit(name,{preventDefault(){denied=true;}}); assert.equal(denied,true,name);
  }
  let denied=false; session.emit('will-download',{preventDefault(){denied=true;}}); assert.equal(denied,true);
  for(const permission of ['media','clipboard-read','geolocation','notifications','display-capture']) {
    let allowed; request(contents,permission,value=>allowed=value); assert.equal(allowed,false); assert.equal(check(contents,permission),false);
  }
  const preferences=petWindowOptions('/fixture/preload.cjs',{x:0,y:0,width:1000,height:800}).webPreferences;
  assert.equal(preferences.contextIsolation,true); assert.equal(preferences.nodeIntegration,false); assert.equal(preferences.sandbox,true);
  const html=fs.readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  for(const directive of ["script-src 'self'","connect-src 'none'","frame-src 'none'","object-src 'none'","worker-src 'none'","base-uri 'none'"]) assert.ok(html.includes(directive),directive);
  assert.doesNotMatch(html,/unsafe-inline|unsafe-eval/);
});
