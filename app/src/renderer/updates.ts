import { releaseNotes } from './release-notes';
import { t, language } from '../shared/i18n.mjs';
import type { UpdateState } from '../shared/types';
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const button = (key: string, action: string, extra = '') => `<button data-pref="${action}" ${extra}>${t(key)}</button>`;
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.valueOf()) ? '' : d.toLocaleString(language()); };
// Task 045 defines queued jobs; count before the legacy job view normalizes states.
export const updateBusyCount = (snapshot: { runningCount: number; jobs: { state: string }[] }) => snapshot.runningCount + snapshot.jobs.filter(job => job?.state === 'queued').length;
// TODO(design): Review fallback failure/development copy and the dated last-check label.
export function updateCard(state: UpdateState | undefined, autoCheck: boolean, busyCount: number) {
  if (!state) return '';
  const s = state, v = esc(s.version), checked = s.checkedAt ? t('upChecked', { t: esc(date(s.checkedAt)) }) : '';
  let title = t('checkNow'), sub = checked, actions = button('checkNow', 'update-check'), icon = 'arrow-up-circle', tone = 'info';
  if (s.phase === 'development') { title = t('upDevelopment'); actions = button('checkNow', 'update-check', 'disabled'); }
  if (s.phase === 'current') { title = t('upCurrent'); icon = 'checkbox-circle'; tone = 'succeeded'; }
  if (s.phase === 'checking') { title = t('upChecking'); actions = button('checkNow', 'update-check', 'disabled'); icon = 'loader-4'; }
  if (s.phase === 'available' || s.phase === 'manual') {
    title = t('upAvail', { v }); sub = s.phase === 'manual' ? t('upManual') : s.publishedAt ? t('upPublished', { d: esc(date(s.publishedAt)) }) : '';
    actions = s.phase === 'manual' ? button('openDownload', 'update-release', 'class="primary"') : button('viewRelease', 'update-release') + button('download', 'update-download', 'class="primary"');
  }
  if (s.phase === 'downloading') { title = s.total > 0 ? t('upDownloading', { v, a: (s.transferred / 1e6).toFixed(1), b: (s.total / 1e6).toFixed(1) }) : t('upPreparingDownload', { v }); sub = ''; icon = 'download-2'; actions = button('cancelDl', 'update-cancel'); }
  if (s.phase === 'downloaded') { title = t('upReady', { v }); sub = busyCount ? t('upBusy', { n: busyCount }) : ''; icon = 'checkbox-circle'; tone = 'succeeded'; actions = button('later', 'update-later') + button('restartInstall', 'update-install', 'class="primary"'); }
  if (s.phase === 'error') { title = t(s.errorStage === 'download' ? 'upDownloadError' : s.errorStage === 'install' ? 'upInstallError' : 'upError'); actions = button('retry', 'update-check'); icon = 'error-warning'; tone = 'failed'; }
  const fullDownload = ['downloading', 'downloaded'].includes(s.phase) && s.fullDownloadReason ? t(s.fullDownloadReason === 'old-blockmap-missing' ? 'upFullMissing' : 'upFullOther', { v: esc(s.currentVersion) }) : '';
  return `<h2>${t('updates')}</h2><section class="upd-card" data-update-phase="${s.phase}"><div class="upd-head"><i aria-hidden="true" class="ri-${icon}-line ${tone}"></i><div role="status"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div><span class="sp"></span><div class="upd-actions">${actions}</div></div>${s.phase === 'downloading' ? `<progress aria-label="${t('download')}" max="100" ${s.total > 0 ? `value="${s.percent}"` : ''}></progress>` : ''}${['available', 'manual'].includes(s.phase) ? releaseNotes(s) : ''}${fullDownload ? `<div class="upd-tip" data-full-download>${fullDownload}</div>` : ''}<div class="upd-tip">${t('upSkills')}</div></section><div class="setting-row upd-setting"><div><label>${t('autoCheck')}</label><small>${t('autoCheckD')}</small></div><button class="upd-switch" data-pref="autoCheckUpdates" role="switch" aria-label="${t('autoCheck')}" aria-checked="${autoCheck}"></button></div>`;
}
export function updateHint(state?: UpdateState) {
  const hint = document.getElementById('update-hint') as HTMLButtonElement | null;
  if (!hint) return;
  hint.hidden = !state || !['available', 'manual', 'downloading', 'downloaded'].includes(state.phase);
  hint.innerHTML = `<i class="ri-arrow-up-circle-line" aria-hidden="true"></i>${state ? esc(t('newVersion', { v: state.version })) : ''}`;
}
