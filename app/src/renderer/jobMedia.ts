import { t, number } from '../shared/i18n.mjs';
import type { Job } from '../shared/types';
import { esc, tc, base } from './jobDetail';
type Item = { path: string; title: string; meta?: string; bbox?: {x:number;y:number;w:number;h:number}; canvas?: HTMLCanvasElement };
const api = window.multiplane;
export const mediaURL = (j: Job, file: string, version = '') => api.media(j.jobId,file,version);
const button = (action:string, icon:string, label:string) => `<button data-pl="${action}" title="${t(label)}" aria-label="${t(label)}"><i class="${icon}"></i></button>`;
export function playerHTML(j:Job, path:string) {
  return `<div class="player" tabindex="0"><div class="stage ${j.result?.data?.alpha?'checker':''}"><video class="preview" preload="auto" src="${esc(mediaURL(j,path))}"></video>${button('expand','ri-fullscreen-line','expand')}</div><div class="scrub"><input type="range" data-scrub min="0" max="${Math.max(0,(j.result?.data?.frames??1)-1)}" value="0" step="1" aria-label="${t('frameOf',{f:''})}"><div class="cut-marks"></div></div><div class="pctl">${button('start','ri-skip-back-line','toStart')}${button('prev','ri-arrow-left-s-line','prevFrame')}${button('toggle','ri-play-fill','play')}${button('next','ri-arrow-right-s-line','nextFrame')}${button('end','ri-skip-forward-line','toEnd')}<span class="tcode mono"></span><span class="fnum mono"></span><span class="sp"></span>${button('loop','ri-repeat-line','loop')}${button('external','ri-external-link-line','openExternal')}</div><div class="keys">${t('keys')}</div></div>`;
}
let disposePlayer: (()=>void)|undefined;
export function mountPlayer(j:Job) {
  disposePlayer?.(); disposePlayer=undefined;
  const host=document.querySelector<HTMLElement>('.player'), video=host?.querySelector('video'); if(!host||!video) return;
  const fps=Number(j.result?.data?.fps), frames=Number(j.result?.data?.frames);
  if(!(fps>0&&frames>0)) return;
  const range=host.querySelector<HTMLInputElement>('[data-scrub]')!, from=Number(j.result?.data?.from??0);
  const cuts=(j.events.find(e=>e.type==='shot')?.cuts??[]).map((s:number)=>Math.round((s-from)*fps)).filter((f:number)=>f>=0&&f<frames);
  host.querySelector('.cut-marks')!.innerHTML=cuts.map((f:number)=>`<i style="left:${f/Math.max(1,frames-1)*100}%" title="${t('cutAt',{tc:tc(f/fps)})}"></i>`).join('');
  let frame=Math.min(frames-1,Math.max(0,Math.floor(video.currentTime*fps))), callback=0, alive=true;
  const paint=()=>{range.value=String(frame);host.querySelector('.tcode')!.textContent=`${tc(frame/fps)} / ${tc(frames/fps)}`;host.querySelector('.fnum')!.textContent=t('frameOf',{f:number(frame)});const b=host.querySelector<HTMLButtonElement>('[data-pl=toggle]')!;b.innerHTML=`<i class="ri-${video.paused?'play':'pause'}-fill"></i>`;b.title=t(video.paused?'play':'pause');b.setAttribute('aria-label',b.title);};
  // Seek inside the frame interval, avoiding timestamp rounding at frame boundaries.
  const seek=(f:number)=>{video.pause();frame=Math.max(0,Math.min(frames-1,Math.round(f)));video.currentTime=(frame+.5)/fps;paint();};
  const presented=(_now:number, metadata:VideoFrameCallbackMetadata)=>{if(!alive)return;if(!video.paused){frame=Math.min(frames-1,Math.max(0,Math.round(metadata.mediaTime*fps)));paint();}callback=video.requestVideoFrameCallback(presented);};
  callback=video.requestVideoFrameCallback(presented);
  const action=(a:string)=>{
    if(a==='toggle'){if(video.paused){if(frame>=frames-1)seek(0);void video.play().then(paint);}else{video.pause();paint();}}
    else if(a==='prev'||a==='next')seek(frame+(a==='next'?1:-1));
    else if(a==='back1'||a==='fwd1')seek(frame+(a==='fwd1'?fps:-fps));
    else if(a==='start'||a==='end')seek(a==='start'?0:frames-1);
    else if(a==='cutPrev'||a==='cutNext')seek(a==='cutNext'?(cuts.find((f:number)=>f>frame)??frames-1):([...cuts].reverse().find((f:number)=>f<frame)??0));
    else if(a==='loop'){video.loop=!video.loop;host.querySelector('[data-pl=loop]')!.setAttribute('aria-pressed',String(video.loop));}
    else if(a==='external')void api.open(j.jobId,j.result?.artifacts?.find((a:any)=>a.kind==='video')?.path);
    else if(a==='expand'){video.pause();paint();const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d')!.drawImage(video,0,0);openViewer(j,[{path:j.result?.data?.output??'',title:base(j.shot),meta:`${t('frameOf',{f:frame})} · ${tc(frame/fps)}`,canvas}],0);}
  };
  host.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('[data-pl]');if(b)action(b.dataset.pl!);else if(e.target===video)action('toggle');};
  range.oninput=()=>seek(Number(range.value));
  range.onpointermove=e=>{const r=range.getBoundingClientRect(),f=Math.round(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*(frames-1));range.title=`${tc(f/fps)} · ${t('frameOf',{f})}`;};
  const keys=(e:KeyboardEvent)=>{if(document.querySelector('.lb')||/INPUT|TEXTAREA/.test((e.target as HTMLElement).tagName))return;const a:Record<string,string>={' ':'toggle',ArrowLeft:e.shiftKey?'back1':'prev',ArrowRight:e.shiftKey?'fwd1':'next',Home:'start',End:'end','[':'cutPrev',']':'cutNext'};if(a[e.key]){e.preventDefault();action(a[e.key]);}};
  document.addEventListener('keydown',keys);video.onended=()=>{frame=frames-1;paint();};if(video.readyState<2)video.addEventListener('loadeddata',()=>seek(0),{once:true});paint();
  disposePlayer=()=>{alive=false;video.pause();video.cancelVideoFrameCallback(callback);document.removeEventListener('keydown',keys);};
}
export function mountImages(j:Job) {
  document.querySelectorAll<HTMLImageElement>('#tab-content img').forEach(img=>{img.tabIndex=0;const open=()=>{const all=Array.from((img.closest('.triptych')??document.querySelector('#tab-content')!).querySelectorAll<HTMLImageElement>('img'));const items=all.map(i=>({path:i.dataset.file!,title:i.alt,meta:i.dataset.meta??(j.command==='verify'?(()=>{const finding=j.events.find(e=>e.type==='finding'&&Object.values(e.details?.images??{}).includes(i.dataset.file));return finding?.location?`${tc(finding.location.t)} · ${t('frameOf',{f:finding.location.frame})}`:undefined;})():undefined)??(j.command==='render'&&j.previewFrame!=null?`${tc(j.previewFrame/(j.events.find(e=>e.type==='shot')?.fps??30))} · ${t('frameOf',{f:j.previewFrame})}`:j.result?.data?.stills?.find((s:any)=>s.path===i.dataset.file)?(()=>{const s=j.result!.data.stills.find((s:any)=>s.path===i.dataset.file);return `${tc(s.t)} · ${t('frameOf',{f:s.frame})}`;})():undefined),bbox:i.dataset.bbox?JSON.parse(i.dataset.bbox):undefined}));openViewer(j,items,all.indexOf(img),!!img.closest('.triptych'));};img.onclick=open;img.onkeydown=e=>{if(e.key==='Enter')open();};});
}
export function openViewer(j:Job,items:Item[],index=0,finding=false) {
  document.querySelector('.lb')?.remove();
  const previous=document.activeElement as HTMLElement;
  const layer=document.createElement('div');layer.className='lb opening';layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');layer.tabIndex=-1;
  let scale=1,x=0,y=0,fit=true,box=true,timer:ReturnType<typeof setInterval>|undefined,drag:{x:number;y:number;sx:number;sy:number}|null=null;
  layer.innerHTML=`<div class="lb-top"><div class="lb-title"><b></b><span></span></div><div class="lb-tools">${finding?`<div class="lb-seg">${items.map((it,i)=>`<button data-index="${i}">${esc(it.title)} <kbd>${i+1}</kbd></button>`).join('')}</div><button data-v="flicker" aria-pressed="false">${t('flicker')}</button><button data-v="box" aria-pressed="true">${t('box')}</button>`:''}<button data-v="out">−</button><span class="lb-zoom"></span><button data-v="in">+</button><button data-v="fit">${t('fit')}</button><button data-v="one">1:1</button><button data-v="reveal" title="${t('reveal2')}"><i class="ri-folder-open-line"></i></button><button data-v="close" aria-label="${t('close')}"><i class="ri-close-line"></i></button></div></div><div class="lb-stage"><div class="lb-img checker"></div>${items.length>1&&!finding?`<button class="lb-nav l" data-v="prev" aria-label="${t('prev')}">‹</button><button class="lb-nav r" data-v="next" aria-label="${t('next')}">›</button>`:''}</div>${items.length>1&&!finding?`<div class="lb-strip">${items.map((it,i)=>`<button data-index="${i}"><img src="${esc(mediaURL(j,it.path))}" alt="${esc(it.title)}"></button>`).join('')}</div>`:''}`;
  document.body.append(layer);layer.focus();
  const stage=layer.querySelector<HTMLElement>('.lb-stage')!, image=layer.querySelector<HTMLElement>('.lb-img')!;
  let w=1,h=1;
  const layout=()=>{if(fit){scale=Math.min((stage.clientWidth-48)/w,(stage.clientHeight-48)/h);x=(stage.clientWidth-w*scale)/2;y=(stage.clientHeight-h*scale)/2;}image.style.width=w+'px';image.style.height=h+'px';image.style.transform=`translate(${x}px,${y}px) scale(${scale})`;layer.querySelector('.lb-zoom')!.textContent=Math.round(scale*100)+'%';stage.classList.toggle('grab',!fit);};
  const syncTools=()=>{for(const [key,on] of [['box',box],['flicker',!!timer]] as const){const button=layer.querySelector(`[data-v=${key}]`);button?.setAttribute('aria-pressed',String(on));button?.classList.toggle('on',on);}};
  const paint=()=>{syncTools();const it=items[index];layer.setAttribute('aria-label',it.title);layer.querySelector('.lb-title b')!.textContent=it.title;image.replaceChildren();const loaded=()=>{layer.querySelector('.lb-title span')!.textContent=`${it.meta??''} · ${w} × ${h}`;if(finding&&box&&it.bbox){const b=it.bbox,s=document.createElement('span');s.className='bbox';Object.assign(s.style,{left:b.x+'px',top:b.y+'px',width:b.w+'px',height:b.h+'px'});image.append(s);}layout();};if(it.canvas){image.append(it.canvas);w=it.canvas.width;h=it.canvas.height;loaded();}else{const img=new Image();img.src=mediaURL(j,it.path,j.previewVersion);img.alt=it.title;image.append(img);img.onload=()=>{if(!layer.isConnected||img.parentElement!==image)return;w=img.naturalWidth;h=img.naturalHeight;loaded();};}layer.querySelectorAll<HTMLElement>('[data-index]').forEach(b=>{b.setAttribute('aria-pressed',String(Number(b.dataset.index)===index));b.setAttribute('aria-current',String(Number(b.dataset.index)===index));});};
  const close=()=>{clearInterval(timer);observer.disconnect();document.removeEventListener('keydown',keys);layer.remove();previous?.focus();};
  const zoom=(s:number,cx=stage.clientWidth/2,cy=stage.clientHeight/2)=>{s=Math.max(.05,Math.min(16,s));x=cx-(cx-x)*s/scale;y=cy-(cy-y)*s/scale;scale=s;fit=false;layout();};
  const move=(i:number)=>{index=(i+items.length)%items.length;paint();};
  layer.onclick=e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('button');if(!b)return;if(b.dataset.index!=null){clearInterval(timer);timer=undefined;move(Number(b.dataset.index));}const a=b.dataset.v;if(a==='close')close();if(a==='fit'){fit=true;layout();}if(a==='one')zoom(1);if(a==='in'||a==='out')zoom(scale*(a==='in'?1.25:.8));if(a==='prev'||a==='next')move(index+(a==='next'?1:-1));if(a==='box'){box=!box;paint();}if(a==='reveal')void api.open(j.jobId,items[index].path,true);if(a==='flicker'){if(timer){clearInterval(timer);timer=undefined;}else timer=setInterval(()=>move(index===0?1:0),450);syncTools();}};
  stage.onwheel=e=>{e.preventDefault();const r=stage.getBoundingClientRect();zoom(scale*(e.deltaY<0?1.15:1/1.15),e.clientX-r.left,e.clientY-r.top);};
  stage.ondblclick=()=>{if(fit)zoom(1);else{fit=true;layout();}};
  stage.onpointerdown=e=>{if(!fit&&!(e.target as HTMLElement).closest('button')){drag={x,y,sx:e.clientX,sy:e.clientY};stage.setPointerCapture(e.pointerId);}};
  stage.onpointermove=e=>{if(drag){x=drag.x+e.clientX-drag.sx;y=drag.y+e.clientY-drag.sy;layout();}};stage.onpointerup=()=>{drag=null;};
  const keys=(e:KeyboardEvent)=>{if(e.key==='Escape')close();else if(e.key==='ArrowRight')move(index+1);else if(e.key==='ArrowLeft')move(index-1);else if(finding&&['1','2','3'].includes(e.key))move(Number(e.key)-1);else if(e.key==='0'){fit=true;layout();}else if(e.key==='Tab'){const buttons=Array.from(layer.querySelectorAll<HTMLButtonElement>('button'));const at=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(at+(e.shiftKey?-1:1)+buttons.length)%buttons.length].focus();}else return;e.preventDefault();e.stopImmediatePropagation();};
  document.addEventListener('keydown',keys);const observer=new ResizeObserver(layout);observer.observe(stage);paint();
}
