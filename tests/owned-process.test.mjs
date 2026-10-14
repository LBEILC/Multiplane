import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwned, stopOwned } from '../app/src/main/owned-process.mjs';
import { run } from '../tools/process.mjs';
import { createTempDirectory } from './helpers.mjs';
import { readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function ready(child) {
  let text = '';
  child.stdout.on('data', data => { text += data; });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  for (let i = 0; i < 400; i++) {
    if (text.includes('ready')) return text;
    if (child.exitCode !== null) throw Error(errors || 'Exited before ready');
    await delay(25);
  }
  throw Error('Owned child did not become ready');
}

test('owned launch preserves argument boundaries, Unicode, stdout, stderr and exit status', async () => {
  const args = ['', 'a b', 'quote"here', 'trailing\\', '中文', '& $() ` ; %PATH%'];
  const result = await run(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)));console.error("diagnostic")', ...args], { capture: true });
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(result.stderr.trim(), 'diagnostic');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], { capture: true }), /Command failed \(7\)/);
  await assert.rejects(run('multiplane-missing-owned-executable', [], { capture: true }), { code: 'ENOENT' });
});

test('Windows helper preserves a minimal target environment without writing a cache into cwd', { skip: process.platform !== 'win32' }, async t => {
  const cwd = createTempDirectory('multiplane-owned-env-');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { OWNED_TEST: '中文', PSModuleAnalysisCachePath: 'caller-value' };
  const result = await run(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { capture: true, cwd, env });
  const native = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env, cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(native.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(native.stdout));
  assert.deepEqual(await readdir(cwd), []);
});

test('forged PID/creation-time records and reused-parent orphan records cannot authorize termination', async t => {
  const outsider = spawnOwned(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)']);
  t.after(() => stopOwned(outsider));
  await ready(outsider);
  // A PID-only tree walk would accept the orphan. Kernel job ownership never
  // consults these records, including when a caller supplies the correct PID.
  const root = { pid: outsider.pid, created: 200, exitCode: null, signalCode: null };
  const orphan = { pid: outsider.pid + 1, parentPid: root.pid, created: 100 };
  for (const record of [root, orphan, { ...root, created: 199 }]) {
    await assert.rejects(stopOwned(record), /unowned process/);
  }
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { capture: true, timeout: 1500, killTree: true }), /timed out/);
  assert.equal(outsider.exitCode, null);
  assert.doesNotThrow(() => process.kill(outsider.pid, 0));
});

test('cleanup after root exit is a no-op and never signals a possibly reused process group', async t => {
  const child = spawnOwned(process.execPath, ['-e', '']);
  child.stdout.resume(); child.stderr.resume();
  await once(child, 'close');
  const kill = t.mock.method(process, 'kill', () => { throw Error('Must not signal an exited root'); });
  await stopOwned(child);
  assert.equal(kill.mock.callCount(), 0);
});

test('Windows root exit also closes the job of a detached descendant with no inherited output pipes', { skip: process.platform !== 'win32' }, async () => {
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
    console.log(child.pid);child.unref();`;
  const result = await run(process.execPath, ['-e', script], { capture: true });
  assert.throws(() => process.kill(Number(result.stdout.trim()), 0), { code: 'ESRCH' });
});

test('Windows control-pipe EOF terminates the job while the Node owner stays alive', { skip: process.platform !== 'win32' }, async t => {
  const child = spawnOwned(process.execPath, ['-e', 'console.log("ready="+process.pid);setInterval(()=>{},1000)']);
  t.after(() => stopOwned(child));
  const text = await ready(child);
  const closed = once(child, 'close');
  child.stdin.end();
  await closed;
  assert.throws(() => process.kill(Number(/ready=(\d+)/.exec(text)[1]), 0), { code: 'ESRCH' });
});

test('Windows control-owner exit closes the job and its live descendant', { skip: process.platform !== 'win32' }, async () => {
  const module = new URL('../app/src/main/owned-process.mjs', import.meta.url).href;
  const script = `import {spawnOwned} from ${JSON.stringify(module)};
    const child=spawnOwned(process.execPath,['-e','console.log("ready="+process.pid);setInterval(()=>{},1000)']);
    child.stdout.once('data', bytes=>{process.stdout.write(bytes);process.exit(0)});
    child.stderr.pipe(process.stderr);`;
  // The outer job also contains the test owner, providing failure cleanup.
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { capture: true });
  const pid = Number(/ready=(\d+)/.exec(result.stdout)[1]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
