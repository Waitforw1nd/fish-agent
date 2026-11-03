// Test-only Electron entry. Uses the real main/preload/renderer with temporary
// userData. It never substitutes plaintext storage or disables app guards.
const {app,BrowserWindow,safeStorage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const output=process.env.FISH_PET_SMOKE_OUTPUT;
if(!output||!process.env.FISH_PET_DATA_DIR)throw new Error('Smoke requires isolated paths');
if(process.env.FISH_PET_SMOKE_COMPAT==='1'){
  // Explicit test-only fallback for restricted CI Windows desktops.
  app.commandLine.appendSwitch('no-sandbox');app.commandLine.appendSwitch('disable-gpu');
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={checks:[],consoleErrors:[],compat:process.env.FISH_PET_SMOKE_COMPAT==='1'};
let currentWindow;
app.on('browser-window-created',(_event,win)=>{currentWindow=win;win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)report.consoleErrors.push(message);});});
async function run(){
  try{
    await import(pathToFileURL(path.resolve(__dirname,'../../src/main.js')).href);
    const until=Date.now()+20000;
    let ready=false;
    while(Date.now()<until){if(currentWindow&&!currentWindow.isDestroyed()){try{ready=await currentWindow.webContents.executeJavaScript('document.body.dataset.ready === "true"');}catch{}}if(ready)break;await delay(100);}
    if(!ready)throw new Error('Renderer did not become ready');
    const win=currentWindow;
    const init=await win.webContents.executeJavaScript('window.pet.init().then(x=>({paired:x.paired,storageAvailable:x.storageAvailable,packId:x.pack.id,assets:Object.keys(x.pack.assets),credentialsExposed:Object.keys(x).some(k=>!["paired","hasStoredData","status","messages","pack","expanded","notice","storageAvailable"].includes(k))}))');
    if(init.credentialsExposed||!init.packId)throw new Error('Unsafe or missing init payload');
    report.init=init;report.checks.push('main/preload/renderer loaded','validated original resource displayed','credentials not exposed to renderer');
    report.window={visible:win.isVisible(),bounds:win.getBounds(),alwaysOnTop:win.isAlwaysOnTop(),preferences:win.webContents.getLastWebPreferences()};
    const prefs=report.window.preferences;
    if(prefs.contextIsolation!==true||prefs.nodeIntegration!==false||prefs.sandbox!==true)throw new Error('Unsafe renderer preferences');
    const isolation=await win.webContents.executeJavaScript('({require:typeof require,process:typeof process,invoke:typeof window.pet.invoke})');
    if(Object.values(isolation).some(value=>value!=='undefined'))throw new Error('Renderer exposes Node or unrestricted IPC');
    report.checks.push('isolated renderer and fixed preload API (compat does not prove process sandbox)');
    const picture=await win.capturePage();fs.writeFileSync(path.join(output,'expanded.png'),picture.toPNG());
    await win.webContents.executeJavaScript('document.querySelector("#toggle").click()');await delay(250);
    const compact=await win.webContents.executeJavaScript('document.body.classList.contains("compact")');
    report.compact={compact,bounds:win.getBounds(),contentBounds:win.getContentBounds(),notice:await win.webContents.executeJavaScript('document.querySelector("#notice").textContent')};
    if(!compact||win.getContentBounds().height>284)throw new Error('Collapse did not resize');
    fs.writeFileSync(path.join(output,'compact.png'),(await win.capturePage()).toPNG());report.checks.push('collapse and native resize');
    await win.webContents.executeJavaScript('document.querySelector("#toggle").click()');await delay(200);
    await win.webContents.executeJavaScript('document.querySelector("#pack").value="fish.placeholder-alt";document.querySelector("#pack").dispatchEvent(new Event("change"))');await delay(250);
    const alt=await win.webContents.executeJavaScript('document.querySelector("#fish img").alt');if(!alt.includes('橙'))throw new Error('Pack switching failed');report.checks.push('runtime resource pack replacement');
    await win.webContents.executeJavaScript('document.querySelector("#host").focus()');await delay(100);
    if(!await win.webContents.executeJavaScript('document.activeElement.id === "host"'))throw new Error('Text input focus failed');
    report.checks.push('text input focus');
    report.storageAvailable=safeStorage.isEncryptionAvailable();
    // Layout-only fixture: this is deliberately NOT an encrypted-pairing test.
    await win.webContents.executeJavaScript('document.querySelector("#pair").hidden=true;document.querySelector("#chat").hidden=false');
    win.webContents.send('status','connected');win.webContents.send('messages',[
      {role:'user',id:'ui-fixture',sendState:'accepted',segments:[{type:'text',data:{text:'你好，小鱼！'}}]},
      {role:'assistant',messageId:'ui-reply',segments:[{type:'text',data:{text:'你好呀。<img src=x onerror="window.smokeInjected=true">'}}]},
      {role:'user',id:'ui-uncertain',sendState:'uncertain',segments:[{type:'text',data:{text:'一条结果还未确认的消息'}}]}
    ]);await delay(150);
    const chat=await win.webContents.executeJavaScript('({rows:document.querySelectorAll("#messages .message").length,buttons:document.querySelectorAll("#messages button").length,literal:document.querySelector("#messages").textContent.includes("<img src=x"),images:document.querySelectorAll("#messages img").length,injected:window.smokeInjected===true})');
    if(chat.rows!==3||chat.buttons!==2||!chat.literal||chat.images!==0||chat.injected)throw new Error('Unsafe or incomplete chat rendering');
    fs.writeFileSync(path.join(output,'chat-layout-fixture.png'),(await win.capturePage()).toPNG());
    report.checks.push('literal hostile text and uncertain controls (synthetic fixture only)');
    report.result='PASS';
  }catch(error){report.result='FAIL';report.error=error.stack||String(error);process.exitCode=1;}
  finally{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log('SMOKE '+report.result+' '+path.join(output,'report.json'));
    // before-quit handlers stop timers/socket and destroy tray; no process left.
    app.quit();
  }
}
run();
