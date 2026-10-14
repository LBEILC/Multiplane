import { resolveQuality } from './post.mjs';
import { resolveFormat } from './format.mjs';
import path from 'node:path';
import { checkLint, scanShot } from './lint.mjs';
import { requireNewOutput, directoryOutput } from './artifacts.mjs';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, writeFileSync, existsSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { stopSignals, ffmpegName } from './platform.mjs';
import { asError, MultiplaneError, invalidOption } from './errors.mjs';
import { defaultWorkers } from './render-pool.mjs';
import { loadUserConfig, appendJobIndex, retryFileOperation } from './user-home.mjs';
import { userHome } from './platform.mjs';
import { applyDraft } from './draft.mjs';
import { createResourceSampler } from './resources.mjs';
import { hostedAvailable, hostedEnvironment, handoff, followJob } from './hosted.mjs';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
export const jobDirectory = (options = {}, env = process.env) => path.resolve(options['job-dir'] ?? env.MULTIPLANE_JOBS_DIR ?? 'out/jobs');

export function createEvents(command, shot, options = {}, job = false, deferStart = false) {
  const started = performance.now(), startedAt = new Date().toISOString();
  let directory, jobId, ended = false, lastProgress = -Infinity, stopped = false;
  const artifacts = [];
  if (job) {
    const stamp = startedAt.replaceAll('-', '').replaceAll(':', '').replace('T', '-').slice(0, 15);
    try {
      if (options['job-dir-exact']) {
        directory = path.resolve(options['job-dir-exact']);
        if (!statSync(directory).isDirectory()) throw Error('Missing executor job directory.');
        jobId = path.basename(directory);
      } else {
        mkdirSync(jobDirectory(options), { recursive: true });
        for (;;) {
          jobId = `${stamp}-${path.parse(shot).name}-${randomBytes(2).toString('hex')}`;
          directory = path.join(jobDirectory(options), jobId);
          try { mkdirSync(directory); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      }
      // Exercise actual file creation, writing and removal before launching a browser.
      const probe = path.join(directory, '.write-check');
      writeFileSync(probe, 'write check', { flag: 'wx' });
      unlinkSync(probe);
    } catch (cause) {
      throw new MultiplaneError('job_dir_unwritable', undefined, {
        cause, details: { path: jobDirectory(options) },
        hint: 'Use --job-dir or MULTIPLANE_JOBS_DIR to select a writable job directory.',
      });
    }
    options.out = path.resolve(options.out ?? (command === 'render' ? path.join(directory, `${path.parse(shot).name}.${options.format ?? 'mp4'}`) : path.join(directory, command)));
  }
  let state = { schema: 'multiplane/1', jobId, command, shot, pid: process.pid, state: 'running',
    phase: 'launch', done: 0, total: null, fps: null, etaMs: null, startedAt, updatedAt: startedAt, result: null, previewFrame: null, memoryBytes: null };
  const save = () => {
    if (!directory) return;
    const file = path.join(directory, 'status.json');
    const deadline = performance.now() + 1000;
    retryFileOperation(() => writeFileSync(file + '.tmp', JSON.stringify(state) + '\n'), deadline);
    retryFileOperation(() => renameSync(file + '.tmp', file), deadline);
  };
  let startedEvent = false;
  const pendingEvents = [];
  const emit = (type, fields = {}) => {
    if (deferStart && !startedEvent && type !== 'start') { pendingEvents.push([type, fields]); return; }
    if (ended) return;
    if (type === 'progress') {
      for (const key of ['phase', 'done', 'total', 'fps', 'etaMs']) state[key] = fields[key];
      state.updatedAt = new Date().toISOString();
      save();
      if (performance.now() - lastProgress < 250) return;
      lastProgress = performance.now();
    }
    const event = { schema: 'multiplane/1', type, command, ts: new Date().toISOString(), ...fields };
    if (type === 'progress') for (const key of ['phase', 'done', 'total', 'fps', 'etaMs']) state[key] = fields[key];
    if (type === 'result') { state.result = event; state.state = event.ok ? 'succeeded' : event.code === 'cancelled' ? 'cancelled' : 'failed'; ended = true; }
    state.updatedAt = event.ts;
    if (directory) appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify(event) + '\n');
    save();
    options.onEvent?.(event);
    return event;
  };
  const cancelHandlers = new Set();
  let homeWarned = false;
  const warning = fields => {
    if (fields.code === 'home_unavailable') { if (homeWarned) return; homeWarned = true; }
    emit('warning', fields);
  };
  const index = (event, fields) => {
    if (!directory || process.env.MULTIPLANE_NO_INDEX === '1') return;
    try { appendJobIndex(userHome(), { schema: 'multiplane/1', event, jobId, jobDir: directory, ...fields, ts: new Date().toISOString() }); }
    catch { warning({ code: 'home_unavailable', message: 'Job index could not be updated.' }); }
  };
  const requestStop = () => {
    if (stopped) return;
    stopped = true;
    for (const handler of cancelHandlers) Promise.resolve().then(handler).catch(() => {});
  };
  const signals = job ? stopSignals().map(signal => [signal, requestStop]) : [];
  let timer;
  const monitor = () => {
    if (!job || timer) return;
    for (const [signal, handler] of signals) process.on(signal, handler);
    timer = setInterval(() => { if (existsSync(path.join(directory, 'stop'))) requestStop(); }, 100);
    timer.unref();
  };
  if (!options._hostedCLI) monitor();
  return {
    directory, jobId, emit, warning, artifacts, options, monitor,
    // TODO(design): Document memoryBytes in status.json (latest sample, null on failure).
    memory(bytes) { state.memoryBytes = bytes; state.updatedAt = new Date().toISOString(); save(); },
    preview(frame) { state.previewFrame = frame; state.updatedAt = new Date().toISOString(); save(); },
    start(resolved = false) {
      if (startedEvent) return;
      if (deferStart && !resolved) { save(); return; }
      startedEvent = true;
      const { onEvent, _preview, _resources, _probeVideo, _inspectFFmpeg, _hostedCLI, ...effective } = options;
      emit('start', { version, shot, ...(jobId ? { jobId } : {}), options: effective, ...(this.workersSource ? { workersSource: this.workersSource } : {}) });
      index('start', { command, shot, pid: process.pid });
      for (const [type, fields] of pendingEvents.splice(0)) emit(type, fields);
    },
    check() { if (directory && existsSync(path.join(directory, 'stop'))) requestStop(); if (stopped) throw new MultiplaneError('cancelled'); },
    onCancel(handler) { cancelHandlers.add(handler); if (stopped) Promise.resolve().then(handler).catch(() => {}); return () => cancelHandlers.delete(handler); },
    progress(phase, done = 0, total = null) {
      const seconds = (performance.now() - started) / 1000, fps = done && seconds ? done / seconds : null;
      emit('progress', { phase, done, total, unit: 'frame', fps, etaMs: fps && total !== null ? Math.round((total - done) / fps * 1000) : null });
    },
    finalize() { emit('progress', { phase: 'finalize', done: state.done, total: state.total, unit: 'frame', fps: state.fps, etaMs: 0 }); },
    artifact(file, kind) { const artifact = { path: path.resolve(file), kind, bytes: statSync(file).size }; artifacts.push(artifact); emit('artifact', artifact); },
    finish(data = {}, error) {
      if (deferStart) this.start(true);
      const result = { command, ok: !error, code: error?.code ?? null, message: error?.message ?? null,
        ...(error?.hint ? { hint: error.hint } : {}), ...(error?.details ? { details: error.details } : {}),
        artifacts, elapsedMs: Math.round(performance.now() - started), ...(jobId ? { jobId } : {}), data };
      index('end', { state: !error ? 'succeeded' : error.code === 'cancelled' ? 'cancelled' : 'failed' });
      emit('result', result);
      return result;
    },
    dispose() { clearInterval(timer); cancelHandlers.clear(); for (const [signal, handler] of signals) process.off(signal, handler); },
  };
}

export async function runCommand(command, shot, options, action, job = true) {
  let events, resources, linted = false;
  try {
    const explicit = options;
    const user = loadUserConfig(command, options);
    options = user.options;
    if (['render', 'stills', 'verify'].includes(command)) {
      options.quality = resolveQuality(options);
      if (options.quality === 'draft') options.draft = true;
    }
    if (job || ['lint', 'inspect'].includes(command)) {
      if (typeof shot !== 'string' || !shot.trim()) throw invalidOption('shot', 'Provide a shot HTML path.');
      if (options.root !== undefined && typeof options.root !== 'string') throw invalidOption('--root', '--root must be a path.');
      shot = path.resolve(options.root ?? process.cwd(), shot);
    }
    const positive = ['scale', 'render-scale', 'fps', 'workers', 'motion-blur', 'max-motion-blur', 'every', 'max-bitrate'];
    for (const key of [...positive, 'from', 'to', 'shutter', 'grain', 'adaptive-blur', 'audio-offset', 'wait']) {
      if (options[key] === undefined) continue;
      const value = Number(options[key]);
      if (!String(options[key]).trim() || !Number.isFinite(value) || value < 0 || (positive.includes(key) && value === 0)
        || (['workers', 'motion-blur', 'max-motion-blur'].includes(key) && !Number.isSafeInteger(value))) throw invalidOption(`--${key}`, `Invalid value for --${key}.`);
      options[key] = value;
    }
    if (command === 'render') {
      // A saved MP4 preference must not override a requested fixed-codec container.
      const inferred = resolveFormat({ ...options, encoder: explicit.encoder });
      if (inferred !== 'mp4' && explicit.encoder === undefined) {
        delete options.encoder;
        user.config.applied = user.config.applied.filter(field => field !== 'encoder');
      }
      options.format = inferred;
    } else if (job && ['stills', 'verify'].includes(command)) {
      // TODO(design): Document PNG as the frame format reported by stills and verify.
      options.format = 'png';
    }
    const defaults = job ? { root: process.cwd(), raster: 'gpu', scale: 1, 'render-scale': Number(options.scale ?? 1), upscale: 'lanczos',
      'adaptive-blur': 0.5, 'no-post': false, 'no-lint': false, overwrite: false, 'job-dir': jobDirectory(options),
      ...(command === 'render' ? { from: 0, ...(options.format === 'mp4' ? { encoder: 'x264' } : {}), workers: defaultWorkers(Number(options.scale ?? 1)), ffmpeg: process.env.MULTIPLANE_FFMPEG ?? ffmpegName() } : {}),
      ...(command === 'verify' ? { workers: 2 } : {}),
      ...(command === 'stills' && options.at === undefined ? { every: 1 } : {}) }
      : ['lint', 'inspect', 'serve'].includes(command) ? { root: process.cwd() } : command === 'benchmark' ? { raster: 'gpu' }
        : command === 'doctor' ? { raster: 'gpu', ffmpeg: process.env.MULTIPLANE_FFMPEG ?? ffmpegName() }
        : { 'job-dir': jobDirectory(options), ...(command === 'cancel' ? { wait: 30 } : {}) };
    // TODO(design): Document that start waits for effective shot alpha defaults.
    events = createEvents(command, shot, { ...defaults, ...options }, job, job && ['render', 'stills', 'verify'].includes(command));
    events.config = user.config;
    if (command === 'render') events.workersSource = explicit.workers !== undefined ? 'option' : user.config.applied.includes('workers') ? 'config' : 'estimate';
    events.migration = user.migration;
    if (options['hosted-executor']) events.start();
    // Defer start events until the owner is known. Lint failure remains local.
    if (await hostedAvailable(command, options)) {
      if (!options['no-lint']) { await checkLint(shot, events.options, events); linted = true; }
      events.start();
      const request = { schema: 'multiplane/1', jobId: events.jobId, jobDir: events.directory,
        command, args: options._hostedCLI.args, cwd: process.cwd(), node: process.execPath,
        bin: options._hostedCLI.bin, env: hostedEnvironment(process.env), at: new Date().toISOString() };
      const ownership = await handoff(request);
      if (ownership.hosted) {
        const directory = events.directory;
        events.dispose(); events = undefined;
        return await followJob(directory, { onBytes: options._hostedCLI.onBytes });
      }
      process.stderr.write('Rendering locally: ' + ownership.reason + '\n');
    }
    // CLI transport callbacks must never enter workerData or shot evaluation.
    delete options._hostedCLI;
    delete events.options._hostedCLI;
    events.monitor();
    if (job) {
      resources = createResourceSampler({ enabled: options._resources !== false, onSample: events.memory });
      events.resources = resources;
    }
    if (options.draft) {
      // Keep lint and cancellation active before the dimension-only draft probe.
      if (!linted && !options['no-lint']) {
        const { findings, data } = await scanShot(shot, events.options);
        if (data.errors) {
          events.start();
          for (const finding of findings) events.emit('finding', finding);
          throw new MultiplaneError('lint_failed', undefined, { result: { data } });
        }
      }
      const normalized = { ...Object.fromEntries(Object.keys(explicit).filter(key => key !== '_hostedCLI').map(key => [key, options[key]])), draft: true };
      Object.assign(events.options, await applyDraft(command, shot, normalized, options, {
        check: events.check,
        onBrowser: browser => {
          const unsubscribe = events.onCancel(() => browser.close());
          browser.once('disconnected', unsubscribe);
          events.check();
        },
      }));
    }
    events.start();
    for (const warning of user.warnings) events.warning(warning);
    if ((job || command === 'inspect') && !linted && !options['no-lint']) await checkLint(shot, events.options, events);
    if (job && options.out && !options.overwrite) await requireNewOutput(path.resolve(options.out));
    const data = job && ['stills', 'verify'].includes(command) && options.out && options.overwrite
      ? await directoryOutput(events, action) : await action(events);
    events.check();
    if (job) events.finalize();
    if (resources) { await resources.stop(); data.resources = { ...resources.snapshot(), ...(events.workersSource ? { workersSource: events.workersSource } : {}) }; }
    if (['render', 'stills', 'verify'].includes(command)) data.quality = options.quality;
    return events.finish(data);
  } catch (failure) {
    let error = asError(failure);
    try { events?.check(); } catch (cancelled) { error = cancelled; }
    events ??= createEvents(command, shot, options);
    await resources?.stop();
    error.result = events.finish({ ...error.result?.data, ...(resources ? { resources: { ...resources.snapshot(), ...(events.workersSource ? { workersSource: events.workersSource } : {}) } } : {}) }, error);
    throw error;
  } finally { await resources?.stop(); events?.dispose(); }
}
