import path from 'node:path';
import { t } from '../shared/i18n.mjs';
export function trayTemplate(jobs, show, quit) {
  return [{ label: t('showWindow'), click: () => show() }, { type: 'separator' },
    ...jobs.filter(j => j.state === 'running').slice(0, 5).map(j => ({ label: `${path.basename(j.shot)} · ${j.total ? Math.min(100, Math.round(j.done / j.total * 100)) + '%' : '—'}`, click: () => show(j.jobId) })),
    { label: t('trayQueued', { n: jobs.filter(j => j.state === 'queued').length }), enabled: false },
    { type: 'separator' }, { label: t('quit'), click: quit }];
}
export function hideOnClose(enabled, quitting) { return enabled && !quitting; }
