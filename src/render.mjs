import { readBenchmark, benchmarkMachine, selectWorkers, classifyShot } from './workers.mjs';
import { recoveryBudget } from './browser-recovery.mjs';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stopChild } from './process.mjs';
import { inspectFFmpeg } from './ffmpeg.mjs';
import { openShot, number } from './capture.mjs';
import { createPostCapture, resolveScale } from './post.mjs';
import { createRenderPool } from './render-pool.mjs';
import { resolveFormat, videoEncoding } from './format.mjs';
import { checkAlphaVideo } from './output-alpha.mjs';
import { writeFrame } from './video-pipe.mjs';
import { runCommand } from './events.mjs';
import { loaded, observeBrowser, environment } from './environment.mjs';
import { MultiplaneError, invalidOption } from './errors.mjs';
import { requireNewOutput, publishVideo } from './artifacts.mjs';
import { createPreview } from './preview.mjs';
import { checkVideo } from './output-check.mjs';
import { frameRate } from './frame-rate.mjs';

export async function renderShot(shot, options = {}) {
  return runCommand('render', shot, options, async events => {
    options = { ...events.options };
    delete options.onEvent;
    const probe = options._probeVideo;
    delete options._probeVideo;
    const inspect = options._inspectFFmpeg ?? inspectFFmpeg;
    delete options._inspectFFmpeg;
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
      const out = path.resolve(options.out ?? path.join(events.directory, `${name}.${options.format}`));
      if (!options.overwrite) await requireNewOutput(out);
      events.check();
      events.progress('launch');
      const { scale, renderScale } = resolveScale(options);
      const encoding = videoEncoding(options);
      let videoArgs = encoding.args;
      const ffmpegInfo = await inspect(options.ffmpeg, process.env, { x264: 'libx264', 'nvenc-h264': 'h264_nvenc', 'nvenc-hevc': 'hevc_nvenc' }[encoding.encoder] ?? encoding.encoder);
      const ffmpeg = ffmpegInfo.path;
      options.transport = 'raw';
      const audioOffset = number(options['audio-offset'] ?? 0, '--audio-offset');
      if (options['audio-offset'] !== undefined && !options.audio) throw invalidOption('--audio-offset', '--audio-offset requires --audio.');
      capture = await openShot(shot, renderScale, { ...options, onWarning: events.warning, check: events.check, onBrowser: observeBrowser(events, ffmpegInfo) });
      const record = ['option', 'config'].includes(events.workersSource) ? null : readBenchmark();
      let machine, type;
      if (!['option', 'config'].includes(events.workersSource)) type = await classifyShot(capture);
      if (record) {
        try {
          machine = benchmarkMachine(await environment(capture.browser), options.raster);
        } catch { /* Optional tuning must not prevent an otherwise valid render. */ }
      }
      const selection = selectWorkers({ workers: options.workers, source: events.workersSource, record, machine, type,
        scale, memoryScale: Math.max(scale, renderScale) });
      const workers = selection.workers;
      options.workers = events.options.workers = workers;
      // TODO(design): Document workersSource on start and result.data.resources.
      events.workersSource = selection.source;
      options.alpha = events.options.alpha = capture.alpha;
      resolveFormat(options);
      Object.assign(encoding, videoEncoding(options));
      videoArgs = encoding.args;
      await loaded(events, capture, ffmpegInfo);
      const fps = number(options.fps ?? capture.fps, '--fps', { positive: true });
      const rate = frameRate(fps);
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
      events.resources.setWorkers(actualWorkers);
      const started = performance.now();
      const frameHashes = process.env.RENDER_FRAME_HASHES ? [] : null;
      pool = createRenderPool(shot, options, fps, actualWorkers, { width, height }, events.warning,
        done => events.progress('capture', done, total));
      events.onCancel(() => pool?.cancel());
      await mkdir(path.dirname(out), { recursive: true });
      events.check();
      temporary = `${out}.${events.jobId}.partial.${options.format}`;
      const audioArgs = options.audio
        ? ['-i', path.resolve(options.audio), '-map', '0:v:0', '-map', '1:a:0', '-af', `atrim=start=${audioOffset + rate.seconds(first)},asetpts=PTS-STARTPTS,apad,atrim=duration=${rate.seconds(total)}`, ...encoding.audio]
        : ['-an'];
      // Supported since FFmpeg 5.1; older FFmpeg uses the global -vsync 0.
      // Do not add output -r: passthrough must neither drop nor duplicate frames.
      encoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width * scale}x${height * scale}`, '-framerate', rate.argument, '-i', 'pipe:0', ...audioArgs, ...videoArgs, '-fps_mode', 'passthrough', '-pix_fmt', encoding.pixelFormat, ...encoding.mux, temporary], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
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
      const alphaReferences = new Map();
      let encoderWriteMs = 0, framesSent = 0;
      // Internal switch for the pixel-equivalence and overhead tests, not a CLI option.
      const preview = createPreview(events, width * scale, height * scale, { enabled: options._preview !== false });
      for await (const { frame, png } of pool.frames(first, end, async ({ frame, png }) => {
        events.check();
        await preview(png, frame);
      })) {
        events.check();
        if (failure) throw new MultiplaneError('encode_failed', undefined, { cause: failure });
        if (options.alpha && (framesSent === 0 || framesSent === Math.floor(total / 2))) alphaReferences.set(framesSent, Buffer.from(png.filter((_, i) => i % 4 === 3)));
        frameHashes?.push({ frame, sha256: createHash('sha256').update(png).digest('hex') });
        const writeStarted = performance.now();
        await writeFrame(encoder.stdin, png).catch(cause => { throw new MultiplaneError('encode_failed', undefined, { cause, details: { reason: cause.message } }); });
        encoderWriteMs += performance.now() - writeStarted;
        framesSent++;
      }
      const drainStarted = performance.now();
      events.progress('encode', total, total);
      encoder.stdin.end();
      await finished;
      events.check();
      const encoderDrainMs = performance.now() - drainStarted;
      const probeStarted = performance.now();
      const outputCheck = await checkVideo(ffmpeg, temporary, { frames: framesSent, durationSeconds: rate.seconds(framesSent), width: width * scale, height: height * scale, fps: rate.fps, ...(options.alpha ? { alpha: true, format: options.format } : {}) }, events, probe);
      if (options.alpha) await checkAlphaVideo(ffmpeg, temporary, options.format, alphaReferences, width * scale, height * scale, events);
      const outputCheckMs = performance.now() - probeStarted;
      await publishVideo(temporary, out, options.overwrite);
      temporary = undefined;
      const elapsed = (performance.now() - started) / 1000;
      if (frameHashes) await writeFile(process.env.RENDER_FRAME_HASHES, JSON.stringify(frameHashes, null, 2));
      if (process.env.RENDER_PROFILE) await writeFile(process.env.RENDER_PROFILE, JSON.stringify({elapsed,frames:total,workers:actualWorkers,options,stats:pool.stats,encoderWriteMs,encoderDrainMs,outputCheckMs},null,2));
      events.artifact(out, 'video');
      result = { staticReuse: pool.staticReuse, blurSamples: pool.blurSamples, output: out, frames: framesSent, fps, from, to, width: width * scale, height: height * scale, encoder: encoding.encoder, format: options.format, alpha: options.alpha, post: { ...processed.post, adaptiveBlur: Number(options['adaptive-blur'] ?? 0.5) }, renderScale, scale, outputCheck };
    } finally { await cleanup(); }

    return options.draft ? { ...result, draft: true } : result;
  });
}
