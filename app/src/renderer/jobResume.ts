import { t, number, jobStarted } from '../shared/i18n.mjs';
import { esc, base } from './jobDetail';
import type { Job } from '../shared/types';
const refusalCopy: Record<string, [string,string]> = {
 inputs_changed: ['rr_inputs_changed','rr_inputs_changedH'], environment_changed: ['rr_environment_changed','rr_environment_changedH'],
 running: ['rr_running','rr_runningH'], missing_manifest: ['rr_missing_manifest','rr_missing_manifestH'],
 succeeded: ['rr_succeeded','rr_succeededH'], not_render: ['rr_not_render','rr_not_renderH']
};
const environmentCopy: Record<string,string> = { multiplane:'env_multiplane', chromium:'env_chromium', raster:'env_raster', ffmpeg:'env_ffmpeg', encoder:'env_encoder' };
export const resumable = (j: Job) => j.command === 'render' && ['failed','cancelled'].includes(j.state) && j.resume?.available && !j.resumedBy && !j.resumeError;
export function resumeAction(j: Job, chip = false) {
  if (!resumable(j)) return '';
  return `<button class="${chip ? 'resume-chip' : 'btn sm primary'}" data-resume="${esc(j.jobId)}" ${j.resuming ? 'disabled' : ''}><i class="${j.resuming ? 'ri-loader-4-line' : 'ri-restart-line'}"></i>${t(j.resuming ? 'resumeStarting' : chip ? 'resumeShort' : 'resumeBtn')}${chip ? ` · ${number(j.resume!.framesDone)} / ${number(j.resume!.framesTotal)}` : ''}</button>`;
}
export function resumeBlock(j: Job) {
  if (j.resumedBy) return `<span class="resume-line done"><i class="ri-corner-down-right-line"></i>${t('resumedBy')}<button class="link" data-goto-job="${esc(j.resumedBy)}">${t('view')}</button></span>`;
  if (j.resumeError) {
    const e=j.resumeError, keys=refusalCopy[e.reason];
    const known=!!keys, changes=e.changes ?? [];
    const hint=known ? t(keys[1],{list:(e.reason==='environment_changed'?changes.map(key=>environmentCopy[key]?t(environmentCopy[key]):key):[]).join(' / ')}) : '';
    return `<div class="resume-err"><b><i class="ri-close-circle-line"></i>${esc(known?t(keys[0]):e.reason)}</b><span>${esc(hint)}</span>${e.reason==='inputs_changed'?`<ul>${changes.map(c=>`<li class="mono selectable">${esc(c)}</li>`).join('')}</ul>`:''}${['inputs_changed','environment_changed','missing_manifest'].includes(e.reason)?`<button class="btn sm" data-copy-command><i class="ri-terminal-box-line"></i>${t('copyRerender')}</button>`:''}</div>`;
  }
  if (!resumable(j)) return '';
  return `<span class="resume-line"><span class="rb"><i style="width:${Math.min(100,Math.max(0,j.resume!.framesDone/(j.resume!.framesTotal||1)*100))}%"></i></span>${t('resumeDone',{a:number(j.resume!.framesDone),b:number(j.resume!.framesTotal)})}</span>`;
}
export function resumedFromLine(j: Job, jobs: Job[]) {
  const start=j.events.find(e=>e.type==='start'), id=j.result?.data?.resumedFrom ?? start?.resumedFrom;
  if (!id) return '';
  const original=jobs.find(j=>j.jobId===id), reused=j.result?.data?.resume ?? start?.resume;
  return `<div class="d-from"><i class="ri-corner-up-left-line"></i>${t('resumedFrom')}<button class="link" data-goto-job="${esc(id)}">${esc(original?base(original.shot):id)}${original?' · '+esc(jobStarted(original.startedAt)):''}</button>${reused?`<span> · ${t('resumedFromD',{s:number(reused.segmentsReused),f:number(reused.framesReused)})}</span>`:''}</div>`;
}
