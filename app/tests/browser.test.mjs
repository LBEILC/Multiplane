import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BrowserInstaller } from '../src/main/browser.mjs';

test('browser download uses bundled Playwright, shared cache, output events and a single child', async () => {
  const calls = [], states = [];
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
  child.kill = () => { child.emit('close', 1); };
  child.send = message => { assert.equal(message.action, 'cancel'); child.emit('close', 130); };
  const launch = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'taskkill.exe') { const killer = new EventEmitter(); queueMicrotask(() => { child.emit('close', 1); killer.emit('close', 0); }); return killer; }
    return child;
  };
  const installer = new BrowserInstaller('/bundle', state => states.push(state), '/worker.cjs', launch);
  assert.equal(installer.start(), true); assert.equal(installer.start(), false);
  const offset = process.platform === 'win32' ? 1 : 0;
  if (offset) assert.equal(calls[0].args[0], '--tls-max-v1.2');
  assert.match(calls[0].args[offset + 1], /node_modules[/\\]playwright[/\\]cli.js$/);
  assert.deepEqual(calls[0].args.slice(offset + 2), ['install', 'chromium']);
  assert.equal(calls[0].options.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, os.tmpdir());
  child.stdout.write('50% downloaded'); assert.match(installer.state.text, /50%/);
  await installer.cancel();
  assert.deepEqual(installer.state, { running: false, text: '已取消安装' });
  assert.equal(calls.length, 1, 'normal cancellation needs no forced process termination');
  assert.equal(installer.start(), true); child.emit('close', 0);
  assert.equal(installer.state.text, '浏览器安装完成');
  assert.ok(states.length >= 4);
});
test('worker awaits the asynchronous CLI and rejects incomplete browser caches', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multiplane-browser-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const playwright = path.join(root, 'node_modules/playwright'), core = path.join(root, 'node_modules/playwright-core');
  await mkdir(path.join(playwright, 'lib'), { recursive: true }); await mkdir(path.join(core, 'lib'), { recursive: true });
  const cli = path.join(playwright, 'cli.js'); await writeFile(cli, '');
  await writeFile(path.join(playwright, 'lib/program.js'), 'exports.program={parseAsync:async()=>{await new Promise(resolve=>setTimeout(resolve,25))}};');
  await writeFile(path.join(core, 'package.json'), '{"name":"playwright-core"}');
  await writeFile(path.join(core, 'lib/coreBundle.js'), `const path=require('node:path'); exports.registry={registry:{findExecutable(name){const directory=path.join(${JSON.stringify(root)},name);return {directory,executablePath:()=>path.join(directory,'browser.exe')}}}};`);
  const worker = fileURLToPath(new URL('../src/main/browser-worker.cjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [worker, cli, 'install', 'chromium'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run().status, 1);
  for (const name of ['chromium', 'chromium-headless-shell']) { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'browser.exe'), 'fixture'); }
  assert.equal(run().status, 1, 'executable alone is insufficient without the completion marker');
  for (const name of ['chromium', 'chromium-headless-shell']) await writeFile(path.join(root, name, 'INSTALLATION_COMPLETE'), '');
  assert.equal(run().status, 0);
});
