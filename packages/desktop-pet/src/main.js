import { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, powerMonitor, screen } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PetConnection, pairDevice } from './client.js';
import { createCredentialStore } from './main/credential-store.js';
import { loadResourcePack } from './main/resource-pack-loader.js';
import { createWindowController,petWindowOptions } from './main/window-controller.js';
import { trustedHandler, restrictWindow } from './main/security.js';
const require=createRequire(import.meta.url);
let WebSocket;
try{WebSocket=require('ws');}catch(error){if(app.isPackaged||process.env.FISH_DESKTOP_DEV!=='1')throw error;WebSocket=require('../../qq-agent-core/node_modules/ws');}
const dir=path.dirname(fileURLToPath(import.meta.url));
const page=pathToFileURL(path.join(dir,'index.html')).href;
// Explicit development isolation. Never use a plaintext credential fallback.
if(!app.isPackaged&&process.env.FISH_PET_DATA_DIR)app.setPath('userData',path.resolve(process.env.FISH_PET_DATA_DIR));
let window,tray,controller,store,connection,pack,saved={},startupNotice='',pairing=false,quitting=false;
const packRoot=path.join(dir,'..','resources','pets');
const packIds=new Map([['fish.placeholder','placeholder'],['fish.placeholder-alt','placeholder-alt']]);
const publish=(channel,value)=>{if(window&&!window.isDestroyed())window.webContents.send(channel,value);};
function commitSaved(next){store.save(next);saved=next;}
function startConnection(){
  connection?.stop();
  if(!saved.credentials){connection=null;return;}
  const current=connection=new PetConnection({credentials:saved.credentials,WebSocket,state:saved.state,save:state=>commitSaved({...saved,state})});
  current.on('status',status=>{if(current===connection){current.currentStatus=status;publish('status',status);}});
  for(const [event,channel] of [['mood','mood'],['messages','messages'],['notice','notice']])current.on(event,value=>{if(current===connection)publish(channel,value);});
  current.connect();
}
function handle(name,fn){ipcMain.handle(name,trustedHandler(name,fn,{getWindow:()=>window,page}));}
function needConnection(){if(!connection)throw new Error('请先配对设备');return connection;}
function id(value){if(typeof value!=='string'||! /^[\w.-]{1,128}$/.test(value))throw new Error('消息标识无效');return value;}
function show(){controller?.show();}
function quit(){quitting=true;app.quit();}
if(!app.requestSingleInstanceLock()){app.quit();}
else {
  app.on('second-instance',show);
  app.whenReady().then(async()=>{
    store=createCredentialStore({file:path.join(app.getPath('userData'),'device.enc'),storage:safeStorage});
    try{saved=store.load();}catch(error){startupNotice=error.message;}
    const selected=packIds.get(saved.packId)||'placeholder';
    pack=await loadResourcePack(path.join(packRoot,selected),path.join(packRoot,'placeholder'));
    const icon=nativeImage.createFromDataURL(pack.assets.base).resize({width:24,height:24});
    window=new BrowserWindow(petWindowOptions(path.join(dir,'preload.cjs'),screen.getPrimaryDisplay().workArea,icon));
    controller=createWindowController({window,screen});
    restrictWindow(window);
    window.once('ready-to-show',()=>window.showInactive());
    window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
    tray=new Tray(icon);tray.setToolTip('养鱼 Bot · AI 生成');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'显示桌宠',click:show},{label:'退出桌宠',click:quit}]));
    tray.on('double-click',show);
    handle('pet:init',()=>({paired:Boolean(saved.credentials),hasStoredData:store.exists(),status:connection?.currentStatus||'unpaired',messages:connection?.messages||saved.state?.messages||[],pack,expanded:controller.expanded,notice:startupNotice,storageAvailable:store.available()}));
    handle('pet:pair',async input=>{
      if(pairing)throw new Error('正在配对，请稍候');
      if(!store.available())throw new Error('系统安全存储不可用，无法配对设备；不会以明文保存令牌。');
      if(typeof input?.host!=='string'||input.host.length>2048||typeof input?.code!=='string'||input.code.length>32)throw new Error('配对输入无效');
      pairing=true;
      try{
        const credentials=await pairDevice({host:input.host,code:input.code,deviceName:os.hostname().slice(0,80)||'Windows desktop',os:process.platform});
        try{commitSaved({credentials,packId:pack.id,state:{seq:0,pending:[],messages:[]}});}
        catch{throw new Error('云端配对码已使用，但本机无法保存新凭据。请在面板删除刚添加的设备，恢复系统存储后重新生成配对码。');}
        startupNotice='';publish('messages',[]);startConnection();return {paired:true};
      }finally{pairing=false;}
    });
    handle('pet:send',text=>{if(typeof text!=='string')throw new Error('消息格式无效');return needConnection().sendText(text);});
    handle('pet:retry',value=>needConnection().retry(id(value)));
    handle('pet:drop',value=>needConnection().drop(id(value)));
    handle('pet:reconnect',()=>needConnection().reconnect());
    handle('pet:unpair',()=>{if(pairing)throw new Error('请等待配对完成');store.clear();connection?.stop();connection=null;saved={};startupNotice='';publish('status','unpaired');publish('messages',[]);return true;});
    handle('pet:hide',()=>window.hide());handle('pet:quit',quit);
    handle('pet:expanded',value=>controller.setExpanded(value));
    handle('pet:regions',value=>controller.updateRegions(value));
    handle('pet:drag',phase=>{if(phase==='start')controller.beginDrag();else if(phase==='end')controller.endDrag();else throw new Error('拖动状态无效');});
    handle('pet:pack',async value=>{
      if(!packIds.has(value))throw new Error('只能选择内置占位包');
      const next=await loadResourcePack(path.join(packRoot,packIds.get(value)),path.join(packRoot,'placeholder'));
      if(saved.credentials)commitSaved({...saved,packId:next.id});pack=next;return pack;
    });
    powerMonitor.on('resume',()=>{controller.recover();if(connection&&!connection.stopped)connection.reconnect();});
    startConnection();await window.loadFile(path.join(dir,'index.html'));
  }).catch(error=>{console.error('桌宠启动失败：',error.message);app.exit(1);});
}
app.on('before-quit',()=>{quitting=true;controller?.dispose();connection?.stop();tray?.destroy();});
app.on('window-all-closed',()=>{});
