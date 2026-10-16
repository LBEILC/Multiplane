import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, fsyncSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileDigest } from './input-records.mjs';
import { MultiplaneError } from './errors.mjs';
import { retryFileOperation } from './user-home.mjs';

export const unavailable = (reason, changes) => new MultiplaneError('resume_unavailable', undefined,
  { details: { reason, ...(changes ? { changes } : {}) } });

// TODO(design): Document the checkpoint schema and resume.json directory pointer.

export function atomicJSON(file, data) {
  const temporary = file + '.tmp';
  const fd = openSync(temporary, 'w');
  try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  retryFileOperation(() => renameSync(temporary, file), performance.now() + 1000);
}

export function segmentDirectory(jobDir) {
  try {
    const { directory } = JSON.parse(readFileSync(path.join(jobDir, 'resume.json'), 'utf8'));
    if (!path.isAbsolute(directory) || path.basename(directory) !== 'segments') throw Error('Invalid segment directory.');
    return directory;
  }
  catch { return path.join(jobDir, 'segments'); }
}

export function readManifest(directory) {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (value.schema !== 'multiplane-segments/1' || !value.options || !Array.isArray(value.segments) || !value.inputs) return null;
    if (typeof value.shot !== 'string' || !Number.isSafeInteger(value.first) || value.first < 0
      || !Number.isSafeInteger(value.end) || value.end < value.first || value.total !== value.end - value.first
      || (value.segmentFrames !== null && (!Number.isSafeInteger(value.segmentFrames) || value.segmentFrames < 1))) return null;
    const starts = new Set();
    for (const segment of value.segments) {
      if (!Number.isSafeInteger(segment.first) || segment.first < value.first || segment.first >= value.end
        || (segment.first - value.first) % value.segmentFrames !== 0
        || segment.end !== Math.min(value.end, segment.first + value.segmentFrames)
        || starts.has(segment.first) || typeof segment.file !== 'string' || segment.file !== path.basename(segment.file)) return null;
      starts.add(segment.first);
    }
    return value;
  } catch { return null; }
}

export function lockSegments(directory) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'render.lock');
  for (;;) {
    let fd;
    try { fd = openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const before = statSync(file);
        let owner;
        try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Do not steal a lock being written. */ }
        let dead = false;
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
        }
        if (dead || (!owner && Date.now() - before.mtimeMs > 10000)) {
          const after = statSync(file);
          if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) unlinkSync(file);
          continue;
        }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw unavailable('running');
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    return () => { try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  }
}

export function manifestStore(directory, manifest) {
  const save = () => atomicJSON(path.join(directory, 'manifest.json'), manifest);
  return { manifest, save,
    input(file, record) {
      const previous = manifest.inputs[file];
      if (previous && previous.sha256 !== record.sha256) throw unavailable('inputs_changed', [file]);
      if (!previous) { manifest.inputs[file] = record; save(); }
    },
  };
}

export async function checkInputs(manifest) {
  const changes = [];
  for (const [file, expected] of Object.entries(manifest.inputs)) {
    try { if (await fileDigest(file) !== expected.sha256) changes.push(file); }
    catch { changes.push(file); }
  }
  if (changes.length) throw unavailable('inputs_changed', changes);
}

export function checkEnvironment(expected, actual) {
  if (!expected) return;
  const changes = Object.keys(actual).filter(key => key !== 'renderer' && JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
  if (changes.length) throw unavailable('environment_changed', changes);
}

export async function reusableSegments(directory, manifest) {
  const valid = [];
  for (const segment of manifest.segments) {
    if (segment.file !== path.basename(segment.file)) continue;
    try {
      const file = path.join(directory, segment.file);
      if ((await stat(file)).size === segment.bytes && await fileDigest(file) === segment.sha256) valid.push(segment);
    } catch { /* Missing or damaged segments are rendered again. */ }
  }
  return valid;
}

export function resumeStatus(status, directory) {
  const manifest = readManifest(segmentDirectory(directory));
  // TODO(design): Specify missing_manifest for legacy, missing or invalid checkpoints.
  const reason = status.state === 'succeeded' ? 'succeeded' : !['failed', 'cancelled'].includes(status.state) ? 'running' : !manifest ? 'missing_manifest' : null;
  return { available: reason === null, reason,
    framesDone: manifest?.segments.reduce((sum, segment) => sum + segment.end - segment.first, 0)
      ?? (status.state === 'succeeded' ? status.result?.data?.frames ?? status.done ?? 0 : 0),
    framesTotal: manifest?.total ?? status.total ?? status.result?.data?.frames ?? 0 };
}
