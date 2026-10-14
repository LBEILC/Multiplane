import { t, language, setLanguage, number, bytes, pixels, runningCount, formatDuration, onLanguageChange } from '../shared/i18n.mjs';
import { userError } from '../shared/errors.mjs';
import type { Job, Snapshot, Event } from '../shared/types';
import { menu } from './menu';
import { installScrollMaterial } from './floatingThumb';
import { SettingsView } from './settings';
import './skillConfirmation';
import { initPlatform, displayPath, revealLabel } from './platform';
import { jobData } from '../shared/job-data.mjs';
const api = window.multiplane;
const report = (error: unknown) => api.reportFault?.(String((error as Error)?.stack ?? error));
window.addEventListener('error', event => report(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => report(event.reason));
let platformReady = false;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const base = (v: string) => v.split(/[\\/]/).filter(Boolean).at(-1) ?? v;
const project = (j: Job) => {
  const root = j.events.find(e => e.type === 'start')?.options?.root;
  return typeof root === 'string' ? root : j.shot.replace(/[\\/][^\\/]*$/, '');
};
const labels = (): Record<string, string> => ({ running: t('running'), succeeded: t('completed'), failed: t('failed'), cancelled: t('cancelled'), render: t('render'), stills: t('stills'), verify: t('verify'), launch: t('launch'), load: t('load'), capture: t('capture'), encode: t('encode'), compare: t('compare'), finalize: t('done') });
const duration = (ms: number | null) => ms == null ? '—' : formatDuration(ms);
const elapsed = (j: Job) => Number.isFinite(j.result?.elapsedMs) ? j.result!.elapsedMs : Number.isFinite(Date.parse(j.startedAt)) ? Math.max(0, Date.now() - Date.parse(j.startedAt)) : null;
let stateFilter = 'all', projectFilter = '';
let state: Snapshot = { jobs: [], runningCount: 0, theme: 'light' }, selected = '', tab = 'preview', page = 'jobs', contentKey = '', headerKey = '';
const fail = (e: unknown) => { report(e); $('#error').textContent = userError(e); $('#error').hidden = false; };
const media = (j: Job, file: string, version = '') => escape(api.media(j.jobId, file, version));
function navigate(next: string) {
  if (!platformReady) { page = next; return; }
  page = next; $('#heading').textContent = t(page); $('#jobs').hidden = page !== 'jobs'; $('#placeholder').hidden = page === 'jobs';
  document.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-current', (el as HTMLElement).dataset.page === page ? 'page' : 'false'));
  $('.page-h').classList.remove('stuck'); preferences.mount(page); render();
}
const preferences = new SettingsView($('#placeholder'), navigate);
function rows(data: Record<string, unknown> = {}) { return Object.entries(data).map(([k, v]) => `<div class="kv"><span class="mono">${escape(k)}</span><pre>${escape(typeof v === 'object' ? JSON.stringify(v, null, 2) : v)}</pre></div>`).join(''); }
function renderList() {
  if (!platformReady) return;
  const filter = stateFilter;
  const jobs = state.jobs.filter(j => (!projectFilter || project(j) === projectFilter) && (filter === 'all' || (filter === 'running' ? j.state === 'running' : ['failed', 'cancelled'].includes(j.state))))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt.localeCompare(a.startedAt));
  let group = '';
  const html = jobs.map(j => {
    const next = j.state === 'running' ? t('running') : Number.isFinite(Date.parse(j.startedAt)) ? new Date(j.startedAt).toLocaleDateString(language()) : '—';
    const heading = next === group ? '' : `<div class="group">${escape(next)}</div>`; group = next;
    return `${heading}<button class="job" role="listitem" data-job="${escape(j.jobId)}" aria-selected="${j.jobId === selected}"><div class="row-top"><span class="name">${escape(base(j.shot))}</span><span class="tag ${j.state}">${labels()[j.state]}</span></div><div class="row-sub"><span>${labels()[j.command] ?? escape(j.command)} · ${escape(base(project(j)))}</span><span>${duration(elapsed(j))}</span></div>${j.state === 'running' ? `<progress max="${escape(j.total || 1)}" value="${escape(j.done)}"></progress><small>${t('progress', { done: number(j.done), total: number(j.total), fps: number(j.fps, 1), remaining: duration(j.etaMs) })}</small>` : ''}</button>`;
  }).join('') || `<div class="empty">${t('noJobs')}</div>`;
  if ($('#list').innerHTML !== html) {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.job : undefined;
    $('#list').innerHTML = html;
    if (focused) Array.from(document.querySelectorAll<HTMLElement>('[data-job]')).find(e => e.dataset.job === focused)?.focus({ preventScroll: true });
  }
}
function preview(j: Job) {
  if (j.command === 'render') {
    const video = j.result?.artifacts?.find((a: any) => a.kind === 'video');
    if (j.state === 'succeeded' && video) return `<video class="preview" controls preload="metadata" src="${media(j, video.path)}"></video>`;
    if (j.previewFrame != null) return `<img class="preview" alt="${t('latestFrame')}" src="${media(j, j.jobDir + '/preview.png', j.previewVersion)}"><p class="caption">${t('frame', { frame: number(j.previewFrame) })}</p>`;
  }
  if (j.command === 'stills') {
    const artifacts = j.result?.artifacts ?? j.events.filter(e => e.type === 'artifact');
    const sheet = artifacts.find((a: any) => a.kind === 'contact-sheet');
    if (!sheet && !artifacts.some((a: any) => a.kind === 'still')) return `<div class="empty">${t('noPreview')}</div>`;
    return `${sheet ? `<img class="preview" alt="${t('contactSheet')}" src="${media(j, sheet.path)}">` : ''}<div class="stills-grid">${artifacts.filter((a: any) => a.kind === 'still').map((a: any) => `<button data-open="${escape(a.path)}" aria-label="${t('openFile', { name: escape(base(a.path)) })}"><img alt="${escape(base(a.path))}" src="${media(j, a.path)}"></button>`).join('')}</div>`;
  }
  if (j.command === 'verify') {
    const findings = j.events.filter(e => e.type === 'finding' && e.details?.images);
    return findings.map(e => `<section><h3>${escape(e.details.check)} · ${t('frame', { frame: number(e.location?.frame) })}</h3><div class="triptych">${(['reference', 'actual', 'diff'] as const).map((key, i) => `<figure><div class="image-box"><img alt="${[t('reference'), t('actual'), t('difference')][i]}" data-bbox="${escape(JSON.stringify(e.details.bbox))}" src="${media(j, e.details.images[key])}"><span class="bbox" hidden></span></div><figcaption>${[t('reference'), t('actual'), t('difference')][i]}</figcaption></figure>`).join('')}</div><p class="caption selectable">${escape(e.message)}<br>${e.details.bbox ? t('changedRegion', { x: number(e.details.bbox.x), y: number(e.details.bbox.y), width: number(e.details.bbox.w), height: number(e.details.bbox.h) }) : ''} · ${pixels(e.details.changedPixels)}</p></section>`).join('') || `<div class="empty">${t('noPreview')}</div>`;
  }
  return `<div class="empty">${j.command === 'render' && j.state === 'running' ? t('firstFrame') : t('noPreview')}</div>`;
}
function events(j: Job) {
  const merged: Event[] = [];
  const phases = new Map<string, number>();
  for (const e of j.events) {
    if (e.type === 'progress') { const at = phases.get(e.phase); if (at !== undefined) { merged[at] = { ...e, ts: merged[at].ts }; continue; } phases.set(e.phase, merged.length); }
    merged.push(e);
  }
  return merged.map(e => `<div class="event ${escape(e.type)} ${e.type === 'result' && !e.ok ? 'failure' : ''}"><time>${escape(new Date(e.ts).toLocaleTimeString(language()))}</time><span>${escape(e.type === 'progress' ? `${labels()[e.phase] ?? e.phase} · ${number(e.done)} / ${number(e.total)}` : e.message ?? (e.type === 'result' ? labels()[j.state] : e.type))}</span>${e.code ? `<div class="mono">${escape(e.code)}</div>` : ''}${e.hint ? `<p>${escape(e.hint)}</p>` : ''}</div>`).join('');
}
function resultBanner(j: Job) {
  if (!['failed', 'cancelled'].includes(j.state)) return '';
  const status = j.lost ? t('processLost') : labels()[j.state];
  const message = j.result?.message || status;
  const text = language() === 'en'
    ? `<p>${escape(j.lost ? status : message)}</p>${j.result?.hint ? `<p>${escape(j.result.hint)}</p>` : ''}`
    : `<p>${escape(status)}</p><small class="renderer-detail">${escape(message)}${j.result?.hint ? `<br>${escape(j.result.hint)}` : ''}</small>`;
  return `<div class="banner ${j.state} selectable">${text}<div class="mono">${escape(j.result?.code)}</div></div>`;
}
function renderDetail() {
  if (!platformReady) return;
  const j = state.jobs.find(j => j.jobId === selected);
  if (!j) { $('#detail').innerHTML = `<div class="empty">${t('selectJob')}</div>`; contentKey = ''; headerKey = ''; return; }
  if (!$('#detail').querySelector('.detail-head')) $('#detail').innerHTML = '<div class="detail-head"></div><div id="banner"></div><div class="tabs" role="tablist"></div><div id="tab-content" role="tabpanel"></div>';
  const nextHeader = JSON.stringify([j.jobId, j.state, j.result?.artifacts?.length]);
  if (headerKey !== nextHeader) {
    headerKey = nextHeader;
    $('.detail-head').innerHTML = `<h2>${escape(base(j.shot))}</h2><div class="metadata"><span class="${j.state}">${labels()[j.state]}</span> · ${labels()[j.command] ?? escape(j.command)} · ${escape(base(project(j)))}<br>${escape(new Date(j.startedAt).toLocaleString(language()))} · ${t('elapsed')} <span id="elapsed"></span></div><div class="mono job-id">${escape(j.jobId)}</div><div class="actions">${j.state === 'running' ? `<button class="danger" data-action="stop">${t('stop')}</button>` : `<button class="primary" data-action="artifact" ${j.result?.artifacts?.length ? '' : 'disabled'}>${t('openOutput')}</button><button data-action="folder">${t('openFolder')}</button>`}<button data-action="hide">${t('hideJob')}</button></div>`;
  }
  $('#elapsed').textContent = duration(elapsed(j));
  $('#banner').innerHTML = resultBanner(j);
  const tabs = ['preview', 'events', 'result', 'options'].map(id => `<button role="tab" data-tab="${id}" aria-selected="${id === tab}">${t(id)}</button>`).join('');
  if ($('.tabs').innerHTML !== tabs) $('.tabs').innerHTML = tabs;
  // Preserve the video element during background refreshes and elapsed-time ticks.
  const key = JSON.stringify([selected, tab, j.state, tab === 'preview' ? (j.command === 'render' ? j.previewVersion : j.events.length) : j.events.length]);
  if (key !== contentKey) {
    contentKey = key;
    $('#tab-content').innerHTML = tab === 'preview' ? preview(j) : tab === 'events' ? events(j) : tab === 'options' ? rows(j.events.find(e => e.type === 'start')?.options) : `<h3>${t('result')}</h3>${rows(j.result?.data)}<h3>${t('artifacts')}</h3>${(j.result?.artifacts ?? j.events.filter(e => e.type === 'artifact')).map((a: any) => `<div class="artifact"><div class="mono">${escape(displayPath(a.path))}</div><small>${escape(a.kind)} · ${bytes(a.bytes)}</small><br><button data-open="${escape(a.path)}">${t('open')}</button><button data-reveal="${escape(a.path)}">${revealLabel()}</button></div>`).join('')}<h3>${t('environment')}</h3>${rows(Object.fromEntries(Object.entries(j.events.find(e => e.type === 'environment') ?? {}).filter(([k]) => !['schema', 'type', 'command', 'ts'].includes(k))))}`;
    document.querySelectorAll<HTMLImageElement>('img[data-bbox]').forEach(img => {
      const place = () => { const b = JSON.parse(img.dataset.bbox!); if (!b || !img.naturalWidth) return; const box = img.nextElementSibling as HTMLElement; box.hidden = false; Object.assign(box.style, { left: `${b.x / img.naturalWidth * 100}%`, top: `${b.y / img.naturalHeight * 100}%`, width: `${b.w / img.naturalWidth * 100}%`, height: `${b.h / img.naturalHeight * 100}%` }); };
      img.addEventListener('load', place); if (img.complete) place();
    });
  }
}
function render() {
  if (!platformReady) return;
  document.documentElement.dataset.theme = state.theme;
  $('#count').textContent = runningCount(state.runningCount);
  if (projectFilter && !state.jobs.some(j => project(j) === projectFilter)) projectFilter = '';
  $('#state-filter span').textContent = ({ all: t('all'), running: t('running'), failed: t('failedOrCancelled') } as Record<string, string>)[stateFilter];
  $('#project-filter span').textContent = projectFilter ? base(projectFilter) : t('allProjects');
  if (page === 'jobs') { renderList(); try { renderDetail(); } catch (error) { report(error); $('#detail').textContent = userError(error); contentKey = ''; headerKey = ''; } }
}
function accept(s: Snapshot) { state = { ...s, jobs: s.jobs.map(j => jobData(j, report)).filter(Boolean) as Job[] }; if (preferences.settings && s.languagePreference) preferences.settings.own.language = s.languagePreference; if (s.language) setLanguage(s.language); if (s.select) selected = s.select; if (!state.jobs.some(j => j.jobId === selected)) { selected = state.jobs.find(j => j.state === 'running')?.jobId ?? state.jobs[0]?.jobId ?? ''; contentKey = ''; } render(); }
document.addEventListener('click', async e => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!button) return;
  try {
    if (button.dataset.page && !(button as HTMLButtonElement).disabled) navigate(button.dataset.page);
    if (button.dataset.job) { selected = button.dataset.job; contentKey = ''; $('#detail').scrollTop = 0; render(); }
    if (button.dataset.tab) { tab = button.dataset.tab; renderDetail(); }
    if (button.dataset.open) await api.open(selected, button.dataset.open);
    if (button.dataset.reveal) await api.open(selected, button.dataset.reveal, true);
    if (button.dataset.action === 'stop') await api.stop(selected);
    if (button.dataset.action === 'hide') await api.hide(selected);
    if (button.dataset.action === 'folder') await api.open(selected);
    if (button.dataset.action === 'artifact') await api.open(selected, state.jobs.find(j => j.jobId === selected)?.result?.artifacts?.[0]?.path);
  } catch (e) { fail(e); }
});
for (const id of ['state-filter', 'project-filter']) {
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
  if (video) document.querySelector('video.preview')?.replaceWith(video);
  for (const input of inputs) { const el = document.querySelector<HTMLInputElement>(`[data-input="${input.key}"]`); if (el) { el.value = input.value; if (input.start != null) el.setSelectionRange(input.start, input.end); } }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  for (const [el, top] of scroll) el.scrollTop = top;
});
localizeShell();
installScrollMaterial(document.body);
void initPlatform().then(async () => {
  api.subscribe(accept); accept(await api.snapshot());
  await preferences.init();
  platformReady = true;
  localizeShell();
  navigate(page);
}).catch(fail);
setInterval(() => { if (state.jobs.some(j => j.state === 'running') && page === 'jobs') { render(); } }, 1000);
