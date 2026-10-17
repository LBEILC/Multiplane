import { link, rm, writeFile, access, rename, mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MultiplaneError } from './errors.mjs';

const outputError = (error, file) => {
  if (error.code === 'EEXIST') throw new MultiplaneError('output_exists', undefined, { details: { path: file }, hint: 'Choose a new output path.' });
  throw error;
};
export async function requireNewOutput(file) {
  try { await access(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new MultiplaneError('output_exists', undefined, { details: { path: file }, hint: 'Choose a new output path.' });
}
export async function writeArtifact(file, bytes) {
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) { outputError(error, file); }
}
export async function publishVideo(temporary, file, overwrite = false, { linkFile = link, move = rename, remove = rm } = {}) {
  if (overwrite) { await move(temporary, file); return; }
  try { await linkFile(temporary, file); }
  catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) outputError(error, file);
    // The temporary video is in the output directory, so rename publishes it whole.
    // Accept the short race between checking the target and renaming.
    await requireNewOutput(file);
    try { await move(temporary, file); }
    catch (moveError) { outputError(moveError, file); }
    return;
  }
  await remove(temporary);
}

// Build a replacement directory in isolation; publish only after the whole command succeeds.
export async function directoryOutput(events, action) {
  const target = events.options.out;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = await mkdtemp(target + '.partial-');
  const backup = temporary + '.previous';
  const artifacts = [], artifact = events.artifact;
  const relocate = value => {
    if (typeof value === 'string' && value.startsWith(temporary + path.sep)) return target + value.slice(temporary.length);
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v)]));
    return value;
  };
  events.options.out = temporary;
  events.artifact = (file, kind) => artifacts.push([file, kind]);
  let saved = false, committed = false, keepTemporary = false;
  try {
    const data = await action(events);
    events.check();
    try { await rename(target, backup); saved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(temporary, target); }
    catch (error) { const restore = saved; saved = false; if (restore) await rename(backup, target); throw error; }
    committed = true;
    for (const [file, kind] of artifacts) artifact(relocate(file), kind);
    return relocate(data);
  } catch (error) {
    // Keep completed diagnostic artifacts addressable when verification fails.
    keepTemporary = artifacts.length > 0;
    if (keepTemporary && !committed) for (const [file, kind] of artifacts) artifact(file, kind);
    throw error;
  } finally {
    events.options.out = target; events.artifact = artifact;
    if (!keepTemporary) await rm(temporary, { recursive: true, force: true });
    if (saved && committed) await rm(backup, { recursive: true, force: true });
  }
}
