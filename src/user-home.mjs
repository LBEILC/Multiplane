import path from 'node:path';
import { readFileSync, mkdirSync, statSync, renameSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { userHome } from './platform.mjs';
import { encoders } from './encoder.mjs';

const fields = {
  ffmpeg: ['ffmpeg', v => typeof v === 'string' && !!v.trim() && !v.includes('\0')],
  jobsDir: ['job-dir', v => typeof v === 'string' && !!v.trim() && !v.includes('\0')],
  raster: ['raster', v => ['gpu', 'software'].includes(v)],
  encoder: ['encoder', v => encoders.includes(v)],
  workers: ['workers', v => Number.isSafeInteger(v) && v > 0],
};
const supported = command => command === 'render' ? Object.keys(fields)
  : command === 'doctor' ? ['ffmpeg', 'raster'] : command === 'verify' ? ['jobsDir', 'raster', 'workers']
    : command === 'stills' ? ['jobsDir', 'raster'] : ['status', 'cancel'].includes(command) ? ['jobsDir'] : [];

// Share one bounded retry budget across lock acquisition and index operations.
export function retryFileOperation(operation, deadline, { platform = process.platform, now = () => performance.now(), sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  let delay = 10;
  for (;;) {
    try { return operation(); }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || remaining <= 0) throw error;
      sleep(Math.min(delay, remaining)); delay = Math.min(100, delay * 2);
    }
  }
}

export function loadUserConfig(command, explicit = {}, env = process.env) {
  const directory = userHome(env), file = path.join(directory, 'config.json'), warnings = [];
  const config = { path: file, exists: false, applied: [] }, values = {};
  const invalid = field => warnings.push({ code: 'config_invalid', message: `Invalid user configuration field: ${field}.`, details: { field } });
  let data;
  try {
    statSync(file); config.exists = true;
    const text = readFileSync(file, 'utf8');
    try { data = JSON.parse(text); }
    // "$" identifies an invalid whole config document.
    catch { invalid('$'); }
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push({ code: 'home_unavailable', message: 'User configuration could not be read.' });
  }
  if (data !== undefined) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('$');
    else {
      if (data.schema != null && data.schema !== 'multiplane/1') invalid('schema');
      for (const [field, [key, validate]] of Object.entries(fields)) {
        if (data[field] == null) continue;
        if (!validate(data[field])) { invalid(field); continue; }
        if (!supported(command).includes(field)) continue;
        const environment = field === 'ffmpeg' ? env.MULTIPLANE_FFMPEG : field === 'jobsDir' ? env.MULTIPLANE_JOBS_DIR : undefined;
        if (explicit[key] === undefined && environment === undefined) { values[key] = data[field]; config.applied.push(field); }
      }
    }
  }
  if (supported(command).includes('ffmpeg') && env.MULTIPLANE_FFMPEG !== undefined) values.ffmpeg = env.MULTIPLANE_FFMPEG;
  if (supported(command).includes('jobsDir') && env.MULTIPLANE_JOBS_DIR !== undefined) values['job-dir'] = env.MULTIPLANE_JOBS_DIR;
  return { directory, config, warnings, options: { ...values, ...explicit } };
}

// Serialize rotation and append together, recovering abandoned locks.
export function appendJobIndex(directory, record, { limit = 10 * 1024 * 1024, timeout = 1000 } = {}) {
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'jobs.lock'), file = path.join(directory, 'jobs.jsonl');
  const deadline = performance.now() + Math.min(1000, timeout);
  const retry = operation => retryFileOperation(operation, deadline);
  let handle;
  for (;;) {
    try { handle = retry(() => openSync(lock, 'wx')); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = retry(() => statSync(lock));
        let owner;
        try { owner = JSON.parse(retry(() => readFileSync(lock, 'utf8'))); } catch { /* A new owner may still be writing. */ }
        let dead = false;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        }
        if (dead || Date.now() - info.mtimeMs > 10000) {
          const current = retry(() => statSync(lock));
          if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) retry(() => unlinkSync(lock));
          continue;
        }
      } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (performance.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    retry(() => writeSync(handle, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n'));
    let size = 0;
    try { size = retry(() => statSync(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size > limit) retry(() => renameSync(file, path.join(directory, 'jobs.1.jsonl')));
    const fd = retry(() => openSync(file, 'a'));
    try {
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (retry(() => writeSync(fd, bytes)) !== bytes.length) throw new Error('Incomplete index append.');
    } finally { closeSync(fd); }
  } finally { closeSync(handle); retry(() => unlinkSync(lock)); }
}
