import { execFile } from 'node:child_process';
import path from 'node:path';
import { readlink } from 'node:fs/promises';
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));

export async function processIdentity(pid, { platform = process.platform, runCommand = run, readExecutable = readlink } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const value = JSON.parse(await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; @{createdAt=$p.StartTime.ToUniversalTime().ToString('o'); executable=$p.Path} | ConvertTo-Json -Compress`]));
      return { pid, createdAt: new Date(value.createdAt).toISOString(), executable: value.executable };
    }
    const createdAt = new Date(await runCommand('ps', ['-p', String(pid), '-o', 'lstart=']) + ' UTC').toISOString();
    let executable;
    if (platform === 'linux') {
      try { executable = await readExecutable(`/proc/${pid}/exe`); }
      catch { executable = (await runCommand('ps', ['-p', String(pid), '-o', 'args='])).trim().split(/\s+/)[0]; }
    } else executable = await runCommand('ps', ['-p', String(pid), '-o', 'comm=']);
    return { pid, createdAt, executable };
  } catch { return null; }
}
export function matchesJob(identity, job) {
  const age = Date.parse(job.startedAt) - Date.parse(identity?.createdAt);
  return identity?.pid === job.pid && /^(node|electron|multiplane|multiplane-runtime)(\.exe)?$/i.test(path.basename(identity.executable ?? '')) && age >= 0 && age <= 60000;
}
// Unknown is deliberately distinct from a confirmed exit.
export function processPresence(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
export function createJobAlive({ inspect = processIdentity, presence = processPresence } = {}) {
  const identities = new Map();
  return async (pid, job) => {
    let present;
    try { present = presence(pid); } catch { return null; }
    if (present === false) { identities.delete(pid); return false; }
    if (present !== true) return null;
    let entry = identities.get(pid);
    if (!entry || entry.startedAt !== job.startedAt) {
      entry = { startedAt: job.startedAt, identity: Promise.resolve().then(() => inspect(pid)).catch(() => null) };
      identities.set(pid, entry);
    }
    const identity = await entry.identity;
    // A failed identity query or a mismatch cannot establish that the PID exited.
    return matchesJob(identity, job) ? true : null;
  };
}
export const jobAlive = createJobAlive();
export async function forceJob(job, inspect = processIdentity, kill = process.kill) {
  const identity = await inspect(job.pid);
  if (!matchesJob(identity, job)) return false;
  const current = await inspect(job.pid);
  if (!matchesJob(current, job) || current.createdAt !== identity.createdAt) return false;
  // Only the verified executor itself; never traverse an unrecorded process tree.
  kill(job.pid, 'SIGKILL'); return true;
}
