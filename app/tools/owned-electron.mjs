import { waitForMainWindow } from './main-window.mjs';
import { spawnOwned, stopOwned } from '../src/main/owned-process.mjs';
import { chromium } from 'playwright';

// Own the Windows job before connecting; owner exit closes the control pipe.
export async function launchOwned(executable, env, onSpawn = () => {}) {
  if (process.platform !== 'win32') throw Error('Owned PID-tree diagnostics currently require Windows');
  const child = spawnOwned(executable, ['--inspect=0', '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser, socket, closing;
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  child.on('error', e => { output += e.stack; });
  const close = () => closing ??= (async () => {
    socket?.close();
    await stopOwned(child);
    await browser?.close();
  })();
  const diagnostics = () => ({ exitCode: child.exitCode, signalCode: child.signalCode, output: output.slice(-16000) });
  onSpawn({ pid: child.pid, close, diagnostics });
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
    const windows = () => browser.contexts()[0]?.pages() ?? [];
    const page = await waitForMainWindow(windows);
    return { page, windows, firstWindow: async () => page, evaluate, close, pid: child.pid, diagnostics };
  } catch (error) { await close(); throw error; }
}
