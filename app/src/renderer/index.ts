import type { Job, Snapshot, Event } from '../shared/types';
import { menu } from './menu';
import { installScrollMaterial } from './floatingThumb';
import { SettingsView } from './settings';
import './skillConfirmation';
import { initPlatform, displayPath, revealLabel } from './platform';
const api = window.multiplane;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const base = (v: string) => v.split(/[\\/]/).filter(Boolean).at(-1) ?? v;
const project = (j: Job) => {
  const root = j.events.find(e => e.type === 'start')?.options?.root;
  return typeof root === 'string' ? root : j.shot.replace(/[\\/][^\\/]*$/, '');
};
const labels: Record<string, string> = { running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', render: '渲染', stills: '抽帧', verify: '检查', launch: '启动', load: '加载', capture: '采集', encode: '编码', compare: '比较', finalize: '完成' };
const duration = (ms: number | null) => ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const elapsed = (j: Job) => j.result?.elapsedMs ?? Math.max(0, Date.now() - Date.parse(j.startedAt));
let stateFilter = 'all', projectFilter = '';
let state: Snapshot = { jobs: [], runningCount: 0, theme: 'light' }, selected = '', tab = '预览', page = '作业', contentKey = '', headerKey = '';
const fail = (e: unknown) => { $('#error').textContent = String(e instanceof Error ? e.message : e); $('#error').hidden = false; };
const media = (j: Job, file: string, version = '') => escape(api.media(j.jobId, file, version));
function navigate(next: string) {
  page = next; $('#heading').textContent = page; $('#jobs').hidden = page !== '作业'; $('#placeholder').hidden = page === '作业';
  document.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-current', (el as HTMLElement).dataset.page === page ? 'page' : 'false'));
  $('.page-h').classList.remove('stuck'); preferences.mount(page); render();
}
const preferences = new SettingsView($('#placeholder'), navigate);
function rows(data: Record<string, unknown> = {}) { return Object.entries(data).map(([k, v]) => `<div class="kv"><span>${escape(k)}</span><pre>${escape(typeof v === 'object' ? JSON.stringify(v, null, 2) : v)}</pre></div>`).join(''); }
function renderList() {
  const filter = stateFilter;
  const jobs = state.jobs.filter(j => (!projectFilter || project(j) === projectFilter) && (filter === 'all' || (filter === 'running' ? j.state === 'running' : ['failed', 'cancelled'].includes(j.state))))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt.localeCompare(a.startedAt));
  let group = '';
  const html = jobs.map(j => {
    const next = j.state === 'running' ? '进行中' : new Date(j.startedAt).toLocaleDateString('zh-CN');
    const heading = next === group ? '' : `<div class="group">${escape(next)}</div>`; group = next;
    return `${heading}<button class="job" role="listitem" data-job="${escape(j.jobId)}" aria-selected="${j.jobId === selected}"><div class="row-top"><span class="name">${escape(base(j.shot))}</span><span class="tag ${j.state}">${labels[j.state]}</span></div><div class="row-sub"><span>${labels[j.command] ?? escape(j.command)} · ${escape(base(project(j)))}</span><span>${duration(elapsed(j))}</span></div>${j.state === 'running' ? `<progress max="${escape(j.total || 1)}" value="${escape(j.done)}"></progress><small>${escape(j.done)} / ${escape(j.total ?? '—')} · ${Number.isFinite(j.fps) ? j.fps!.toFixed(1) : '—'} 帧/秒 · 剩余 ${duration(j.etaMs)}</small>` : ''}</button>`;
  }).join('') || '<div class="empty">还没有作业。agent 运行 <code>multiplane render</code>、<code>stills</code> 或 <code>verify</code> 后，作业会出现在这里。</div>';
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
    if (j.previewFrame != null) return `<img class="preview" alt="最新完成帧" src="${media(j, j.jobDir + '/preview.png', j.previewVersion)}"><p class="caption">帧 ${escape(j.previewFrame)}</p>`;
  }
  if (j.command === 'stills') {
    const artifacts = j.result?.artifacts ?? j.events.filter(e => e.type === 'artifact');
    const sheet = artifacts.find((a: any) => a.kind === 'contact-sheet');
    if (!sheet && !artifacts.some((a: any) => a.kind === 'still')) return '<div class="empty">这个作业没有预览</div>';
    return `${sheet ? `<img class="preview" alt="联系表" src="${media(j, sheet.path)}">` : ''}<div class="stills-grid">${artifacts.filter((a: any) => a.kind === 'still').map((a: any) => `<button data-open="${escape(a.path)}" aria-label="打开 ${escape(base(a.path))}"><img alt="${escape(base(a.path))}" src="${media(j, a.path)}"></button>`).join('')}</div>`;
  }
  if (j.command === 'verify') {
    const findings = j.events.filter(e => e.type === 'finding' && e.details?.images);
    return findings.map(e => `<section><h3>${escape(e.details.check)} · 帧 ${escape(e.location?.frame)}</h3><div class="triptych">${(['reference', 'actual', 'diff'] as const).map((key, i) => `<figure><div class="image-box"><img alt="${['参考帧', '实际帧', '差异图'][i]}" data-bbox="${escape(JSON.stringify(e.details.bbox))}" src="${media(j, e.details.images[key])}"><span class="bbox" hidden></span></div><figcaption>${['参考帧', '实际帧', '差异图'][i]}</figcaption></figure>`).join('')}</div><p class="caption selectable">${escape(e.message)}<br>${e.details.bbox ? `变化区域 x ${escape(e.details.bbox.x)}，y ${escape(e.details.bbox.y)}，${escape(e.details.bbox.w)} × ${escape(e.details.bbox.h)}` : ''} · ${escape(e.details.changedPixels)} 像素</p></section>`).join('') || '<div class="empty">这个作业没有预览</div>';
  }
  return `<div class="empty">${j.command === 'render' && j.state === 'running' ? '第一帧完成后显示预览' : '这个作业没有预览'}</div>`;
}
function events(j: Job) {
  const merged: Event[] = [];
  const phases = new Map<string, number>();
  for (const e of j.events) {
    if (e.type === 'progress') { const at = phases.get(e.phase); if (at !== undefined) { merged[at] = { ...e, ts: merged[at].ts }; continue; } phases.set(e.phase, merged.length); }
    merged.push(e);
  }
  return merged.map(e => `<div class="event ${escape(e.type)} ${e.type === 'result' && !e.ok ? 'failure' : ''}"><time>${escape(new Date(e.ts).toLocaleTimeString('zh-CN'))}</time><span>${escape(e.type === 'progress' ? `${labels[e.phase] ?? e.phase} · ${e.done} / ${e.total ?? '—'}` : e.message ?? (e.type === 'result' ? labels[j.state] : e.type))}</span>${e.code ? `<div class="mono">${escape(e.code)}</div>` : ''}${e.hint ? `<p>${escape(e.hint)}</p>` : ''}</div>`).join('');
}
function renderDetail() {
  const j = state.jobs.find(j => j.jobId === selected);
  if (!j) { $('#detail').innerHTML = '<div class="empty">选择一个作业</div>'; contentKey = ''; headerKey = ''; return; }
  if (!$('#detail').querySelector('.detail-head')) $('#detail').innerHTML = '<div class="detail-head"></div><div id="banner"></div><div class="tabs" role="tablist"></div><div id="tab-content" role="tabpanel"></div>';
  const nextHeader = JSON.stringify([j.jobId, j.state, j.result?.artifacts?.length]);
  if (headerKey !== nextHeader) {
    headerKey = nextHeader;
    $('.detail-head').innerHTML = `<h2>${escape(base(j.shot))}</h2><div class="metadata"><span class="${j.state}">${labels[j.state]}</span> · ${labels[j.command] ?? escape(j.command)} · ${escape(base(project(j)))}<br>${escape(new Date(j.startedAt).toLocaleString('zh-CN'))} · 用时 <span id="elapsed"></span></div><div class="mono job-id">${escape(j.jobId)}</div><div class="actions">${j.state === 'running' ? '<button class="danger" data-action="stop">停止</button>' : `<button class="primary" data-action="artifact" ${j.result?.artifacts?.length ? '' : 'disabled'}>打开产物</button><button data-action="folder">打开文件夹</button>`}<button data-action="hide">从列表隐藏</button></div>`;
  }
  $('#elapsed').textContent = duration(elapsed(j));
  $('#banner').innerHTML = ['failed', 'cancelled'].includes(j.state) ? `<div class="banner ${j.state} selectable"><p>${escape(j.result?.message)}</p>${j.result?.hint ? `<p>${escape(j.result.hint)}</p>` : ''}<div class="mono">${escape(j.result?.code)}</div></div>` : '';
  const tabs = ['预览', '事件', '结果', '参数'].map(t => `<button role="tab" data-tab="${t}" aria-selected="${t === tab}">${t}</button>`).join('');
  if ($('.tabs').innerHTML !== tabs) $('.tabs').innerHTML = tabs;
  // Preserve the video element during background refreshes and elapsed-time ticks.
  const key = JSON.stringify([selected, tab, j.state, tab === '预览' ? (j.command === 'render' ? j.previewVersion : j.events.length) : j.events.length]);
  if (key !== contentKey) {
    contentKey = key;
    $('#tab-content').innerHTML = tab === '预览' ? preview(j) : tab === '事件' ? events(j) : tab === '参数' ? rows(j.events.find(e => e.type === 'start')?.options) : `<h3>结果</h3>${rows(j.result?.data)}<h3>产物</h3>${(j.result?.artifacts ?? j.events.filter(e => e.type === 'artifact')).map((a: any) => `<div class="artifact"><div class="mono">${escape(displayPath(a.path))}</div><small>${escape(a.kind)} · ${escape(a.bytes)} bytes</small><br><button data-open="${escape(a.path)}">打开</button><button data-reveal="${escape(a.path)}">在文件夹中显示</button></div>`).join('')}<h3>环境</h3>${rows(Object.fromEntries(Object.entries(j.events.find(e => e.type === 'environment') ?? {}).filter(([k]) => !['schema', 'type', 'command', 'ts'].includes(k))))}`;
    document.querySelectorAll<HTMLImageElement>('img[data-bbox]').forEach(img => {
      const place = () => { const b = JSON.parse(img.dataset.bbox!); if (!b || !img.naturalWidth) return; const box = img.nextElementSibling as HTMLElement; box.hidden = false; Object.assign(box.style, { left: `${b.x / img.naturalWidth * 100}%`, top: `${b.y / img.naturalHeight * 100}%`, width: `${b.w / img.naturalWidth * 100}%`, height: `${b.h / img.naturalHeight * 100}%` }); };
      img.addEventListener('load', place); if (img.complete) place();
    });
  }
}
function render() {
  document.documentElement.dataset.theme = state.theme;
  $('#count').textContent = `${state.runningCount} 个作业进行中`;
  if (projectFilter && !state.jobs.some(j => project(j) === projectFilter)) projectFilter = '';
  $('#state-filter span').textContent = ({ all: '全部', running: '进行中', failed: '失败或取消' } as Record<string, string>)[stateFilter];
  $('#project-filter span').textContent = projectFilter ? base(projectFilter) : '全部项目';
  if (page === '作业') { renderList(); renderDetail(); }
}
function accept(s: Snapshot) { state = s; if (s.select) selected = s.select; if (!state.jobs.some(j => j.jobId === selected)) { selected = state.jobs.find(j => j.state === 'running')?.jobId ?? state.jobs[0]?.jobId ?? ''; contentKey = ''; } render(); }
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
    const choices = id === 'state-filter' ? [['all', '全部'], ['running', '进行中'], ['failed', '失败或取消']] : [['', '全部项目'], ...[...new Set(state.jobs.map(project))].sort().map(p => [p, base(p)])];
    menu(anchor, choices.map(([value, label]) => ({ label, selected: value === (id === 'state-filter' ? stateFilter : projectFilter), run: () => { if (id === 'state-filter') stateFilter = value; else projectFilter = value; render(); } })));
  };
  anchor.addEventListener('click', open);
  anchor.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); } });
}
for (const selector of ['#detail', '#list']) $(selector).addEventListener('scroll', () => $('.page-h').classList.toggle('stuck', $('#detail').scrollTop > 0 || $('#list').scrollTop > 0));
installScrollMaterial(document.body);
api.subscribe(accept); void initPlatform().then(async () => { accept(await api.snapshot()); await preferences.init(); }).catch(fail);
setInterval(() => { if (state.jobs.some(j => j.state === 'running') && page === '作业') { renderList(); renderDetail(); } }, 1000);
