import { spawn } from 'node:child_process';
import { MultiplaneError } from './errors.mjs';
import { ffmpegName, ffmpegHint } from './platform.mjs';

export function ffmpegOutput(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('close', () => clearTimeout(timer));
    child.once('error', () => clearTimeout(timer));
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`FFmpeg exited with code ${code}.`)));
  });
}
export async function inspectFFmpeg(explicit, env = process.env, encoder) {
  const executable = explicit ?? env.MULTIPLANE_FFMPEG ?? ffmpegName();
  try {
    const version = (await ffmpegOutput(executable, ['-version'], env)).split(/\r?\n/)[0];
    if (encoder && !new RegExp(`\\b${encoder}\\b`).test(await ffmpegOutput(executable, ['-encoders'], env))) throw new Error(`Missing encoder: ${encoder}`);
    return { path: executable, version };
  } catch (cause) {
    throw new MultiplaneError(cause.code === 'ENOENT' ? 'ffmpeg_not_found' : 'ffmpeg_unusable', undefined,
      { cause, hint: ffmpegHint(), details: { reason: cause.message } });
  }
}

export async function resolveFFmpeg(explicit, env = process.env) {
  return (await inspectFFmpeg(explicit, env)).path;
}
