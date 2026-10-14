import path from 'node:path';
import { openShot, number } from './capture.mjs';
import { runCommand } from './events.mjs';
import { frameRate } from './frame-rate.mjs';
import { invalidOption } from './errors.mjs';

export async function inspectShot(shot, options = {}) {
  return runCommand('inspect', shot, options, async events => {
    const capture = await openShot(shot, 1, events.options);
    try {
      const { duration, width, height, cuts, post, hasBlurAt, meta } = capture;
      const fps = number(events.options.fps ?? capture.fps, '--fps', { positive: true });
      frameRate(fps);
      const frames = Math.ceil(duration * fps - 1e-9);
      if (!frames) throw invalidOption('--from', 'Range contains no frames.');
      return { shot: path.resolve(events.options.root, shot), duration, fps, frames,
        stage: { width, height }, cuts, post, hasBlurAt, meta };
    } finally { await capture.close(); }
  }, false);
}
