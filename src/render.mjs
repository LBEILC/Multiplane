import { readBenchmark, benchmarkMachine, selectWorkers, classifyShot } from './workers.mjs';
import { recoveryBudget } from './browser-recovery.mjs';
import path from 'node:path';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stopChild } from './process.mjs';
import { inspectFFmpeg } from './ffmpeg.mjs';
import { openShot, number } from './capture.mjs';
import { createPostCapture, resolveScale } from './post.mjs';
import { createRenderPool } from './render-pool.mjs';
import { resolveFormat, videoEncoding } from './format.mjs';
import { checkAlphaVideo } from './output-alpha.mjs';
import { inputRecords, recordInput } from './input-records.mjs';
import { atomicJSON, lockSegments, manifestStore, checkInputs, checkEnvironment, reusableSegments, readManifest, unavailable } from './segments.mjs';
import { segmentEncoder, assembleSegments } from './segment-encoder.mjs';
import { version, runCommand } from './events.mjs';
import { loaded, observeBrowser, environment } from './environment.mjs';
import { invalidOption } from './errors.mjs';
import { requireNewOutput, publishVideo } from './artifacts.mjs';
import { createPreview } from './preview.mjs';
import { checkVideo } from './output-check.mjs';
import { frameRate } from './frame-rate.mjs';

const persistedOptions = options => Object.fromEntries(Object.entries(options).filter(([key, value]) =>
  !key.startsWith('_') && typeof value !== 'function' && !['job-dir-exact', 'hosted-executor'].includes(key)));

export async function renderShot(shot, options = {}) {
  return runCommand('render', shot, options, async events => inputRecords.run(null, async () => {
    options = { ...events.options };
    delete options.onEvent;
    const resume = options._resume; delete options._resume;
    const hook = options._segmentHook; delete options._segmentHook;
    const segmentFrames = options._segmentFrames; delete options._segmentFrames;
    delete options._effectiveOptions;
    const probe = options._probeVideo;
    delete options._probeVideo;
    const inspect = options._inspectFFmpeg ?? inspectFFmpeg;
    delete options._inspectFFmpeg;
    options._browserRecovery = recoveryBudget();
    const name = path.basename(shot, path.extname(shot));
    let result;

    let capture, pool, temporary, cleaning, store, directory, release, movedSource;
    const encoders = new Set(), pending = [];
    const inputs = {};
    const onInput = (file, record) => { if (store) store.input(file, record); else inputs[file] = record; };
    inputRecords.enterWith(onInput);
    function cleanup() { return cleaning ??= cleanResources(); }
    async function cleanResources() {
      try {
        await Promise.all([...encoders].map(encoder => stopChild(encoder)));
        await Promise.allSettled(pending);
      } finally {
        try { await capture?.close(); }
        finally { try { await pool?.close(); } finally {
          try {
            if (temporary && movedSource) await rename(temporary, movedSource);
            else if (temporary) await rm(temporary, { force: true });
          } finally { release?.(); }
        } }
      }
    }

    try {
      if (resume) {
        directory = resume.directory;
        release ??= lockSegments(directory);
        resume.manifest = readManifest(directory);
        if (!resume.manifest) throw unavailable('missing_manifest');
        atomicJSON(path.join(events.directory, 'resume.json'), { directory });
        await checkInputs(resume.manifest);
      }
      const out = path.resolve(options.out ?? path.join(events.directory, `${name}.${options.format}`));
      if (!resume) {
        directory = path.join(events.directory, 'segments');
        release = lockSegments(directory);
        // A launch failure can be retried even before metadata or a first frame
        // exists. Replace this provisional record with effective values below.
        store = manifestStore(directory, { schema: 'multiplane-segments/1', jobId: events.jobId,
          shot: path.resolve(options.root, shot), options: persistedOptions({ ...options, out,
            audio: options.audio ? path.resolve(options.audio) : undefined }),
          environment: null, first: 0, end: 0, total: 0, segmentFrames: segmentFrames ?? null, inputs: {}, segments: [] });
        store.save();
        await recordInput(path.resolve(options.root, shot));
        if (options.audio) await recordInput(path.resolve(options.audio));
      }
      if (!options.overwrite) await requireNewOutput(out);
      events.check();
      events.progress('launch');
      const { scale, renderScale } = resolveScale(options);
      const encoding = videoEncoding(options);

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
      directory = resume?.directory ?? path.join(events.directory, 'segments');
      release ??= lockSegments(directory);
      const info = await environment(capture.browser);
      const currentEnvironment = { multiplane: version, chromium: info.chromium, raster: options.raster,
        renderer: info.gpu.renderer, ffmpeg: ffmpegInfo.version, encoder: encoding.encoder };
      const effective = { ...options, fps, from, to, out, ffmpeg, audio: options.audio ? path.resolve(options.audio) : undefined,
        'motion-blur': processed.post.motionBlur, 'max-motion-blur': processed.post.maxMotionBlur,
        shutter: processed.post.shutter, grain: processed.post.grain };
      const savedOptions = persistedOptions(effective);
      let manifest;
      if (resume) {
        manifest = resume.manifest;
        checkEnvironment(manifest.environment, currentEnvironment);
        if (manifest.environment && manifest.environment.renderer !== currentEnvironment.renderer) {
          events.warning({ code: 'resume_renderer_changed', message: 'GPU renderer changed since the original render.',
            details: { before: manifest.environment.renderer, after: currentEnvironment.renderer } });
        }
        await checkInputs(manifest);
        manifest.segments = await reusableSegments(directory, manifest);
        if (!manifest.environment) Object.assign(manifest, { environment: currentEnvironment, options: savedOptions,
          first, end, total, segmentFrames: manifest.segmentFrames ?? Math.max(1, Math.round(fps * 10)) });
      } else {
        manifest = { schema: 'multiplane-segments/1', jobId: events.jobId, shot: path.resolve(options.root, shot),
          options: savedOptions, environment: currentEnvironment, first, end, total,
          segmentFrames: segmentFrames ?? Math.max(1, Math.round(fps * 10)), inputs: store.manifest.inputs, segments: [] };
      }
      if (!Number.isSafeInteger(manifest.segmentFrames) || manifest.segmentFrames < 1) throw invalidOption('_segmentFrames', 'Segment size must be a positive integer.');
      store = manifestStore(directory, manifest);
      for (const [file, record] of Object.entries(inputs)) store.input(file, record);
      if (options.audio) await recordInput(path.resolve(options.audio));
      store.save();
      const framesReused = manifest.segments.reduce((sum, segment) => sum + segment.end - segment.first, 0);
      const resumeData = resume ? { resumedFrom: resume.jobId, resume: { segmentsReused: manifest.segments.length, framesReused } } : {};
      events.resumeData = resumeData;
      if (resume) atomicJSON(path.join(events.directory, 'resume.json'), { directory });
      await loaded(events, capture, ffmpegInfo);
      events.progress('capture', framesReused, total);
      await capture.close(); capture = undefined;
      events.check();
      const actualWorkers = Math.min(workers, Math.max(1, Math.ceil((total - framesReused) / 4)));
      events.resources.setWorkers(actualWorkers);
      const started = performance.now();
      const frameHashes = process.env.RENDER_FRAME_HASHES ? [] : null;
      options._recordInputs = true;
      pool = createRenderPool(shot, options, fps, actualWorkers, { width, height }, events.warning,
        done => events.progress('capture', done + framesReused, total), onInput);
      events.onCancel(() => pool?.cancel());
      await mkdir(path.dirname(out), { recursive: true });
      temporary = out + '.' + events.jobId + '.partial.' + options.format;
      const alphaReferences = new Map();
      let encoderWriteMs = 0, framesSent = total, sealingFailure;
      const preview = createPreview(events, width * scale, height * scale, { enabled: options._preview !== false });
      const remember = segment => {
        frameHashes?.push(...(segment.frameHashes ?? []));
        for (const [frame, bytes] of Object.entries(segment.alphaReferences ?? {})) alphaReferences.set(Number(frame), Buffer.from(bytes, 'base64'));
      };
      // Keep workers busy while the preceding encoder drains and seals.
      const ranges = [];
      for (let start = first, index = 0; start < end; start += manifest.segmentFrames, index++) {
        const stop = Math.min(end, start + manifest.segmentFrames);
        const reused = manifest.segments.find(item => item.first === start && item.end === stop);
        if (reused) { remember(reused); continue; }
        ranges.push({ first: start, end: stop, index });
      }
      for (let cursor = 0; cursor < ranges.length;) {
        let last = cursor;
        while (last + 1 < ranges.length && ranges[last].end === ranges[last + 1].first) last++;
        let active, hashes, references, rangeIndex = cursor;
        for await (const { frame, png } of pool.frames(ranges[cursor].first, ranges[last].end)) {
          events.check();
          if (sealingFailure) throw sealingFailure;
          if (!active) {
            active = segmentEncoder({ ffmpeg, directory, ...ranges[rangeIndex], width: width * scale, height: height * scale,
              rate, encoding, format: options.format, events, store, hook });
            encoders.add(active.child);
            active.finished.finally(() => encoders.delete(active.child)).catch(() => {});
            hashes = []; references = {};
          }
          await preview(png, frame);
          const relative = frame - first;
          if (options.alpha && (relative === 0 || relative === Math.floor(total / 2))) references[relative] = Buffer.from(png.filter((_, i) => i % 4 === 3)).toString('base64');
          if (frameHashes) hashes.push({ frame, sha256: createHash('sha256').update(png).digest('hex') });
          const writeStarted = performance.now();
          await active.write(png);
          encoderWriteMs += performance.now() - writeStarted;
          if (frame + 1 === ranges[rangeIndex].end) {
            const sealed = active.seal({ ...(frameHashes ? { frameHashes: hashes } : {}), ...(options.alpha ? { alphaReferences: references } : {}) }).then(remember);
            sealed.catch(error => { sealingFailure ??= error; });
            pending.push(sealed);
            // Hooks model interruption at an exact durable boundary in tests.
            if (hook) await sealed;
            active = undefined; rangeIndex++;
          }
        }
        cursor = last + 1;
      }
      const drainStarted = performance.now();
      events.progress('encode', total, total);
      await Promise.all(pending);
      // Finish all resource requests before the final input audit/publication.
      await pool.close();
      events.check();
      await checkInputs(manifest);
      movedSource = await assembleSegments({ ffmpeg, directory, manifest, temporary, encoding, rate, audioOffset, events });
      const encoderDrainMs = performance.now() - drainStarted;
      const probeStarted = performance.now();
      const outputCheck = await checkVideo(ffmpeg, temporary, { frames: framesSent, durationSeconds: rate.seconds(framesSent), width: width * scale, height: height * scale, fps: rate.fps, ...(options.alpha ? { alpha: true, format: options.format } : {}) }, events, probe);
      if (options.alpha) await checkAlphaVideo(ffmpeg, temporary, options.format, alphaReferences, width * scale, height * scale, events);
      const outputCheckMs = performance.now() - probeStarted;
      await publishVideo(temporary, out, options.overwrite);
      temporary = undefined;
      // Invalidate the checkpoint while still holding the lock, so another
      // resume cannot reuse a manifest whose output has already been published.
      await rm(path.join(directory, 'manifest.json'), { force: true });
      await rm(directory, { recursive: true, force: true });
      release(); release = undefined;
      const elapsed = (performance.now() - started) / 1000;
      if (frameHashes) await writeFile(process.env.RENDER_FRAME_HASHES, JSON.stringify(frameHashes.sort((a, b) => a.frame - b.frame), null, 2));
      if (process.env.RENDER_PROFILE) await writeFile(process.env.RENDER_PROFILE, JSON.stringify({elapsed,frames:total,workers:actualWorkers,options,stats:pool.stats,encoderWriteMs,encoderDrainMs,outputCheckMs},null,2));
      events.artifact(out, 'video');
      result = { ...resumeData, staticReuse: pool.staticReuse, blurSamples: pool.blurSamples, dofSamples: pool.dofSamples, output: out, frames: framesSent, fps, from, to, width: width * scale, height: height * scale, encoder: encoding.encoder, format: options.format, alpha: options.alpha, post: { ...processed.post, adaptiveBlur: Number(options['adaptive-blur'] ?? 0.5) }, renderScale, scale, outputCheck };
    } finally { await cleanup(); }

    return options.draft ? { ...result, draft: true } : result;
  }));
}
