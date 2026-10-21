import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { processCreatedAt } from './process-identity.mjs';
import { MultiplaneError } from './errors.mjs';

const schema = 'multiplane-config-lock/1';
const ownerName = /^[0-9a-f-]{36}\.json$/;

async function removeEmpty(lock) {
  try { await fs.rmdir(lock); }
  catch (error) {
    // Never recursively remove a directory that may contain another owner.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

async function release(lock, name) {
  try { await fs.unlink(path.join(lock, name)); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
  await removeEmpty(lock);
}

async function recover(lock) {
  try {
    // Legacy empty files have no verifiable owner. Age alone is not proof
    // that a writer died, so leave them (and unrecognized locks) untouched.
    if (!(await fs.lstat(lock)).isDirectory()) return;
    const names = await fs.readdir(lock);
    // An empty or partial directory may belong to a writer initializing its
    // owner record. Only the successful marker remover may remove emptiness.
    if (names.length !== 1 || !ownerName.test(names[0])) return;
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(lock, names[0]), 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
    if (owner?.schema !== schema || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
    let dead = false;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code !== 'ESRCH') return; dead = true; }
    if (!dead && typeof owner.createdAt === 'string' && Number.isFinite(Date.parse(owner.createdAt))) {
      const current = await processCreatedAt(owner.pid);
      dead = current !== null && current !== owner.createdAt;
    }
    // The unique filename, not a stat/unlink comparison, protects a new
    // owner from a delayed release or a second concurrent recovery.
    if (dead) await release(lock, names[0]);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

export async function lockConfiguration(file, { timeout = 10000 } = {}) {
  const lock = file + '.lock', name = randomUUID() + '.json';
  // Resolve identity before acquiring the directory, not while it is empty.
  const owner = JSON.stringify({
    schema, host: hostname(), pid: process.pid, createdAt: await processCreatedAt(process.pid),
  }) + '\n';
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      // Unlike rename on Windows, mkdir never replaces a legacy lock file.
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      // The previous owner may release the lock before this inspection.
      try { await fs.lstat(lock); }
      catch (missing) {
        if (missing.code !== 'ENOENT') throw missing;
        if (performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      if (performance.now() >= deadline) {
        throw new MultiplaneError('config_locked', `Configuration is locked: ${lock}`, {
          cause: error, details: { path: lock },
          hint: 'Close other Multiplane processes and retry. If the lock remains, remove it only after confirming no process is changing settings.',
        });
      }
      await recover(lock);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { await fs.writeFile(path.join(lock, name), owner, { flag: 'wx' }); }
  catch (error) {
    // We acquired this directory and no contender can reclaim an unfinished
    // owner record. Clean up only our own file and the now-empty directory.
    await fs.rm(path.join(lock, name), { force: true });
    await removeEmpty(lock);
    throw error;
  }
  return () => release(lock, name);
}
