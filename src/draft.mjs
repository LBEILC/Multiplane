import { openShot, validateScale, number } from './capture.mjs';
import { invalidOption } from './errors.mjs';

export function draftScale(width, height, outputScale = 1) {
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  const limit = Math.floor(Math.min(0.5, outputScale) * a / 2);
  for (let units = limit; units > 0; units--) {
    const scale = 2 * units / a;
    if ([width * scale, height * scale].every(v => Number.isSafeInteger(v) && v > 0 && v % 2 === 0)) return scale;
  }
  validateScale(width, height, 0, '--render-scale');
}

export async function applyDraft(command, shot, explicit, configured, probe = {}) {
  if (!explicit.draft) return configured;
  if (!['render', 'stills'].includes(command)) throw invalidOption('--draft', '--draft is supported by render and stills.');
  const options = { ...configured, 'motion-blur': 1, grain: 0, upscale: 'lanczos', ...explicit, draft: true };
  if (options['no-post']) Object.assign(options, { 'motion-blur': 1, grain: 0, shutter: 0.5 });
  if (explicit['render-scale'] === undefined) {
    // TODO(design): Document the dimension preflight before start for --draft in the v1 protocol.
    // Load dimensions before start so the event describes the effective preset.
    const outputScale = number(options.scale ?? 1, '--scale', { positive: true });
    const capture = await openShot(shot, outputScale, { ...options, ...probe });
    try { options['render-scale'] = draftScale(capture.width, capture.height, outputScale); }
    finally { await capture.close(); }
  }
  return options;
}
