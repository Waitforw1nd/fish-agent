import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPresentation, presentationReducer, selectAction } from '../src/core/presentation-machine.js';
test('activity and independent connection reset stale thinking',()=>{
  let s=initialPresentation(); s=presentationReducer(s,{type:'connection',value:'online'}); s=presentationReducer(s,{type:'activity',value:'thinking'}); assert.equal(s.activity,'thinking');
  s=presentationReducer(s,{type:'connection',value:'offline'}); assert.equal(s.activity,'idle'); assert.equal(s.connectionStatus,'offline');
  s=presentationReducer(s,{type:'activity',value:'unknown'}); assert.equal(s.activity,'idle');
});
test('missing action mapping selects fallback',()=>{
  const m={activityMap:{thinking:'missing'},actions:{idle:{asset:'base'}},fallbackAction:'idle'};
  assert.equal(selectAction(m,{activity:'thinking'}),'idle');
});
test('PetView replaces image without changing presentation state and releases it',async()=>{
  const {createPetView}=await import('../src/ui/pet-view.js');
  const img={removeAttribute(name){delete this[name];},remove(){this.removed=true;}};
  const element={ownerDocument:{createElement(){return img;}},dataset:{},replaceChildren(child){this.child=child;}};
  const pack=(name,uri)=>({name,manifest:{activityMap:{idle:'idle',thinking:'idle'},actions:{idle:{asset:'base'}},fallbackAction:'idle'},assets:{base:uri}});
  const view=createPetView(element,{pack:pack('one','data:image/png;base64,one')}); view.setConnection('connected'); view.setActivity('thinking'); view.setPack(pack('two','data:image/png;base64,two'));
  assert.equal(img.src,'data:image/png;base64,two'); assert.equal(element.dataset.activity,'thinking'); assert.equal(element.dataset.connection,'connected');
  view.destroy(); assert.equal(img.src,undefined); assert.equal(img.removed,true);
});
test('offline activity cannot revive stale thinking',()=>{
  let s=initialPresentation(); s=presentationReducer(s,{type:'activity',value:'thinking'}); assert.equal(s.activity,'idle');
  s=presentationReducer(s,{type:'connection',value:'connected'}); s=presentationReducer(s,{type:'activity',value:'thinking'}); assert.equal(s.activity,'thinking');
  s=presentationReducer(s,{type:'connection',value:'disconnected'}); s=presentationReducer(s,{type:'activity',value:'thinking'}); assert.equal(s.activity,'idle');
  s=presentationReducer(s,{type:'connection',value:'connected'}); assert.equal(s.activity,'idle');
});
