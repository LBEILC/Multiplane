import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { userHome } from './platform.mjs';

const present = file => {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

// Use the writers' locks, including the config lock introduced in 038.
// Publish only complete copies, and recheck the destination under the lock.
export function migrateUserHome(env = process.env, platform = process.platform, home = os.homedir()) {
  const result = { migrated: [], warnings: [] };
  if (platform !== 'win32' || env.MULTIPLANE_HOME) return result;
  const directory = userHome(env, platform, home);
  const previous = path.win32.join(env.APPDATA || path.win32.join(env.USERPROFILE || home, 'AppData', 'Roaming'), 'multiplane');
  if (path.win32.resolve(previous).toLowerCase() === path.win32.resolve(directory).toLowerCase()) return result;
  for (const [lockName, names] of [['config.json.lock', ['config.json']], ['jobs.lock', ['jobs.jsonl', 'jobs.1.jsonl']]]) {
    let handle;
    const lock = path.join(directory, lockName);
    try {
      if (!names.some(name => !present(path.join(directory, name)) && present(path.join(previous, name)))) continue;
      mkdirSync(directory, { recursive: true });
      const deadline = performance.now() + 10000;
      for (;;) {
        try { handle = openSync(lock, 'wx'); break; }
        catch (error) {
          if (error.code !== 'EEXIST' || performance.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      for (const name of names) {
        const target = path.join(directory, name), source = path.join(previous, name);
        if (present(target) || !present(source)) continue;
        const temporary = target + '.' + randomUUID() + '.tmp';
        try {
          copyFileSync(source, temporary);
          renameSync(temporary, target);
          result.migrated.push({ name, source });
        } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      }
    } catch {
      result.warnings.push({ code: 'home_unavailable', message: 'User directory migration could not be completed.' });
    } finally {
      if (handle !== undefined) {
        closeSync(handle);
        try { unlinkSync(lock); } catch { result.warnings.push({ code: 'home_unavailable', message: 'User directory migration lock could not be removed.' }); }
      }
    }
  }
  return result;
}
