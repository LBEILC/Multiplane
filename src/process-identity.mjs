import { execFile } from 'node:child_process';
const execute = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }));
});
// Process creation time, never the app publication time. Failure is fail-closed.
export async function processCreatedAt(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    const { stdout } = process.platform === 'win32'
      ? await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { windowsHide: true, timeout: 5000 })
      : await execute('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 });
    const time = Date.parse(stdout.trim() + (process.platform === 'win32' ? '' : ' UTC'));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  } catch { return null; }
}
