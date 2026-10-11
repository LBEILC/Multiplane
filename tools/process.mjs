import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function run(file, args, { cwd, env = process.env, capture = false, timeout = 600000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    if (capture) { child.stdout.on('data', bytes => { stdout += bytes; onOutput?.(bytes, 'stdout'); }); child.stderr.on('data', bytes => { stderr += bytes; onOutput?.(bytes, 'stderr'); }); }
    const timer = setTimeout(() => { child.kill(); reject(Error(`Command timed out: ${path.basename(file)}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve({ code, stdout, stderr }) : reject(Object.assign(Error(`Command failed (${code}): ${path.basename(file)} ${args.join(' ')}\n${stderr || stdout}`), { stdout, stderr })); });
  });
}
export function npm(args, options) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(file => file && /npm-cli\.js$/.test(file) && existsSync(file));
  if (!cli) throw Error('Cannot locate npm-cli.js; run this tool through npm.');
  return run(process.execPath, [cli, ...args], options);
}
