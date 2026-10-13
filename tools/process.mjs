import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// CI opts in; other tooling retains its existing timeout and process behavior.
export function run(file, args, { cwd, env = process.env, capture = false, timeout = 600000, onOutput, killTree = false, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, args, { cwd, env, shell: false, detached: killTree && process.platform !== 'win32', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    let timedOut = false, cleanup = Promise.resolve();
    if (capture) { child.stdout.on('data', bytes => { stdout += bytes; onOutput?.(bytes, 'stdout'); }); child.stderr.on('data', bytes => { stderr += bytes; onOutput?.(bytes, 'stderr'); }); }
    const timer = setTimeout(() => {
      if (!killTree) { child.kill(); reject(Error(`Command timed out: ${path.basename(file)}`)); return; }
      timedOut = true;
      // Attach a rejection handler immediately; close waits for taskkill as well.
      cleanup = stopTree(child).then(() => null, error => {
        // If the OS refuses tree termination, report it instead of waiting on
        // inherited pipes forever. Still wait for the direct child's exit.
        child.kill('SIGKILL');
        child.stdout?.destroy(); child.stderr?.destroy();
        return error;
      });
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      if (timedOut) {
        const error = await cleanup;
        const message = timeoutMessage?.(performance.now() - started) ?? `Command timed out: ${path.basename(file)}`;
        reject(Object.assign(Error(message + (error ? `; process tree cleanup failed: ${error.message}` : '')), { stdout, stderr }));
      } else if (code === 0) resolve({ code, stdout, stderr });
      else reject(Object.assign(Error(`Command failed (${code}): ${path.basename(file)} ${args.join(' ')}\n${stderr || stdout}`), { stdout, stderr }));
    });
  });
}

async function stopTree(child) {
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return;
  }
  await new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject);
    killer.once('close', code => code === 0 ? resolve() : reject(Error(`taskkill exited with ${code}`)));
  });
}
export function npm(args, options) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(file => file && /npm-cli\.js$/.test(file) && existsSync(file));
  if (!cli) throw Error('Cannot locate npm-cli.js; run this tool through npm.');
  return run(process.execPath, [cli, ...args], options);
}
