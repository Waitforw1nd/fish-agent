// Local-module PetView loads only after the main process validates its pack.
const $=id=>document.getElementById(id);
let petView,paired=false,expanded=true,currentStatus='unpaired',activity='idle',resourcePack,dragStart=null,dragging=false,regionFrame=0,hasStoredData=false,sending=false;
const revision={status:0,messages:0,notice:0,expanded:0,pair:0};
const unsubscribe=[];
function error(value){$('notice').textContent=String(value?.message||value).replace(/^Error invoking remote method '[^']+': Error: /,'').slice(0,600);}
function imageElement(raw){
  const match=/^(?:base64:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)([A-Za-z0-9+/]+={0,2})$/.exec(String(raw||''));
  if(!match||match[1].length>2796204)return null;
  let mime='';try{const b=atob(match[1].slice(0,24));if(b.startsWith('\x89PNG\r\n\x1a\n'))mime='png';else if(b.startsWith('\xff\xd8\xff'))mime='jpeg';else if(b.startsWith('GIF87a')||b.startsWith('GIF89a'))mime='gif';else if(b.startsWith('RIFF')&&b.slice(8,12)==='WEBP')mime='webp';}catch{return null;}
  if(!mime)return null;const img=document.createElement('img');img.src='data:image/'+mime+';base64,'+match[1];img.alt='对话图片';return img;
}
function display(items){
  const box=$('messages'),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<60;box.replaceChildren();
  for(const item of (Array.isArray(items)?items:[]).slice(-200)){
    const row=document.createElement('div'),state=item.sendState||(item.failed?'failed':item.pending?'awaiting_ack':'accepted');
    row.className=`message ${item.role==='assistant'?'assistant':'user'} ${state}`;
    for(const segment of Array.isArray(item.segments)?item.segments:[]){
      const part=document.createElement('span');
      if(segment.type==='text')part.textContent=String(segment.data?.text||'');
      else if(segment.type==='face')part.textContent=`[表情 ${String(segment.data?.id||'')}]`;
      else if(segment.type==='reply')part.textContent='[引用回复] ';
      else if(segment.type==='image'){const img=imageElement(segment.data?.file);if(img)part.append(img);else part.textContent='[图片无法显示]';}
      else continue;row.append(part);
    }
    if(item.role!=='assistant'){
      const status=document.createElement('small');status.textContent=({queued:'待发送',awaiting_ack:'等待确认',accepted:'已受理',failed:'发送失败',uncertain:'结果未确认 · 重试可能重复',discarded:'已放弃发送'})[state]||'';row.append(status);
      if(['failed','uncertain'].includes(state)&&item.id){
        for(const [label,action] of [['重试（可能重复）','retry'],['放弃','drop']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>Promise.resolve(window.pet[action](item.id)).catch(error);row.append(button);}
      }
    }
    box.append(row);
  }
  if(!box.childNodes.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='连接好了，和小鱼打个招呼吧。';box.append(empty);}
  if(atBottom)box.scrollTop=box.scrollHeight;
  const latest=[...(Array.isArray(items)?items:[])].reverse().find(item=>item.role==='assistant');
  const text=(latest?.segments||[]).filter(s=>s.type==='text').map(s=>s.data.text).join(' ');
  $('bubble').hidden=!text;$('bubble').textContent=text.slice(0,140);scheduleRegions();
}
function setExpanded(value){expanded=value;document.body.classList.toggle('compact',!value);$('toggle').textContent=value?'收起':'展开';$('toggle').setAttribute('aria-expanded',String(value));scheduleRegions();}
function showPair(value){paired=value;$('pair').hidden=value;$('chat').hidden=!value;$('unpair').hidden=!value&&!hasStoredData;scheduleRegions();}
function setStatus(status){
  currentStatus=status;document.body.dataset.status=status;petView?.setConnection(status);
  $('status').textContent=({unpaired:'等待配对',connecting:'正在连接…',connected:'已连接',disconnected:'连接断开，正在重试',revoked:'设备权限已失效',auth_blocked:'入口或权限不可用',recovery_error:'会话恢复异常'})[status]||status;
  $('reconnect').hidden=!paired||!['disconnected','auth_blocked','recovery_error'].includes(status);
  $('text').disabled=['revoked','auth_blocked','recovery_error','unpaired'].includes(status);
  if(status!=='connected')setActivity('idle');
  if(status==='revoked')error('设备权限已失效，请在面板检查或重新生成配对码。');
  if(status==='auth_blocked')error('桌宠入口、租户或用户权限已关闭；处理后可手动重新连接。');
  if(status==='recovery_error')error('会话恢复异常，自动补发已暂停；检查网络和云端后手动重连。');
  scheduleRegions();
}
function setActivity(mood){activity=currentStatus==='connected'?mood:'idle';petView?.setActivity(activity);$('activity').textContent=({idle:'陪你聊一会儿',thinking:'正在思考…',talking:'收到回复啦',sleeping:'休息一下'})[activity]||'陪你聊一会儿';}
function scheduleRegions(){
  if(!window.pet.regions||regionFrame)return;
  const raf=window.requestAnimationFrame||((fn)=>setTimeout(fn,0));regionFrame=raf(()=>{regionFrame=0;reportRegions();});
}
function reportRegions(){
  const clipped=element=>{const r=element.getBoundingClientRect(),x=Math.max(0,r.left),y=Math.max(0,r.top);return {x,y,width:Math.max(0,Math.min(innerWidth,r.right)-x),height:Math.max(0,Math.min(innerHeight,r.bottom)-y)};};
  const rects=[...document.querySelectorAll('[data-interactive]')].filter(e=>e.getClientRects().length).map(clipped).filter(r=>r.width&&r.height);
  const fish=$('fish'),img=fish.querySelector('img'),r=img?.getBoundingClientRect()||fish.getBoundingClientRect(),hit=resourcePack?.manifest?.hitBox;
  const aspect=resourcePack?.manifest?.canvas?resourcePack.manifest.canvas.width/resourcePack.manifest.canvas.height:1;
  const imageWidth=Math.min(r.width,r.height*aspect),imageHeight=imageWidth/aspect;
  let body=hit?{x:r.x+(r.width-imageWidth)/2+imageWidth*hit.x,y:r.y+(r.height-imageHeight)/2+imageHeight*hit.y,width:imageWidth*hit.width,height:imageHeight*hit.height}:clipped(fish);
  body={x:Math.max(0,body.x),y:Math.max(0,body.y),width:Math.max(0,Math.min(body.width,innerWidth-Math.max(0,body.x))),height:Math.max(0,Math.min(body.height,innerHeight-Math.max(0,body.y)))};
  const focused=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  window.pet.regions({rects,body,focused}).catch(()=>{});
}
$('pairButton').onclick=async()=>{try{$('notice').textContent='';$('pairButton').disabled=true;await window.pet.pair($('host').value.trim(),$('code').value.trim());revision.pair++;$('code').value='';hasStoredData=true;showPair(true);setStatus(currentStatus);}catch(e){error(e);}finally{$('pairButton').disabled=false;}};
$('form').onsubmit=async event=>{
  event.preventDefault();if(sending)return;
  const text=$('text').value,button=$('form').querySelector('button[type="submit"]'),noticeRevision=revision.notice;
  sending=true;button.disabled=true;
  try{await window.pet.send(text);if($('text').value===text)$('text').value='';if(revision.notice===noticeRevision)$('notice').textContent='';}
  catch(e){error(e);}finally{sending=false;button.disabled=false;}
};
$('text').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();$('form').requestSubmit();}};
$('unpair').onclick=async()=>{try{await window.pet.unpair();revision.pair++;hasStoredData=false;display([]);showPair(false);setStatus('unpaired');$('notice').textContent='本机配对已清除。释放云端席位请在面板删除设备。';if(!expanded)setExpanded(await window.pet.setExpanded(true));}catch(e){error(e);}};
$('hide').onclick=()=>window.pet.hide();
$('toggle').onclick=async()=>{try{setExpanded(await window.pet.setExpanded(!expanded));}catch(e){error(e);}};
$('reconnect').onclick=()=>Promise.resolve(window.pet.reconnect()).catch(error);
$('pack').onchange=async()=>{try{resourcePack=await window.pet.setPack($('pack').value);petView?.setPack(resourcePack);scheduleRegions();}catch(e){error(e);}};
$('fish').onpointerdown=event=>{if(event.button!==0)return;dragStart={x:event.screenX,y:event.screenY};dragging=false;$('fish').setPointerCapture?.(event.pointerId);};
$('fish').onpointermove=event=>{if(dragStart&&!dragging&&Math.hypot(event.screenX-dragStart.x,event.screenY-dragStart.y)>5){dragging=true;Promise.resolve(window.pet.drag('start')).catch(error);}};
async function finishPointer(event){if(!dragStart)return;const wasDragging=dragging;dragStart=null;dragging=false;try{if(wasDragging)await window.pet.drag('end');else if(event.type!=='pointercancel')setExpanded(await window.pet.setExpanded(!expanded));}catch(e){error(e);}}
$('fish').onpointerup=finishPointer;$('fish').onpointercancel=finishPointer;
$('fish').onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('toggle').click();}};
for(const [method,fn,key] of [['onStatus',setStatus,'status'],['onMood',setActivity],['onMessages',display,'messages'],['onNotice',error,'notice'],['onExpanded',setExpanded,'expanded'],['onLayout',scheduleRegions]])if(window.pet[method])unsubscribe.push(window.pet[method](value=>{if(key)revision[key]++;fn(value);}));
window.addEventListener('resize',scheduleRegions);window.addEventListener('focus',scheduleRegions);document.addEventListener('focusin',scheduleRegions);document.addEventListener('focusout',scheduleRegions);
window.addEventListener('blur',()=>{if(dragStart){dragStart=null;dragging=false;window.pet.drag?.('end').catch(()=>{});}});
window.addEventListener('beforeunload',()=>{for(const dispose of unsubscribe)if(typeof dispose==='function')dispose();petView?.destroy();});
const initRevision={...revision};
window.pet.init().then(async value=>{
  if(revision.pair===initRevision.pair){hasStoredData=value.hasStoredData===true;showPair(value.paired);}
  if(revision.messages===initRevision.messages)display(value.messages);
  if(revision.expanded===initRevision.expanded)setExpanded(value.expanded!==false);
  if(value.status&&revision.status===initRevision.status)setStatus(value.status);
  if(value.pack){resourcePack=value.pack;const {createPetView}=await import('./ui/pet-view.js');petView=createPetView($('fish'),{pack:resourcePack});petView.setConnection(currentStatus);petView.setActivity(activity);$('pack').value=resourcePack.id;}
  if(value.notice&&revision.notice===initRevision.notice)error(value.notice);
  if(value.storageAvailable===false&&revision.notice===initRevision.notice&&!value.notice)error('系统安全存储暂不可用；无法配对或保存设备凭据，请恢复系统加密服务。');
  scheduleRegions();document.body.dataset.ready='true';
}).catch(error);
