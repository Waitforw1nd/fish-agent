import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pointer from '../src/vendor/dsh-pet/pointer-target.cjs';
import geometry from '../src/vendor/dsh-pet/desktop-geometry.cjs';
import { createWindowController,petWindowOptions,validateRegions } from '../src/main/window-controller.js';
test('borrowed hit testing keeps input live and releases empty margin',()=>{
  const bounds={x:100,y:100,width:300,height:300},body={x:80,y:80,width:100,height:100};
  assert.equal(pointer.decideWindowIgnore(bounds,{x:200,y:200},true,false,0,{body}),false);
  assert.equal(pointer.decideWindowIgnore(bounds,{x:110,y:110},false,false,500,{body}),true);
  assert.equal(pointer.decideWindowIgnore(bounds,{x:10,y:10},true,true,500,{body}),false);
  assert.equal(pointer.decideWindowIgnore(bounds,{x:115,y:115},true,false,500,{body,rects:[{x:0,y:0,width:30,height:30}]}),false);
});
test('work area clamping handles negative monitor origins and small screens',()=>{
  const area={x:-1920,y:0,width:1920,height:1040};
  assert.deepEqual(geometry.clampToWorkArea({x:-3000,y:2000,width:380,height:640},area),{x:-1920,y:400,width:380,height:640});
  const options=petWindowOptions('preload',{x:0,y:0,width:320,height:500});
  assert.equal(options.width,320);assert.equal(options.height,500);assert.equal(options.webPreferences.sandbox,true);
  assert.throws(()=>validateRegions({rects:[{x:0,y:0,width:9999,height:1}]},{width:300,height:300}));
});
test('display removal recovers window, drag does not break input, cleanup releases polling',()=>{
  const win=new EventEmitter(),screen=new EventEmitter();let bounds={x:2000,y:0,width:280,height:280},pos={x:20,y:20},poll,cleared=false,ignore;
  Object.assign(win,{isDestroyed:()=>false,isVisible:()=>true,getBounds:()=>({...bounds}),setBounds:b=>bounds=b,setPosition:(x,y)=>bounds={...bounds,x,y},setIgnoreMouseEvents:v=>ignore=v,webContents:{send(){}},focus(){},show(){}});
  const display={id:1,workArea:{x:0,y:0,width:1200,height:800},bounds:{x:0,y:0,width:1200,height:800}};
  Object.assign(screen,{getAllDisplays:()=>[display],getDisplayMatching:()=>display,getPrimaryDisplay:()=>display,getCursorScreenPoint:()=>pos});
  const controller=createWindowController({window:win,screen,setIntervalImpl:fn=>{poll=fn;return 123;},clearIntervalImpl:()=>cleared=true});
  screen.emit('display-removed');assert.equal(bounds.x,920);
  controller.beginDrag();pos={x:120,y:120};poll();assert.equal(bounds.x,1020);assert.equal(ignore,undefined);controller.endDrag();assert.equal(bounds.x,920);
  controller.setExpanded(true);assert.equal(bounds.width,380);assert.ok(bounds.y+bounds.height<=800);
  controller.dispose();assert.equal(cleared,true);assert.equal(screen.listenerCount('display-removed'),0);
});
