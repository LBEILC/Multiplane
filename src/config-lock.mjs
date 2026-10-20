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
    // Another writer may already have published its nonempty directory.
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
    if (!names.length) { await removeEmpty(lock); return; }
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
  const lock = file + '.lock', token = randomUUID();
  const staged = lock + '.' + token + '.tmp', name = token + '.json';
  await fs.mkdir(staged);
  try {
    await fs.writeFile(path.join(staged, name), JSON.stringify({
      schema, host: hostname(), pid: process.pid, createdAt: await processCreatedAt(process.pid),
    }) + '\n', { flag: 'wx' });
    const deadline = performance.now() + timeout;
    for (;;) {
      try {
        // Publish the owner and lock together. An existing nonempty lock
        // directory cannot be replaced, including on Windows.
        await fs.rename(staged, lock);
        return () => release(lock, name);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        // Windows can report EPERM for an occupied directory. The previous
        // owner may release it before this inspection, so retry that race too.
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
  } finally { await fs.rm(staged, { recursive: true, force: true }); }
}
