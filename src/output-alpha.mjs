import { spawn } from 'node:child_process';
import { stopChild } from './process.mjs';
import { MultiplaneError } from './errors.mjs';

export async function checkAlphaVideo(ffmpeg, file, format, references, width, height, events) {
  const indices = [...references.keys()];
  const pixels = width * height;
  // TODO(design): Document the maximum alpha error of 2/255 for encoded frames.
  const tolerance = 2;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error',
      ...(format === 'webm' ? ['-c:v', 'libvpx-vp9'] : []), '-i', file,
      '-map', '0:v:0', '-vf', `select=${indices.map(i => `eq(n\\,${i})`).join('+')},alphaextract`,
      '-fps_mode', 'passthrough', '-frames:v', String(indices.length), '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const unsubscribe = events?.onCancel?.(() => stopChild(child));
    let count = 0, maxError = 0, stderr = '', overflow = false;
    child.stdout.on('data', bytes => {
      for (const actual of bytes) {
        const reference = references.get(indices[Math.floor(count / pixels)]);
        if (!reference) overflow = true;
        else maxError = Math.max(maxError, Math.abs(actual - reference[count % pixels]));
        count++;
      }
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
    child.once('error', cause => reject(new MultiplaneError('output_invalid', 'Alpha could not be decoded.', { cause })));
    child.once('close', code => {
      unsubscribe?.();
      try { events?.check(); } catch (error) { reject(error); return; }
      if (code !== 0 || overflow || count !== pixels * indices.length || maxError > tolerance) {
        reject(new MultiplaneError('output_invalid', 'Decoded alpha does not match the source frames.', { details: { frames: indices, maxAlphaError: maxError, tolerance, decodedBytes: count, stderr } }));
      } else resolve({ frames: indices, maxAlphaError: maxError, tolerance });
    });
  });
}
