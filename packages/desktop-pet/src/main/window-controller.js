import pointer from '../vendor/dsh-pet/pointer-target.cjs';
import geometry from '../vendor/dsh-pet/desktop-geometry.cjs';

// Window options and the polling fallback are adapted from dsh-pet's
// main/windows.js (MIT, commit recorded in THIRD_PARTY_NOTICES.md).
// No original assets, host bridge, disabled sandbox, or watchdog is carried over.
export function petWindowOptions(preload, area, icon) {
  return { ...geometry.clampToWorkArea({x:area.x+area.width-400,y:area.y+area.height-660,width:380,height:640},area),
    show:false, useContentSize:true, transparent:true, frame:false, alwaysOnTop:true,
    skipTaskbar:true, resizable:false, hasShadow:false, focusable:true, icon,
    backgroundColor:'#00000000',
    webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false} };
}
export function validateRegions(value, bounds) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rects) || value.rects.length > 32) throw new Error('交互区域无效');
  const rect = r => {
    if (!r || !['x','y','width','height'].every(k=>Number.isFinite(r[k])) || r.width<0 || r.height<0 ||
      r.x < -1 || r.y < -1 || r.x+r.width>bounds.width+1 || r.y+r.height>bounds.height+1) throw new Error('交互区域越界');
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  };
  return {rects:value.rects.map(rect),body:value.body?rect(value.body):null,focused:value.focused===true};
}
export function createWindowController({window,screen,now=Date.now,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval,onMove=()=>{}}) {
  let input={rects:[],body:null,focused:false}, dragging=null, ignoring=false, offSince=null, disposed=false, expanded=true;
  const areaFor=()=>screen.getDisplayMatching(window.getBounds()).workArea;
  function ignore(value) { if(value===ignoring || window.isDestroyed()) return; ignoring=value; window.setIgnoreMouseEvents(value,{forward:true}); }
  function recover() {
    if(window.isDestroyed())return;
    const displays=screen.getAllDisplays();
    if(!displays.length)return;
    const desk=geometry.buildDeskGeometry(displays,screen.getPrimaryDisplay().id);
    const current=window.getBounds();
    const intersects=desk.areas.some(a=>current.x<a.x+a.width&&current.x+current.width>a.x&&current.y<a.y+a.height&&current.y+current.height>a.y);
    const area=intersects?areaFor():desk.areas[desk.primaryIndex];
    window.setBounds(geometry.clampToWorkArea(current,area)); input={rects:[],body:null,focused:false}; ignore(false);
    window.webContents.send('layout');
  }
  function endDrag() { if(!dragging)return; dragging=null; recover();onMove(window.getBounds()); }
  function poll() {
    if(disposed||window.isDestroyed()||!window.isVisible())return;
    const point=screen.getCursorScreenPoint();
    if(dragging) {
      if(now()-dragging.at>15000){endDrag();return;}
      const next={...window.getBounds(),x:dragging.bounds.x+point.x-dragging.point.x,y:dragging.bounds.y+point.y-dragging.point.y};
      window.setPosition(Math.round(next.x),Math.round(next.y)); ignore(false); return;
    }
    const bounds=window.getBounds(),zone=pointer.pointerZone(bounds,point,input.body);
    if(zone==='margin'){if(offSince===null)offSince=now();}else offSince=null;
    ignore(pointer.decideWindowIgnore(bounds,point,ignoring,input.focused,offSince===null?0:now()-offSince,input));
  }
  const timer=setIntervalImpl(poll,pointer.POINTER_POLL_MS);timer?.unref?.();
  const blur=()=>{input.focused=false;endDrag();};
  const moved=()=>onMove(window.getBounds());
  window.on('blur',blur);window.on('moved',moved);
  for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,recover);
  return {
    updateRegions(value){input=validateRegions(value,window.getBounds());if(input.focused)ignore(false);},
    beginDrag(){if(window.isDestroyed()||!window.isVisible())return;dragging={point:screen.getCursorScreenPoint(),bounds:window.getBounds(),at:now()};ignore(false);},
    endDrag,
    setExpanded(value){
      if(typeof value!=='boolean')throw new Error('窗口状态无效');expanded=value;
      const old=window.getBounds(),width=value?380:280,height=value?640:280;
      window.setBounds(geometry.clampToWorkArea({x:old.x+old.width-width,y:old.y+old.height-height,width,height},areaFor()));
      input={rects:[],body:null,focused:false};ignore(false);window.webContents.send('expanded',expanded);
      if(expanded)window.focus();
      return expanded;
    },
    show(){recover();window.show();ignore(false);},
    recover,
    dispose(){if(disposed)return;disposed=true;clearIntervalImpl(timer);window.off('blur',blur);window.off('moved',moved);for(const event of ['display-added','display-removed','display-metrics-changed'])screen.off(event,recover);},
    get expanded(){return expanded;}
  };
}
