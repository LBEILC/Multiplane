import path from 'node:path';
import { t } from '../shared/i18n.mjs';
export function trayTemplate(jobs, show, quit) {
  return [{ label: t('trOpen'), click: () => show() }, { type: 'separator' },
    ...jobs.filter(j => j.state === 'running').slice(0, 5).map(j => ({ label: `${path.basename(j.shot)} · ${j.total ? Math.min(100, Math.round(j.done / j.total * 100)) + '%' : '—'}`, click: () => show(j.jobId) })),
    ...(jobs.some(j => j.state === 'queued') ? [{ label: t('trayQueued', { n: jobs.filter(j => j.state === 'queued').length }), enabled: false }] : []),
    { type: 'separator' }, { label: t('quit'), click: quit }];
}
export function hideOnClose(enabled, quitting) { return enabled && !quitting; }

// Electron DIP coordinates also cover displays with negative origins.
export function trayPosition(icon, cursor, display, size) {
  const w = display.workArea, b = display.bounds;
  const valid = icon && icon.width > 0 && icon.height > 0;
  const anchor = valid ? { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 } : cursor;
  const edges = [
    ['left', w.x - b.x, Math.abs(anchor.x - w.x)],
    ['right', b.x + b.width - w.x - w.width, Math.abs(anchor.x - w.x - w.width)],
    ['top', w.y - b.y, Math.abs(anchor.y - w.y)],
    ['bottom', b.y + b.height - w.y - w.height, Math.abs(anchor.y - w.y - w.height)],
  ];
  const reserved = edges.filter(e => e[1] > 0);
  const edge = (reserved.length ? reserved : edges).sort((a,b) => a[2]-b[2])[0][0];
  const width = Math.min(size.width, w.width), height = Math.min(size.height, w.height);
  let x = anchor.x - width / 2, y = anchor.y - height / 2;
  if (edge === 'bottom') y = w.y + w.height - height - 8;
  if (edge === 'top') y = w.y + 8;
  if (edge === 'left') x = w.x + 8;
  if (edge === 'right') x = w.x + w.width - width - 8;
  return { edge, x: Math.round(Math.max(w.x, Math.min(x, w.x+w.width-width))), y: Math.round(Math.max(w.y, Math.min(y,w.y+w.height-height))), width, height };
}
export const trayProgress = jobs => {
  const running = jobs.filter(j => j.state === 'running'), first = running[0];
  const percent = first?.total ? Math.max(0, Math.min(100, Math.round(first.done / first.total * 100))) : 0;
  return { count: running.length, percent, value: !first ? -1 : first.phase === 'encode' || !first.total ? 2 : percent / 100 };
};
