import { recoveryBudget } from './browser-recovery.mjs';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stopChild } from './process.mjs';
import { inspectFFmpeg } from './ffmpeg.mjs';
import { openShot, number } from './capture.mjs';
import { createPostCapture, resolveScale } from './post.mjs';
import { createRenderPool, defaultWorkers } from './render-pool.mjs';
import { encoderArgs } from './encoder.mjs';
import { writeFrame } from './video-pipe.mjs';
import { runCommand } from './events.mjs';
import { loaded, observeBrowser } from './environment.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { requireNewOutput, publishVideo } from './artifacts.mjs';
import { createPreview } from './preview.mjs';

export async function renderShot(shot, options = {}) {
  return runCommand('render', shot, options, async events => {
    options = { ...events.options };
    delete options.onEvent;
    options._browserRecovery = recoveryBudget();
    const name = path.basename(shot, path.extname(shot));
    let result;

    let capture, pool, encoder, temporary, cleaning, encoderClosed = false;
    function cleanup() { return cleaning ??= cleanResources(); }
    async function cleanResources() {
      try {
        if (encoder && !encoderClosed) await stopChild(encoder);
      } finally {
        try { await capture?.close(); }
        finally { try { await pool?.close(); } finally { if (temporary) await rm(temporary, { force: true }); } }
      }
    }

    try {
      const out = path.resolve(options.out ?? path.join(events.directory, `${name}.mp4`));
      if (!options.overwrite) await requireNewOutput(out);
      events.check();
      events.progress('launch');
      const { scale, renderScale } = resolveScale(options);
      const videoArgs = encoderArgs(options.encoder ?? 'x264', undefined, options['max-bitrate'] === undefined ? undefined : Number(options['max-bitrate']));
      const ffmpegInfo = await inspectFFmpeg(options.ffmpeg, process.env, { x264: 'libx264', 'nvenc-h264': 'h264_nvenc', 'nvenc-hevc': 'hevc_nvenc' }[options.encoder ?? 'x264']);
      const ffmpeg = ffmpegInfo.path;
      options.transport = 'raw';
      const workers = number(options.workers ?? defaultWorkers(scale), '--workers', { positive: true });
      if (!Number.isSafeInteger(workers)) throw invalidOption('--workers', '--workers must be a positive integer.');
      const audioOffset = number(options['audio-offset'] ?? 0, '--audio-offset');
      if (options['audio-offset'] !== undefined && !options.audio) throw invalidOption('--audio-offset', '--audio-offset requires --audio.');
      capture = await openShot(shot, renderScale, { ...options, onWarning: events.warning, check: events.check, onBrowser: observeBrowser(events, ffmpegInfo) });
      await loaded(events, capture, ffmpegInfo);
      const fps = number(options.fps ?? capture.fps, '--fps', { positive: true });
      const processed = createPostCapture(capture, options, fps);
      const from = number(options.from ?? 0, '--from');
      const to = number(options.to ?? capture.duration, '--to');
      if (to <= from || to > capture.duration) throw invalidOption('--to', 'Require 0 <= from < to <= shot duration.');
      const first = Math.ceil(from * fps - 1e-9);
      const end = Math.ceil(to * fps - 1e-9);
      const total = end - first;
      if (!total) throw invalidOption('--from', 'Range contains no frames.');
      const { width, height } = capture;
      events.progress('capture', 0, total);
      await capture.close(); capture = undefined;
      events.check();
      const actualWorkers = Math.min(workers, Math.ceil(total / 4));
      const started = performance.now();
      const frameHashes = process.env.RENDER_FRAME_HASHES ? [] : null;
      pool = createRenderPool(shot, options, fps, actualWorkers, { width, height }, events.warning);
      events.onCancel(() => pool?.cancel());
      await mkdir(path.dirname(out), { recursive: true });
      events.check();
      temporary = `${out}.${events.jobId}.partial.mp4`;
      const audioArgs = options.audio
        ? ['-i', path.resolve(options.audio), '-map', '0:v:0', '-map', '1:a:0', '-af', `atrim=start=${audioOffset + first / fps},asetpts=PTS-STARTPTS,apad,atrim=duration=${total / fps}`, '-c:a', 'aac', '-b:a', '320k', '-ac', '2']
        : ['-an'];
      encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width * scale}x${height * scale}`, '-framerate', String(fps), '-i', 'pipe:0', ...audioArgs, ...videoArgs, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      encoder.once('close', () => { encoderClosed = true; });
      events.onCancel(() => stopChild(encoder));
      let stderr = '', failure;
      encoder.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
      encoder.stdin.on('error', error => { failure = error; });
      const finished = new Promise((resolve, reject) => {
        encoder.once('error', cause => reject(new MultiplaneError('encode_failed', undefined, { cause, details: { reason: cause.message } })));
        encoder.once('close', code => code === 0 ? resolve() : reject(new MultiplaneError('encode_failed', undefined, { details: { exitCode: code, stderr } })));
      });
      finished.catch(error => { failure = error; });
      let encoderWriteMs = 0;
      // Internal switch for the pixel-equivalence and overhead tests, not a CLI option.
      const preview = createPreview(events, width * scale, height * scale, { enabled: options._preview !== false });
      for await (const { frame, png } of pool.frames(first, end)) {
        events.check();
        if (failure) throw new MultiplaneError('encode_failed', undefined, { cause: failure });
        frameHashes?.push({ frame, sha256: createHash('sha256').update(png).digest('hex') });
        await preview(png, frame);
        const writeStarted = performance.now();
        await writeFrame(encoder.stdin, png).catch(cause => { throw new MultiplaneError('encode_failed', undefined, { cause, details: { reason: cause.message } }); });
        encoderWriteMs += performance.now() - writeStarted;
        const done = frame - first + 1;
        events.progress('capture', done, total);
      }
      const drainStarted = performance.now();
      events.progress('encode', total, total);
      encoder.stdin.end();
      await finished;
      events.check();
      const encoderDrainMs = performance.now() - drainStarted;
      await publishVideo(temporary, out, options.overwrite);
      temporary = undefined;
      const elapsed = (performance.now() - started) / 1000;
      if (frameHashes) await writeFile(process.env.RENDER_FRAME_HASHES, JSON.stringify(frameHashes, null, 2));
      if (process.env.RENDER_PROFILE) await writeFile(process.env.RENDER_PROFILE, JSON.stringify({elapsed,frames:total,workers:actualWorkers,options,stats:pool.stats,encoderWriteMs,encoderDrainMs},null,2));
      events.artifact(out, 'video');
      result = { output: out, frames: total, fps, from, to, width: width * scale, height: height * scale, encoder: options.encoder ?? 'x264', post: { ...processed.post, adaptiveBlur: Number(options['adaptive-blur'] ?? 0.5) }, renderScale, scale };
    } finally { await cleanup(); }

    return result;
  });
}
