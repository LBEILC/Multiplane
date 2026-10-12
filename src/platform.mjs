import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windowsMemoryQuery = '$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize | Select-Object ProcessId,ParentProcessId,WorkingSetSize); @{ observer = $PID; rows = $rows } | ConvertTo-Json -Compress';
function windowsMemory(stdout, pid) {
  const data = JSON.parse(stdout);
  const rows = data.rows.map(row => ({ pid: Number(row.ProcessId), parent: Number(row.ParentProcessId), bytes: Number(row.WorkingSetSize) }));
  return sumProcessTree(rows, pid, [data.observer]);
}

// Reuse the Windows observer to avoid launching PowerShell for every sample.
// It reads requests on stdin and writes one JSON line per response.
export function createProcessTreeReader({ platform = process.platform, pid = process.pid } = {}) {
  if (platform !== 'win32') return { sample: () => processTreeMemory({ platform, pid }), close() {} };
  let child, pending, closed = false, failed = false;
  const settle = value => { const current = pending; pending = undefined; if (current) { clearTimeout(current.timer); current.resolve(value); } };
  const fail = () => { failed = true; settle(null); child?.kill(); };
  return {
    sample() {
      if (closed || failed) return Promise.resolve(null);
      if (pending) return pending.promise;
      if (!child) {
        const script = `$ErrorActionPreference = 'Stop'; while ($null -ne [Console]::ReadLine()) { try { ${windowsMemoryQuery} } catch { [Console]::WriteLine('null') } }`;
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        child.on('error', fail); child.on('close', () => { failed = true; settle(null); }); child.stdin.on('error', fail);
        createInterface({ input: child.stdout }).on('line', line => {
          let bytes = null; try { bytes = windowsMemory(line, pid); } catch {}
          settle(bytes);
        });
      }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pending = { promise, resolve, timer: setTimeout(fail, 5000) };
      child.stdin.write('\n');
      return promise;
    },
    async close() {
      if (closed) return;
      closed = true; settle(null);
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
}
export function sumProcessTree(rows, rootPid, excluded = []) {
  const selected = new Set([rootPid]), blocked = new Set(excluded);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (!blocked.has(row.pid) && selected.has(row.parent) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  if (!rows.some(row => row.pid === rootPid)) return null;
  let sum = 0;
  for (const row of rows) if (selected.has(row.pid)) {
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) return null;
    sum += row.bytes;
  }
  return Number.isSafeInteger(sum) && sum > 0 ? sum : null;
}

export async function processTreeMemory({ platform = process.platform, pid = process.pid, run = execute } = {}) {
  try {
    let rows;
    if (platform === 'win32') {
      // Exclude the observer itself and its descendants from the target tree.
      const script = '$ErrorActionPreference = "Stop"; ' + windowsMemoryQuery;
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      return windowsMemory(stdout, pid);
    }
    if (!['linux', 'darwin'].includes(platform)) return null;
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    rows = stdout.trim().split(/\r?\n/).map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) throw new Error('Invalid process table.');
      return { pid: Number(match[1]), parent: Number(match[2]), bytes: Number(match[3]) * 1024, name: match[4] };
    });
    return sumProcessTree(rows, pid, rows.filter(row => row.parent === pid && /(^|\/)ps$/.test(row.name)).map(row => row.pid));
  } catch { return null; }
}

// Keep platform-specific Chromium switches isolated from capture logic.
export function browserOptions(raster = 'gpu', options = {}, platform = process.platform) {
  const gpu = raster === 'gpu';
  return { headless: true, ...(gpu ? { channel: 'chromium' } : {}), args: [
    '--disable-partial-raster',
    ...(options.rasterThreads ? [`--num-raster-threads=${options.rasterThreads}`] : []),
    ...(gpu ? ['--enable-gpu-rasterization', ...(platform === 'win32' ? ['--use-angle=d3d11'] : platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=gl']),
      '--force-high-performance-gpu', '--ignore-gpu-blocklist'] : []),
    ...(!gpu && platform !== 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ] };
}

export const ffmpegName = (platform = process.platform) => platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
export const ffmpegHint = (platform = process.platform) => `${platform === 'darwin' ? 'Run brew install ffmpeg' : platform === 'linux' ? 'Install FFmpeg with libx264 using your distribution package manager (for example: sudo apt-get install ffmpeg)' : 'Get FFmpeg with libx264 from https://ffmpeg.org/download.html'} and set --ffmpeg, MULTIPLANE_FFMPEG or PATH.`;
export const browserHint = (missing, platform = process.platform) => missing ? 'Run npx playwright install chromium.'
  : platform === 'linux' ? 'Run npx playwright install-deps chromium, then npx playwright install chromium.' : 'Run npx playwright install chromium.';

export const stopSignals = (platform = process.platform) => platform === 'win32'
  ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
export function userHome(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.MULTIPLANE_HOME) return paths.resolve(env.MULTIPLANE_HOME);
  const base = platform === 'win32' ? (env.APPDATA || paths.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  return paths.join(base, 'multiplane');
}
