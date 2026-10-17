import { resumeAction, resumeBlock, resumedFromLine, resumable } from './jobResume';
import { summary, timeline, options, tc } from './jobDetail';
import { playerHTML, mountPlayer, mountImages } from './jobMedia';
import { failureCopy, projectPath, commandText, mergedEvents } from '../shared/job-detail.mjs';
import { roll, hydrateRolls, updateRolls, setRoll, motionOn } from './jobMotion';
import { t, language, setLanguage, number, bytes, pixels, runningCount, formatDuration, jobStarted, onLanguageChange } from '../shared/i18n.mjs';
import { userError } from '../shared/errors.mjs';
import type { Job, Snapshot, Event } from '../shared/types';
import { menu } from './menu';
import { installScrollMaterial } from './floatingThumb';
import { SettingsView } from './settings';
import { updateBusyCount } from './updates';
import './skillConfirmation';
import { initPlatform, displayPath, revealLabel } from './platform';
import { jobData } from '../shared/job-data.mjs';
import { Startup } from './startup';
const api = window.multiplane;
const report = (error: unknown) => api.reportFault?.(String((error as Error)?.stack ?? error));
window.addEventListener('error', event => report(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => report(event.reason));
let platformReady = false;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const base = (v: string) => v.split(/[\\/]/).filter(Boolean).at(-1) ?? v;
const project = (j: Job) => projectPath(j);
const labels = (): Record<string, string> => ({ queued: t('queued'), running: t('running'), succeeded: t('completed'), failed: t('failed'), cancelled: t('cancelled'), render: t('render'), stills: t('stills'), verify: t('verify'), launch: t('ph_launch'), load: t('ph_load'), capture: t('ph_capture'), encode: t('ph_encode'), compare: t('ph_compare'), finalize: t('ph_finalize') });
const duration = (ms: number | null) => ms == null ? '—' : formatDuration(ms);
const elapsed = (j: Job) => Number.isFinite(j.result?.elapsedMs) ? j.result!.elapsedMs : Number.isFinite(Date.parse(j.startedAt)) ? Math.max(0, Date.now() - Date.parse(j.startedAt)) : null;
let stateFilter = 'all', projectFilter = '';
let state: Snapshot = { ready: false, jobs: [], runningCount: 0, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' }, selected = '', tab = 'preview', page = 'jobs', contentKey = '', headerKey = '';
const startup = new Startup(() => render());
const fail = (e: unknown) => { report(e); $('#error').textContent = userError(e); $('#error').hidden = false; };
const media = (j: Job, file: string, version = '') => escape(api.media(j.jobId, file, version));
function navigate(next: string) {
  if (!platformReady) { page = next; return; }
  page = next; $('#heading').textContent = t(page); $('#jobs').hidden = page !== 'jobs'; $('#placeholder').hidden = page === 'jobs';
  document.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-current', (el as HTMLElement).dataset.page === page ? 'page' : 'false'));
  $('.page-h').classList.remove('stuck'); preferences.mount(page); render();
}
const preferences = new SettingsView($('#placeholder'), navigate);
$('#hosting-status').addEventListener('click', () => { navigate('settings'); document.getElementById('setting-hosted')?.scrollIntoView({ block: 'nearest' }); document.querySelector<HTMLButtonElement>('[data-pref=hosted]')?.focus(); });
const completing = new Map<string, 'fill'|'fold'>();
const rank = (j: Job) => j.state === 'running' || completing.has(j.jobId) ? 2 : j.state === 'queued' ? 1 : 0;
const jobLabel = (j: Job) => j.stuck ? t('stuck') : j.state === 'queued' && j.queuePosition ? t('queuedPos', { n: j.queuePosition }) : labels()[j.state];
function renderList() {
  if (!platformReady || !startup.ready) return;
  const filter = stateFilter;
  const jobs = state.jobs.filter(j => (!projectFilter || project(j) === projectFilter) && (filter === 'all' || (filter === 'running' ? ['running', 'queued'].includes(j.state) : ['failed', 'cancelled'].includes(j.state))))
    .sort((a, b) => rank(b) - rank(a) || (a.state === 'queued' && b.state === 'queued' ? (a.queuePosition ?? 0) - (b.queuePosition ?? 0) : b.startedAt.localeCompare(a.startedAt)));
  let group = '';
  const html = jobs.map(j => {
    const next = j.state === 'queued' ? t('queued') : j.state === 'running' || completing.has(j.jobId) ? t('running') : Number.isFinite(Date.parse(j.startedAt)) ? new Date(j.startedAt).toLocaleDateString(language()) : '—';
    const heading = next === group ? '' : `<div class="group">${escape(next)}</div>`; group = next;
    return `${heading}<div class="job" role="listitem" tabindex="0" data-job="${escape(j.jobId)}" aria-selected="${j.jobId === selected}"><div class="row-top"><span class="name">${escape(base(j.shot))}</span>${j.hosted ? `<span class="tag hosted">${t('hosted')}</span>` : ''}${j.resumedBy ? `<span class="tag">${t('resumedTag')}</span>` : ''}<span class="status ${j.stuck ? 'stuck' : j.state}"><i class="dot"></i>${jobLabel(j)}</span></div><div class="row-sub"><span>${j.state==='running' ? roll('row-'+j.jobId,j.done)+' / <span data-row-total>'+number(j.total)+'</span>' : (labels()[j.command] ?? escape(j.command))+' · '+escape(base(project(j)))}</span><span>${j.state==='running' ? t('remainingLabel')+' '+roll('left-'+j.jobId,duration(j.etaMs)) : resumable(j) ? resumeAction(j,true) : duration(elapsed(j))}</span></div>${j.state==='running'?`<div class="row-bar"><i style="width:${Math.min(100,j.done/(j.total||1)*100)}%"></i></div>`:''}</div>`;
  }).join('') || `<div class="empty">${t('noJobs')}</div>`;
  const list=$('#list'), template=document.createElement('template');template.innerHTML=html;
  const arriving: HTMLElement[] = [];
  const old=new Map(Array.from(list.querySelectorAll<HTMLElement>('[data-job]')).map(el=>[el.dataset.job!,el]));
  for(const fresh of Array.from(template.content.querySelectorAll<HTMLElement>('[data-job]'))) {
    const previous=old.get(fresh.dataset.job!);
    if(previous){
      const top=previous.querySelector('.row-top')!, next=fresh.querySelector('.row-top')!;
      if(top.innerHTML!==next.innerHTML){top.innerHTML=next.innerHTML;top.querySelector('.dot')?.animate([{transform:'scale(1)'},{transform:'scale(1.9)'},{transform:'scale(1)'}],{duration:motionOn()?480:0});}
      previous.setAttribute('aria-selected',fresh.getAttribute('aria-selected')!);
      const sub=previous.querySelector('.row-sub')!;const newSub=fresh.querySelector('.row-sub')!;
      if(!sub.querySelector('[data-roll]')||!newSub.querySelector('[data-roll]'))sub.innerHTML=newSub.innerHTML;
      else updateRolls(previous,jobs.find(j=>j.jobId===fresh.dataset.job)!);
      const bar=previous.querySelector<HTMLElement>('.row-bar i'),newBar=fresh.querySelector<HTMLElement>('.row-bar i');
      if(bar&&newBar)bar.style.width=newBar.style.width;else{previous.querySelector('.row-bar')?.remove();if(newBar)previous.append(newBar.parentElement!);}
      fresh.replaceWith(previous);
    }else if(list.childElementCount&&motionOn())arriving.push(fresh);
  }
  list.replaceChildren(template.content);
  for(const row of arriving) row.animate([{opacity:0,maxHeight:'0px',background:'var(--info-bg)'},{opacity:1,maxHeight:'90px',background:'transparent'}],{duration:230});
  hydrateRolls();
}
function preview(j: Job) {
  if (j.command === 'render') {
    const video = j.result?.artifacts?.find((a: any) => a.kind === 'video');
    if (j.state === 'succeeded' && video) return playerHTML(j, video.path);
    if (j.previewFrame != null) return `<img class="preview" alt="${t('latestFrame')}" data-file="${escape(j.jobDir + '/preview.png')}" src="${media(j, j.jobDir + '/preview.png', j.previewVersion)}"><p class="caption"><span data-preview-frame>${t('frameOf',{f:roll('preview-'+j.jobId,j.previewFrame)})}</span> · <span data-preview-time>${tc(j.previewFrame / (j.events.find(e=>e.type==='shot')?.fps??30))}</span></p><p class="caption">${t(j.state==='failed'?'lastFrame':'previewLive')}</p>`;
  }
  if (j.command === 'stills') {
    const artifacts = j.result?.artifacts ?? j.events.filter(e => e.type === 'artifact');
    const sheet = artifacts.find((a: any) => a.kind === 'contact-sheet');
    if (!sheet && !artifacts.some((a: any) => a.kind === 'still')) return `<div class="empty">${t('noPreview')}</div>`;
    return `${sheet ? `<img class="preview" alt="${t('contactSheet')}" data-file="${escape(sheet.path)}" src="${media(j, sheet.path)}">` : ''}<div class="stills-grid">${artifacts.filter((a: any) => a.kind === 'still').map((a: any) => `<button aria-label="${t('openFile', { name: escape(base(a.path)) })}"><img alt="${escape(base(a.path))}" data-file="${escape(a.path)}" src="${media(j, a.path)}"></button>`).join('')}</div>`;
  }
  if (j.command === 'verify') {
    const findings = j.events.filter(e => e.type === 'finding' && e.details?.images);
    return findings.map(e => `<section><h3>${escape(e.details.check)} · ${t('frame', { frame: number(e.location?.frame) })}</h3><div class="triptych">${(['reference', 'actual', 'diff'] as const).map((key, i) => `<figure><div class="image-box"><img alt="${[t('reference'), t('actual'), t('difference')][i]}" data-bbox="${escape(JSON.stringify(e.details.bbox))}" data-file="${escape(e.details.images[key])}" src="${media(j, e.details.images[key])}"><span class="bbox" hidden></span></div><figcaption>${[t('reference'), t('actual'), t('difference')][i]}</figcaption></figure>`).join('')}</div><p class="caption selectable">${escape(e.message)}<br>${e.details.bbox ? t('changedRegion', { x: number(e.details.bbox.x), y: number(e.details.bbox.y), width: number(e.details.bbox.w), height: number(e.details.bbox.h) }) : ''} · ${pixels(e.details.changedPixels)}</p></section>`).join('') || `<div class="empty">${t('noPreview')}</div>`;
  }
  return `<div class="empty">${j.command === 'render' && j.state === 'running' ? t('firstFrame') : t('noPreview')}</div>`;
}
function resultBanner(j: Job) {
  if (j.forced) return `<div class="banner cancelled selectable"><div class="bt">${t('forcedFiles', { path: (j.temporaryDirectories ?? [j.jobDir]).map(escape).join('<br>') })}${resumeBlock(j)}</div><span class="b-acts">${resumeAction(j)}</span></div>`;
  if (j.stuck) return `<div class="banner cancelled"><i class="ri-time-line"></i>${t('stuck')}<button data-action="stop">${t('stop')}</button></div>`;
  if (!['failed', 'cancelled'].includes(j.state)) return '';
  const [title, hint] = failureCopy(j);
  const code = j.result?.code ?? (j.lost ? 'internal_error' : '');
  return `<div class="banner job-failure ${j.state} selectable"><i class="ri-error-warning-line"></i><div class="bt"><b>${t(title)}</b><p>${escape(hint ? t(hint) : j.result?.message ?? '')}</p>${code ? `<span class="code"><span class="mono">${escape(code)}</span><button data-copy-value="${escape(code)}">${t('copy')}</button></span>` : ''}${resumeBlock(j)}</div><span class="b-acts">${resumeAction(j)}</span></div>`;
}
function renderProgress(j:Job) {
  const host=$('#job-progress');
  if(completing.has(j.jobId) && host.dataset.progressJob===j.jobId) {
    const bar=host.querySelector<HTMLElement>('.pbar');
    bar?.classList.remove('indeterminate');
    if(bar){bar.classList.add('complete');bar.querySelector<HTMLElement>('i')!.style.width='100%';}
    setRoll('phase-'+j.jobId,t('completed'));setRoll('remaining-'+j.jobId,duration(0));
    return;
  }
  if(!['running','queued'].includes(j.state)) {host.innerHTML='';delete host.dataset.progressJob;return;}
  const values:Record<string,string|number>={phase:labels()[j.phase]??labels().capture,done:j.done,speed:j.fps??0,used:duration(elapsed(j)),remaining:duration(j.etaMs),eta:j.etaMs==null?'—':new Date(Date.now()+j.etaMs).toLocaleTimeString(language(),{hour:'2-digit',minute:'2-digit'})};
  if(j.state==='queued'){host.innerHTML='<div class="progress-card">'+jobLabel(j)+'</div>';delete host.dataset.progressJob;return;}
  if(host.dataset.progressJob!==j.jobId){host.dataset.progressJob=j.jobId;host.innerHTML=`<div class="progress-card"><div class="top"><span>${roll('phase-'+j.jobId,values.phase)}</span><span>${roll('done-'+j.jobId,j.done)} / <span data-total>${number(j.total)}</span> ${t('framesUnit')}</span></div><div class="pbar"><i><s></s></i></div><div class="stats">${[['speed','speedLabel'],['used','usedL'],['remaining','remainingLabel'],['eta','etaLabel']].map(([key,label])=>'<div><small>'+t(label)+'</small><b>'+roll(key+'-'+j.jobId,values[key],key==='speed'?1:0)+(key==='speed'?' '+t('fpsUnit'):'')+'</b></div>').join('')}</div></div>`;hydrateRolls();}
  const total=host.querySelector('[data-total]');if(total)total.textContent=number(j.total);
  for(const [key,value] of Object.entries(values))setRoll(key+'-'+j.jobId,value);
  const bar=host.querySelector<HTMLElement>('.pbar')!,fill=bar.querySelector<HTMLElement>('i')!;
  bar.classList.toggle('indeterminate',['encode','finalize'].includes(j.phase));
  const width=Math.min(100,j.done/(j.total||1)*100)+'%';if(fill.style.width!==width){fill.style.width=width;if(motionOn())bar.querySelector('s')?.animate([{opacity:1},{opacity:0}],900);}
}


function renderDetail() {
  if (!platformReady || !startup.ready) return;
  const j = state.jobs.find(j => j.jobId === selected);
  if (!j) { $('#detail').innerHTML = `<div class="empty">${t('selectJob')}</div>`; contentKey = ''; headerKey = ''; return; }
  if (!$('#detail').querySelector('.detail-head')) $('#detail').innerHTML = '<div class="detail-head"></div><div id="resumed-from"></div><div id="banner"></div><div id="job-progress"></div><div class="tabs" role="tablist"></div><div id="tab-content" role="tabpanel"></div>';
  const nextHeader = JSON.stringify([j.jobId, j.state, j.hosted, j.stuck, j.queuePosition, j.result?.artifacts?.length, jobStarted(j.startedAt)]);
  if (headerKey !== nextHeader) {
    headerKey = nextHeader;
    $('.detail-head').innerHTML = `<div><h2>${escape(base(j.shot))}${j.hosted ? '<span class="tag hosted">'+t('hosted')+'</span>' : ''}</h2><div class="metadata"><span class="status ${j.state}"><i class="dot"></i>${jobLabel(j)}</span> · ${labels()[j.command] ?? escape(j.command)} · ${escape(base(project(j)))}<span class="meta-time">${escape(jobStarted(j.startedAt))} · ${t('usedL')} <span id="elapsed"></span></span></div></div><div class="actions">${['running','queued'].includes(j.state) ? '<button class="danger" data-action="stop">'+t('stop')+'</button>' : j.state==='succeeded' ? '<button class="primary" data-action="artifact" '+(j.result?.artifacts?.length?'':'disabled')+'>'+t('openOutput')+'</button>' : '<button data-action="folder">'+t('openFolder')+'</button>'}<button data-action="more" aria-label="${t('more')}"><i class="ri-more-line"></i></button></div>`;
  }
  const from = resumedFromLine(j,state.jobs); if ($('#resumed-from').innerHTML !== from) $('#resumed-from').innerHTML = from;
  $('#elapsed').textContent = duration(elapsed(j));
  const banner = resultBanner(j); if ($('#banner').innerHTML !== banner) $('#banner').innerHTML = banner;
  renderProgress(j);
  const tabs = ['preview', 'summary', 'timeline', 'options'].map(id => `<button role="tab" data-tab="${id}" aria-selected="${id === tab}">${t(id)}</button>`).join('');
  if ($('.tabs').innerHTML !== tabs) $('.tabs').innerHTML = tabs;
  // Preserve the video element during background refreshes and elapsed-time ticks.
  const key = JSON.stringify([selected, tab, j.state, j.command, j.lost, tab === 'summary' ? j.stderr : null, tab === 'preview' ? (j.command === 'render' ? (j.state==='succeeded'?'video':j.previewFrame!=null) : j.events) : j.events]);
  if(tab==='preview'&&j.command==='render'&&j.previewFrame!=null){const img=$('#tab-content').querySelector<HTMLImageElement>('img.preview');if(img){const src=media(j,j.jobDir+'/preview.png',j.previewVersion);if(img.src!==src)img.src=src;setRoll('preview-'+j.jobId,j.previewFrame);const time=$('#tab-content').querySelector('[data-preview-time]');if(time)time.textContent=tc(j.previewFrame/(j.events.find(e=>e.type==='shot')?.fps??30));}}
  if (key !== contentKey) {
    contentKey = key;
    $('#tab-content').innerHTML = tab === 'preview' ? preview(j) : tab === 'timeline' ? timeline(j) : tab === 'options' ? options(j) : summary(j);
    mountPlayer(j); mountImages(j); hydrateRolls();
    document.querySelectorAll<HTMLImageElement>('img[data-bbox]').forEach(img => {
      const place = () => { const b = JSON.parse(img.dataset.bbox!); if (!b || !img.naturalWidth) return; const box = img.nextElementSibling as HTMLElement; box.hidden = false; Object.assign(box.style, { left: `${b.x / img.naturalWidth * 100}%`, top: `${b.y / img.naturalHeight * 100}%`, width: `${b.w / img.naturalWidth * 100}%`, height: `${b.h / img.naturalHeight * 100}%` }); };
      img.addEventListener('load', place); if (img.complete) place();
    });
  }
}
function render() {
  if (!platformReady) return;
  document.documentElement.dataset.theme = state.theme;
  if (state.ready !== false) startup.finish();
  $('#count').textContent = runningCount(state.runningCount);
  $('#hosting-status').hidden = state.hosted === undefined;
  $('#hosting-status').innerHTML = `<i class="${state.hosted ? 'ri-shield-check-line' : 'ri-shield-line'}" aria-hidden="true"></i>${t(state.hosted ? 'hostedOn' : 'hostedOff')}`;
  if (projectFilter && !state.jobs.some(j => project(j) === projectFilter)) projectFilter = '';
  $('#state-filter').innerHTML = ['all','running','failed'].map(f=>`<button data-filter="${f}" aria-pressed="${stateFilter===f}">${({all:t('all'),running:t('running'),failed:t('failedOrCancelled')} as Record<string,string>)[f]} <small>${state.jobs.filter(j=>(!projectFilter||project(j)===projectFilter)&&(f==='all'||(f==='running'?['running','queued']:['failed','cancelled']).includes(j.state))).length}</small></button>`).join('');
  $('#project-filter span').textContent = projectFilter ? base(projectFilter) : t('allProjects');
  if (page === 'jobs') { renderList(); try { renderDetail(); } catch (error) { report(error); $('#detail').textContent = userError(error); contentKey = ''; headerKey = ''; } }
}
function accept(s: Snapshot) {
  if (typeof s.hosted === 'boolean') preferences.syncHosting(s.hosted);
  preferences.setBusyJobs(updateBusyCount(s));
  const jobs=s.jobs.map(j=>jobData(j,report)).filter(Boolean) as Job[];
  if(motionOn())for(const j of jobs)if(j.state==='succeeded'&&state.jobs.find(old=>old.jobId===j.jobId)?.state==='running'&&!completing.has(j.jobId)) {
    completing.set(j.jobId,'fill');
    setTimeout(()=>{
      completing.set(j.jobId,'fold');
      const card=$('#job-progress');if(card?.dataset.progressJob===j.jobId)card.animate([{height:card.offsetHeight+'px',opacity:1},{height:'0px',opacity:0}],{duration:230,fill:'forwards'});
      const row=Array.from(document.querySelectorAll<HTMLElement>('.job')).find(el=>el.dataset.job===j.jobId);
      row?.animate([{maxHeight:row.offsetHeight+'px',opacity:1},{maxHeight:'0px',opacity:0}],{duration:230});
      setTimeout(()=>{completing.delete(j.jobId);card?.getAnimations().forEach(a=>a.cancel());render();const moved=Array.from(document.querySelectorAll<HTMLElement>('.job')).find(el=>el.dataset.job===j.jobId);moved?.animate([{background:'var(--info-bg)'},{background:'transparent'}],1600);moved?.querySelector('.dot')?.animate([{transform:'scale(1)'},{transform:'scale(1.9)'},{transform:'scale(1)'}],480);},230);
    },520);
  }
  state={...s,jobs};
  if (preferences.settings && s.languagePreference) preferences.settings.own.language = s.languagePreference;
  if (s.language) setLanguage(s.language);
  if (s.select) { selected = s.select; stateFilter = 'all'; projectFilter = ''; }
  if (!state.jobs.some(j => j.jobId === selected)) { selected = state.jobs.find(j => j.state === 'running')?.jobId ?? state.jobs[0]?.jobId ?? ''; contentKey = ''; }
  if(selected) void api.resumePriority?.(selected).catch(report);
  render();
}
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).matches('[data-job]')) { e.preventDefault(); (e.target as HTMLElement).click(); } });
document.addEventListener('click', async e => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('button, [data-job]'); if (!button) return;
  try {
    if (button.dataset.action === 'updates-about' && !preferences.step) navigate('about');
    if (button.dataset.page && !(button as HTMLButtonElement).disabled) navigate(button.dataset.page);
    if (button.dataset.resume) { void api.resume(button.dataset.resume).catch(fail); return; }
    if (button.dataset.gotoJob) { stateFilter='all'; projectFilter=''; selected=button.dataset.gotoJob; contentKey=''; render(); void api.resumePriority?.(selected).catch(report); return; }
    if (button.dataset.job) { void api.resumePriority?.(button.dataset.job).catch(report); selected = button.dataset.job; contentKey = ''; $('#detail').scrollTop = 0; render(); }
    if (button.dataset.filter) { stateFilter=button.dataset.filter; render(); }
    if (button.dataset.tab) { tab = button.dataset.tab; renderDetail(); $('#tab-content').animate([{opacity:0},{opacity:1}],{duration:motionOn()?160:0}); }
    const job=state.jobs.find(j=>j.jobId===selected);
    let copy: string|undefined;
    if (button.dataset.copyValue !== undefined) copy=button.dataset.copyValue;
    if (button.hasAttribute('data-copy-command') && job) copy=commandText(job,document.documentElement.dataset.platform);
    if (button.hasAttribute('data-copy-result') && job) copy=JSON.stringify(job.result,null,2);
    if (button.hasAttribute('data-copy-events') && job) copy=mergedEvents(job.events).map(e=>JSON.stringify(e)).join('\n');
    if (copy!==undefined) { await navigator.clipboard.writeText(copy); const old=button.innerHTML; button.textContent=t('copied'); setTimeout(()=>{if(button.isConnected)button.innerHTML=old;},1200); }
    if (button.dataset.action==='more') menu(button,[{selected:false,label:t('openFolder'),run:()=>{void api.open(selected);}},{selected:false,label:t('jobIdL'),run:()=>{void navigator.clipboard.writeText(selected);}},{selected:false,label:t('hideJob'),run:()=>{void api.hide(selected);}}]);
    if (button.dataset.open) await api.open(selected, button.dataset.open);
    if (button.dataset.reveal) await api.open(selected, button.dataset.reveal, true);
    if (button.dataset.action === 'stop') await api.stop(selected);
    if (button.dataset.action === 'hide') await api.hide(selected);
    if (button.dataset.action === 'folder') await api.open(selected);
    if (button.dataset.action === 'artifact') await api.open(selected, state.jobs.find(j => j.jobId === selected)?.result?.artifacts?.[0]?.path);
  } catch (e) { fail(e); }
});
for (const id of ['project-filter']) {
  const anchor = $('#' + id);
  const open = () => {
    const choices = id === 'state-filter' ? [['all', t('all')], ['running', t('running')], ['failed', t('failedOrCancelled')]] : [['', t('allProjects')], ...[...new Set(state.jobs.map(project))].sort().map(p => [p, base(p)])];
    menu(anchor, choices.map(([value, label]) => ({ label, selected: value === (id === 'state-filter' ? stateFilter : projectFilter), run: () => { if (id === 'state-filter') stateFilter = value; else projectFilter = value; render(); } })));
  };
  anchor.addEventListener('click', open);
  anchor.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
}
for (const selector of ['#detail', '#list']) $(selector).addEventListener('scroll', () => $('.page-h').classList.toggle('stuck', $('#detail').scrollTop > 0 || $('#list').scrollTop > 0));
function localizeShell() {
  document.documentElement.lang = language(); document.title = t('appName');
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach(el => el.textContent = t(el.dataset.copy!));
  document.querySelectorAll<HTMLElement>('[data-copy-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.copyLabel!)));
  $('#heading').textContent = t(page);
  if (!$('#error').hidden) $('#error').textContent = userError($('#error').textContent);
}
onLanguageChange(() => {
  const scroll = Array.from(document.querySelectorAll<HTMLElement>('.scroll')).map(el => [el, el.scrollTop] as const);
  const focus = document.activeElement as HTMLElement | null;
  const focusId = focus?.id;
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-input]')).map(el => ({ key: el.dataset.input, value: el.value, start: el.type === 'text' ? el.selectionStart : null, end: el.type === 'text' ? el.selectionEnd : null }));
  const video = document.querySelector('video.preview');
  localizeShell(); contentKey = ''; headerKey = '';
  render(); preferences.render();
  if (video) { document.querySelector('video.preview')?.replaceWith(video);const job=state.jobs.find(j=>j.jobId===selected);if(job)mountPlayer(job); }
  for (const input of inputs) { const el = document.querySelector<HTMLInputElement>(`[data-input="${input.key}"]`); if (el) { el.value = input.value; if (input.start != null) el.setSelectionRange(input.start, input.end); } }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  for (const [el, top] of scroll) el.scrollTop = top;
});
if (document.documentElement.dataset.language) setLanguage(document.documentElement.dataset.language!);
localizeShell();
installScrollMaterial(document.body);
void initPlatform().then(async () => {
  platformReady = true;
  api.onNavigate?.(next => { if (next === 'jobs' || next === 'settings') navigate(next); });
  api.subscribe(accept); accept(await api.snapshot());
  localizeShell();
  navigate(page);
  void preferences.init().catch(fail);
}).catch(fail);
setInterval(() => { if (state.jobs.some(j => j.state === 'running') && page === 'jobs') { render(); } }, 1000);
