import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execute } from '../src/main/settings.mjs';
import { BrowserInstaller } from '../src/main/browser.mjs';
import { spawnOwned, stopOwned } from '../src/main/owned-process.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDirectory } from './helpers.mjs';

test('desktop CLI timeout terminates its owned process', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 1500 }), /Command timed out/);
});

test('browser forced cancellation closes the owned job/group', async t => {
  let child;
  const launch = () => {
    child = spawnOwned(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)']);
    // Exercise IPC failure followed by the actual forced-cleanup path.
    child.send = (_message, callback) => callback(Error('IPC unavailable'));
    return child;
  };
  const installer = new BrowserInstaller('/bundle', () => {}, '/worker.cjs', launch);
  installer.start();
  t.after(() => stopOwned(child));
  await once(child.stdout, 'data');
  await installer.cancel();
  assert.equal(installer.state.running, false);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('real browser worker cooperatively cancels through the owned launcher', async t => {
  const root = createTempDirectory('multiplane-owned-browser-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const lib = path.join(root, 'node_modules/playwright/lib');
  await mkdir(lib, { recursive: true });
  await writeFile(path.join(lib, 'program.js'), 'exports.program={parseAsync:async()=>{console.log("ready");await new Promise(()=>{})}};');
  const installer = new BrowserInstaller(root, () => {}, fileURLToPath(new URL('../src/main/browser-worker.cjs', import.meta.url)));
  installer.start();
  const child = installer.child;
  t.after(() => stopOwned(child));
  await once(child.stdout, 'data');
  await installer.cancel();
  assert.equal(child.exitCode, 130, 'cooperative worker exit, not forced job termination');
  assert.equal(installer.state.running, false);
});
