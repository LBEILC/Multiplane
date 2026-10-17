// Desktop projection of the public event protocol. No renderer imports.
export const warnings = ['browser_restarted', 'gpu_software_fallback', 'gpu_raster_jitter', 'resource_failed', 'preview_failed', 'output_unverified', 'static_reuse_disabled'];
export const phaseCopy = { launch: 'ph_launch', load: 'ph_load', capture: 'ph_capture', encode: 'ph_encode', compare: 'ph_compare', finalize: 'ph_finalize' };
export const phaseIcons = { launch: 'ri-window-line', load: 'ri-download-2-line', capture: 'ri-camera-lens-line', encode: 'ri-movie-2-line', compare: 'ri-contrast-2-line', finalize: 'ri-shield-check-line' };
export const formatName = value => ({ mp4: 'MP4', webm: 'WebM', mov: 'MOV' }[value] ?? value?.toUpperCase());
export const encoderName = value => ({ x264: 'H.264', 'nvenc-h264': 'H.264 (NVENC)', 'nvenc-hevc': 'HEVC (NVENC)', vp9: 'VP9', prores: 'ProRes' }[value] ?? value);
export function failureCopy(job) {
  if (job.lost) return ['lostT', job.stderr
    ? (job.command === 'render' ? 'lostOutputH' : 'lostOutputHNoResume')
    : (job.command === 'render' ? 'lostH' : 'lostHNoResume')];
  if (job.result?.code === 'render_threw') return ['failT', 'failH'];
  if (job.result?.code === 'nondeterministic_output') return ['verifyT', 'verifyH'];
  if (job.state === 'cancelled') return ['cancelT', 'cancelH'];
  return [job.command === 'verify' ? 'jobCheckFailed' : 'failT', null];
}
export const warningCopy = {
  browser_restarted: ['w_browser_restarted', 'w_browser_restartedH'],
  gpu_software_fallback: ['w_gpu_software_fallback', 'w_gpu_software_fallbackH'],
  gpu_raster_jitter: ['w_gpu_raster_jitter', 'w_gpu_raster_jitterH'],
  resource_failed: ['w_resource_failed', 'w_resource_failedH'],
  preview_failed: ['w_preview_failed', 'w_preview_failedH'],
  output_unverified: ['w_output_unverified', 'w_output_unverifiedH'],
  static_reuse_disabled: ['w_static_reuse_disabled', 'w_static_reuse_disabledH'],
};
export const artifactCopy = { video: 'ev_artifact_video', still: 'ev_artifact_still', 'contact-sheet': 'ev_artifact_contact-sheet', 'diff-image': 'ev_artifact_diff-image' };
export const groupCopy = { output: 'g_output', quality: 'g_quality', blur: 'g_blur', run: 'g_run', paths: 'g_paths' };
export const optionCopy = {
  format:'o_format', encoder:'o_encoder', alpha:'o_alpha', out:'o_out', audio:'o_audio', overwrite:'o_overwrite',
  quality:'o_quality', 'render-scale':'o_renderScale', scale:'o_scale', upscale:'o_upscale',
  'motion-blur':'o_motionBlur', 'max-motion-blur':'o_maxMotionBlur', 'adaptive-blur':'o_adaptive', 'no-post':'o_post',
  workers:'o_workers', raster:'o_raster', 'no-hosted':'o_hosted', from:'o_from', 'no-lint':'o_lint', root:'o_root', 'job-dir':'o_jobDir', ffmpeg:'o_ffmpeg',
  fps:'o_fps', draft:'o_draft', shutter:'o_shutter', grain:'o_grain', to:'o_to', at:'o_at', every:'o_every',
  'audio-offset':'o_audio-offset', 'max-bitrate':'o_max-bitrate', 'static-reuse':'o_static-reuse', 'no-static-reuse':'o_no-static-reuse',
};
export function projectPath(job) {
  const root = job.events.find(e => e.type === 'start')?.options?.root;
  const directory = job.shot.replace(/[/\\][^/\\]*$/, '');
  const path = typeof root === 'string' ? (/^(?:[A-Za-z]:[/\\]|[/\\])/.test(root) ? root : `${directory}/${root}`) : directory;
  const parts = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '.') continue;
    if (part === '..' && parts.length > 1) parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}
export function mergedEvents(events) {
  const result = [], phases = new Map();
  for (const e of events) {
    if (e.type === 'progress') {
      const index = phases.get(e.phase);
      if (index !== undefined) { result[index] = { ...e, ts: result[index].ts }; continue; }
      phases.set(e.phase, result.length);
    }
    result.push(e);
  }
  return result;
}
export function phaseTimes(events) {
  const phases = mergedEvents(events).filter(e => e.type === 'progress');
  const end = events.findLast(e => e.type === 'result');
  return phases.map((e, i) => ({ ...e, durationMs: phases[i + 1] || end ? Math.max(0, Date.parse((phases[i + 1] ?? end).ts) - Date.parse(e.ts)) : null }));
}
export const gpuName = renderer => String(renderer ?? '—').replace(/^ANGLE \([^,]+,\s*/, '').replace(/,\s*(?:D3D|OpenGL|Vulkan|Metal).*\)$/, '').replace(/\s*\(0x[\da-f]+\).*$/i, '').replace(/\s+Direct3D.*$/, '');
export const ffmpegVersion = version => String(version ?? '—').match(/(?:ffmpeg version\s+)?([^\s]+)/i)?.[1] ?? '—';
export const optionGroups = {
  output: ['format', 'encoder', 'alpha', 'out', 'audio', 'audio-offset', 'max-bitrate', 'overwrite'],
  quality: ['quality', 'draft', 'render-scale', 'scale', 'upscale', 'fps'],
  blur: ['motion-blur', 'max-motion-blur', 'adaptive-blur', 'shutter', 'grain', 'no-post'],
  run: ['workers', 'raster', 'no-hosted', 'from', 'to', 'at', 'every', 'no-lint', 'static-reuse', 'no-static-reuse'],
  paths: ['root', 'job-dir', 'ffmpeg'],
};
export const publicOptions = options => Object.entries(options ?? {}).filter(([key]) => Object.values(optionGroups).flat().includes(key));
const defaults = { raster: 'gpu', scale: 1, upscale: 'lanczos', 'adaptive-blur': .5, 'no-post': false, 'no-lint': false, overwrite: false, from: 0, quality: 'standard', draft: false, 'no-hosted': false, 'no-static-reuse': false, 'static-reuse': false };
export function commandArgs(job) {
  const options = job.events.find(e => e.type === 'start')?.options ?? {};
  const args = [job.command, job.shot];
  for (const [key, value] of publicOptions(options)) {
    if (value == null || value === false || String(value) === String(defaults[key])) continue;
    const extension = String(options.out ?? '').split('.').at(-1)?.toLowerCase();
    if (key === 'format' && (job.command !== 'render' || value === (['mp4','webm','mov'].includes(extension) ? extension : 'mp4'))) continue;
    if (key === 'encoder' && value === 'x264') continue;
    if (key === 'render-scale' && Number(value) === Number(options.scale ?? 1)) continue;
    if (key === 'every' && job.command === 'stills' && Number(value) === 1 && options.at == null) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(Array.isArray(value) ? value.join(',') : String(value));
  }
  return args;
}
// PowerShell on Windows and POSIX shells both support literal single-quoted arguments.
export function quoteArgument(value, platform) {
  if (/^[\w./:\\=-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", platform === 'win32' ? "''" : "'\"'\"'") + "'";
}
export const commandText = (job, platform) => ['multiplane', ...commandArgs(job).map(v => quoteArgument(v, platform))].join(' ');
