import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { run } from '../../tools/process.mjs';

// Own the PID before connecting, including startup failures and timeouts.
export async function launchOwned(executable, env, onSpawn = () => {}) {
  if (process.platform !== 'win32') throw Error('Owned PID-tree diagnostics currently require Windows');
  const child = spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser, socket, closing;
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  child.on('error', e => { output += e.stack; });
  const emergencyCleanup = () => {
    if (child.pid && child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  };
  process.once('exit', emergencyCleanup);
  const close = () => closing ??= (async () => {
    socket?.close();
    if (child.exitCode === null) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { capture: true });
    await browser?.close();
    process.removeListener('exit', emergencyCleanup);
  })();
  onSpawn({ pid: child.pid, close });
  try {
    const wait = async fn => {
      const end = Date.now() + 30000;
      while (Date.now() < end) { const value = fn(); if (value) return value; if (child.exitCode !== null) break; await new Promise(r => setTimeout(r, 100)); }
      throw Error(`Electron startup failed: ${output}`);
    };
    const inspector = await wait(() => output.match(/Debugger listening on (ws:\/\/\S+)/)?.[1]);
    socket = new WebSocket(inspector);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => { const value = JSON.parse(event.data); if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); } };
    const evaluate = async (fn, argument) => {
      const request = ++id;
      const response = new Promise(resolve => pending.set(request, resolve));
      socket.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression: `(${fn.toString()})(process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron'), ${JSON.stringify(argument) ?? 'undefined'})`, awaitPromise: true, returnByValue: true } }));
      const value = await response;
      if (value.error || value.result.exceptionDetails) throw Error(JSON.stringify(value));
      return value.result.result.value;
    };
    const endpoint = await wait(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
    browser = await chromium.connectOverCDP(endpoint);
    const page = await wait(() => browser.contexts()[0]?.pages()[0]);
    return { page, firstWindow: async () => page, evaluate, close, pid: child.pid };
  } catch (error) { await close(); throw error; }
}
