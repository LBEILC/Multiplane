import { t, setLanguage, number, formatDuration } from '../shared/i18n.mjs';
import { projectPath } from '../shared/job-detail.mjs';
import { roll, hydrateRolls, setRoll, motionOn } from './jobMotion';
import { esc } from './jobDetail';
import type { Snapshot } from '../shared/types';

declare global { interface Window { trayBridge: {
  snapshot(): Promise<Snapshot>;
  subscribe(fn: (value: Snapshot) => void): () => void;
  visibility(fn: (value: { visible: boolean; edge?: string }) => void): void;
  height(value: number): void;
  action(action: string, id?: string): void;
} } }
const api = window.trayBridge;
const host = document.querySelector<HTMLElement>('#content')!;
const brand = document.querySelector('#brand')!.innerHTML;
const base = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const duration = (value: number | null) => value == null ? '—' : formatDuration(value);
const percent = (j: Snapshot['jobs'][number]) => j.total ? Math.min(100, Math.max(0, Math.round(j.done / j.total * 100))) : 0;
let signature = '';
function accept(value: Snapshot) {
  setLanguage(value.language ?? 'en');
  document.documentElement.lang = value.language ?? 'en';
  document.documentElement.dataset.theme = value.theme;
  const running = value.jobs.filter(j => j.state === 'running');
  const queued = value.jobs.filter(j => j.state === 'queued');
  const recent = value.jobs.filter(j => !['running', 'queued'].includes(j.state)).slice(0, 3);
  const key = JSON.stringify([value.language, value.hosted, running.map(j => [j.jobId,j.shot,j.total]), queued, recent]);
  if (signature !== key) {
    signature = key;
    const now = running.map(j => `<button class="tr-job" data-job="${esc(j.jobId)}"><div class="tr-l1"><b>${esc(base(j.shot))}</b><span>${roll('p-'+j.jobId,percent(j))}%</span></div><div class="tr-bar"><i style="width:${percent(j)}%"></i></div><div class="tr-l2">${t('trProgress',{done:roll('d-'+j.jobId,j.done),total:number(j.total),left:roll('l-'+j.jobId,duration(j.etaMs))})}</div></button>`).join('') || `<div class="tr-idle">${t('trIdle')}</div>`;
    const queue = queued.length ? `<section class="tr-sec"><div class="tr-h">${t('trQueue',{n:queued.length})}</div>${queued.slice(0,3).map((j,i)=>`<button class="tr-row" data-job="${esc(j.jobId)}"><span class="pos" title="${t('trPos',{n:j.queuePosition??i+1})}">${j.queuePosition??i+1}</span><span class="nm">${esc(base(j.shot))}</span><span class="pj">${esc(base(projectPath(j)))}</span></button>`).join('')}${queued.length>3?`<div class="tr-more">${t('trMore',{n:queued.length-3})}</div>`:''}</section>` : '';
    const done = recent.length ? `<section class="tr-sec"><div class="tr-h">${t('trRecent')}</div>${recent.map(j=>`<button class="tr-row" data-job="${esc(j.jobId)}"><span class="st ${j.lost?'failed':j.state}"><span class="dot"></span></span><span class="nm">${esc(base(j.shot))}</span><span class="pj">${['render','stills','verify'].includes(j.command)?t(j.command):esc(j.command)} · ${duration(j.result?.elapsedMs??null)}</span></button>`).join('')}</section>` : '';
    host.innerHTML = `<div class="tr-head">${brand}<b>Multiplane</b><span class="tr-host ${value.hosted?'on':''}" title="${t('hostingL')}"><i class="${value.hosted?'ri-shield-check-line':'ri-shield-line'}"></i>${t(value.hosted?'hostedOn':'hostedOff')}</span></div><div class="tr-scroll"><section class="tr-sec"><div class="tr-h">${t('trNow')}</div>${now}</section>${queue}${done}</div><div class="tr-foot"><button class="tr-open" data-action="open"><i class="ri-window-line"></i>${t('trOpen')}</button><button class="tr-ic" data-action="settings" title="${t('trSettings')}" aria-label="${t('trSettings')}"><i class="ri-settings-3-line"></i></button><button class="tr-ic" data-action="quit" title="${t('trQuit')} · ${t('trQuitHint')}" aria-label="${t('trQuit')}"><i class="ri-shut-down-line"></i></button></div>`;
    hydrateRolls();
  }
  for (const j of running) {
    setRoll('p-'+j.jobId,percent(j)); setRoll('d-'+j.jobId,j.done); setRoll('l-'+j.jobId,duration(j.etaMs));
    const button = Array.from(host.querySelectorAll<HTMLElement>('.tr-job')).find(el=>el.dataset.job===j.jobId);
    const bar = button?.querySelector<HTMLElement>('.tr-bar i'); if(bar)bar.style.width=percent(j)+'%';
  }
  requestAnimationFrame(() => api.height(host.getBoundingClientRect().height));
}
host.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLElement>('button');if(!button)return;
  api.action(button.dataset.action??'open',button.dataset.job);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')api.action('close');});
api.visibility(({visible,edge})=>{
  host.getAnimations().forEach(animation=>animation.cancel());
  const shift = edge==='top'?'0,-6px':edge==='left'?'-6px,0':edge==='right'?'6px,0':'0,6px';
  host.animate(visible ? [{opacity:0,transform:`translate(${shift})`},{opacity:1,transform:'translate(0,0)'}] : [{opacity:1},{opacity:0}],{duration:motionOn()?(visible?160:120):0,fill:'forwards',easing:'ease-out'});
});
api.subscribe(accept);
void api.snapshot().then(accept);
