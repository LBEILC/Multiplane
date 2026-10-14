import { execFile } from 'node:child_process';
import path from 'node:path';
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const value = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; @{createdAt=$p.StartTime.ToUniversalTime().ToString('o'); executable=$p.Path} | ConvertTo-Json -Compress`]));
      return { pid, createdAt: new Date(value.createdAt).toISOString(), executable: value.executable };
    }
    const createdAt = new Date(await run('ps', ['-p', String(pid), '-o', 'lstart=']) + ' UTC').toISOString();
    return { pid, createdAt, executable: await run('ps', ['-p', String(pid), '-o', 'comm=']) };
  } catch { return null; }
}
export function matchesJob(identity, job) {
  const age = Date.parse(job.startedAt) - Date.parse(identity?.createdAt);
  return identity?.pid === job.pid && /^(node|electron|multiplane|multiplane-runtime)(\.exe)?$/i.test(path.basename(identity.executable ?? '')) && age >= 0 && age <= 60000;
}
export async function jobAlive(pid, job) { return matchesJob(await processIdentity(pid), job); }
export async function forceJob(job, inspect = processIdentity, kill = process.kill) {
  const identity = await inspect(job.pid);
  if (!matchesJob(identity, job)) return false;
  const current = await inspect(job.pid);
  if (!matchesJob(current, job) || current.createdAt !== identity.createdAt) return false;
  // Only the verified executor itself; never traverse an unrecorded process tree.
  kill(job.pid, 'SIGKILL'); return true;
}
