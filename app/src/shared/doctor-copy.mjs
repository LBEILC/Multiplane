import { t } from './i18n.mjs';

export function doctorCopy(check, { ffmpeg = true, packaged = false, environment = undefined } = {}) {
  const { name, ok } = check;
  const raw = String(check.detail ?? '');
  const fallback = () => ({ raw, hint: String(check.hint ?? '') });
  if (typeof ok !== 'boolean' || (check.status !== undefined && !['available', 'unavailable'].includes(check.status))) return fallback();
  const version = raw.match(name === 'node' ? /Node (v?\d+(?:\.\d+)*)/ : /Chromium (\d+(?:\.\d+)*)/)?.[1];
  const common = { status: ok ? 'available' : 'unavailable', values: {}, explanation: '', data: '' };
  switch (name) {
    case 'node': return { ...common, status: ok && version ? 'availableVersion' : ok ? 'available' : 'nodeTooOld', values: { version }, explanation: t('doctorNode'), data: ok ? '' : version ?? '' };
    case 'browser': return { ...common, status: ok && version ? 'availableVersion' : ok ? 'available' : raw === 'Chromium is not installed.' ? 'notInstalled' : 'unavailable', values: { version: version ? t('chromiumVersion', { version }) : '' }, explanation: t(ok ? 'doctorBrowserReady' : raw === 'Chromium is not installed.' ? 'doctorBrowserMissing' : 'doctorBrowserUnusable') };
    case 'gpu': return { ...common, status: ok ? 'hardwareAvailable' : 'softwareOnly', explanation: t(raw === 'GPU could not be inspected.' ? 'doctorGpuUnchecked' : 'doctorGpu'), data: raw.match(/^GPU renderer: (.*)\.$/)?.[1] ?? '' };
    case 'ffmpeg': return { ...common, status: ok ? 'available' : check.reason === 'missing-libx264' || check.reason === 'cannot-run' || check.reason === 'not-ffmpeg' || raw.includes('cannot run') ? 'unavailable' : 'notFound', explanation: t(ok ? 'doctorFfmpegReady' : check.reason === 'missing-libx264' ? 'doctorX264Missing' : check.reason === 'cannot-run' || raw.includes('cannot run') ? 'doctorFfmpegUnusable' : check.reason === 'not-ffmpeg' ? 'doctorNotFfmpeg' : 'doctorFfmpegMissing'), data: ok ? [raw, environment?.ffmpeg?.path].filter(Boolean).join('\n') : check.diagnostic ?? '' };
    case 'libx264': return { ...common, status: !ffmpeg ? 'dependsFfmpeg' : common.status, explanation: t(!ffmpeg ? 'doctorEncoderUnchecked' : ok ? 'doctorX264Ready' : 'doctorX264Missing') };
    case 'libvpx-vp9':
    case 'prores_ks': return { ...common, status: !ffmpeg ? 'dependsFfmpeg' : common.status, explanation: t(!ffmpeg ? 'doctorEncoderUnchecked' : 'doctorOptionalEncoder', { encoder: name }), data: '' };
    case 'three': {
      const version = raw.match(/^three\.js (\d+\.\d+\.\d+) is available/)?.[1];
      return { ...common, status: ok && version ? 'availableVersion' : ok ? 'available' : 'threeMissing', values: { version }, explanation: t('doctorThree'), data: ok && version ? t(raw.includes('(bundled with software)') ? 'threeBundled' : 'projectInstalled') : '' };
    }
    default: return fallback();
  }
}
