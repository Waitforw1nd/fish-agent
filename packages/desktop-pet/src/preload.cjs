const { contextBridge, ipcRenderer } = require('electron');
const subscribe=(channel,fn)=>{
  if(typeof fn!=='function')throw new TypeError('Expected a listener');
  const listener=(_event,value)=>fn(value);ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
};
contextBridge.exposeInMainWorld('pet',Object.freeze({
  init:()=>ipcRenderer.invoke('pet:init'),pair:(host,code)=>ipcRenderer.invoke('pet:pair',{host,code}),
  send:text=>ipcRenderer.invoke('pet:send',text),retry:id=>ipcRenderer.invoke('pet:retry',id),drop:id=>ipcRenderer.invoke('pet:drop',id),
  reconnect:()=>ipcRenderer.invoke('pet:reconnect'),unpair:()=>ipcRenderer.invoke('pet:unpair'),
  hide:()=>ipcRenderer.invoke('pet:hide'),quit:()=>ipcRenderer.invoke('pet:quit'),
  setExpanded:value=>ipcRenderer.invoke('pet:expanded',value),regions:value=>ipcRenderer.invoke('pet:regions',value),
  drag:phase=>ipcRenderer.invoke('pet:drag',phase),setPack:id=>ipcRenderer.invoke('pet:pack',id),
  onStatus:fn=>subscribe('status',fn),onMood:fn=>subscribe('mood',fn),onMessages:fn=>subscribe('messages',fn),
  onNotice:fn=>subscribe('notice',fn),onLayout:fn=>subscribe('layout',fn),onExpanded:fn=>subscribe('expanded',fn)
}));
