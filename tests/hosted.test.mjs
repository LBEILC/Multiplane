import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempDirectory, run } from './helpers.mjs';
import { fakeApp, launch } from './fixtures/fake-hosted-app.mjs';
import { stopOwned } from '../app/src/main/owned-process.mjs';
import { hostedAvailable, hostedEnvironment, handoff, claimExecutor, followJob } from '../src/hosted.mjs';
import { processCreatedAt } from '../src/process-identity.mjs';
import { loadUserConfig } from '../src/user-home.mjs';
import { renderShot } from '../src/render.mjs';
import { MultiplaneError } from '../src/errors.mjs';

const bin = fileURLToPath(new URL('../bin/multiplane', import.meta.url));
async function until(check, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await delay(30); }
  throw Error('Timed out waiting for test condition.');
}
async function fixture(t, options = {}) {
  const root = createTempDirectory('multiplane-hosted-'), home = path.join(root, 'home'), jobs = path.join(root, 'jobs');
  await mkdir(home);
  const shot = path.join(root, 'tiny.html');
  await writeFile(shot, '<div id="stage" style="width:16px;height:16px;background:red"></div><script>window.SHOT={duration:0.1,fps:10,render(){}}</script>');
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ hosted: true, jobsDir: jobs, raster: 'software' }));
  const env = { ...process.env, MULTIPLANE_HOME: home };
  delete env.MULTIPLANE_JOBS_DIR;
  const app = await fakeApp(home, options), waiters = [];
  t.after(async () => { await Promise.all(waiters.map(item => stopOwned(item.child))); await app.close(); });
  const start = (extra = [], command = 'stills', json = true) => {
    const waiter = launch(process.execPath, [...(options.mode ? ['--import', new URL('./hosted-timeouts.mjs', import.meta.url).href] : []), bin, command, shot, ...extra, ...(json ? ['--json'] : [])], { cwd: root, env });
    waiters.push(waiter); return waiter;
  };
  const cli = args => run(process.execPath, [bin, ...args], { cwd: root, env });
  const request = () => until(() => { app.check(); return app.requests.at(-1); });
  return { root, home, jobs, shot, env, app, start, cli, request };
}
const final = output => JSON.parse(output.stdout.trim().split('\n').at(-1));

fullTest('resume requests identify resume and fall back locally when the app rejects them', { timeout: 60000 }, async t => {
  const f = await fixture(t, { mode: 'reject' });
  let original;
  try {
    await renderShot(f.shot, { root: f.root, 'job-dir': f.jobs, workers: 1, 'no-lint': true, 'no-post': true, 'no-hosted': true,
      _segmentHook() { throw new MultiplaneError('cancelled'); } });
  } catch (error) { assert.equal(error.code, 'cancelled'); original = path.join(f.jobs, error.result.jobId); }
  const output = await f.cli(['resume', original, '--json']);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  assert.equal(f.app.requests.at(-1).command, 'resume');
  assert.equal(final(output).command, 'render');
  assert.equal(final(output).data.resumedFrom, path.basename(original));
  assert.match(output.stderr, /Rendering locally/);
});

test('hosted executor keeps the job and forwards exact bytes; wait replays completed logs', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const waiter = f.start(), request = await f.request(), output = await waiter.done;
  assert.equal(output.code, 0, output.stdout + output.stderr);
  assert.equal(final(output).jobId, request.jobId);
  assert.equal(output.stdout, await readFile(path.join(request.jobDir, 'events.jsonl'), 'utf8'));
  assert.match(output.stderr, /Closing this session/);
  assert.equal(request.node, process.execPath); assert.equal(request.bin, bin);
  assert.deepEqual(request.args, [f.shot]);
  assert.deepEqual(await readdir(f.jobs), [request.jobId]);
  assert.equal((await f.cli(['wait', request.jobId, '--json'])).stdout, output.stdout);
  assert.equal((await f.cli(['wait', request.jobDir])).code, 0);
  assert.equal(JSON.parse(await readFile(path.join(request.jobDir, 'status.json'))).state, 'succeeded');
});

fullTest('queue is silent and survives waiter termination; wait reconnects and timeout leaves job intact', { timeout: 60000 }, async t => {
  const f = await fixture(t, { hold: true });
  const waiter = f.start(), request = await f.request();
  await until(() => waiter.stderr.includes('queued'));
  assert.equal(waiter.stdout, '');
  assert.equal(final(await f.cli(['status', request.jobDir, '--json'])).data.state, 'queued');
  const timed = await f.cli(['wait', request.jobId, '--json', '--timeout', '0.1']);
  assert.equal(timed.code, 3); assert.equal(final(timed).code, 'wait_timeout');
  await stopOwned(waiter.child);
  const connected = f.cli(['wait', request.jobId, '--json', '--timeout', '30']);
  f.app.release();
  const result = await connected;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, await readFile(path.join(request.jobDir, 'events.jsonl'), 'utf8'));
});

test('cancel removes a queued job and both waiter and wait return 130', { timeout: 30000 }, async t => {
  const f = await fixture(t, { hold: true });
  const waiter = f.start(), request = await f.request();
  await until(() => waiter.stderr.includes('queued'));
  const cancelled = await f.cli(['cancel', request.jobDir, '--wait', '5', '--json']);
  assert.equal(final(cancelled).data.state, 'cancelled');
  const output = await waiter.done;
  assert.equal(output.code, 130); assert.equal(final(output).code, 'cancelled');
  const replay = await f.cli(['wait', request.jobId, '--json']);
  assert.equal(replay.code, 130); assert.equal(replay.stdout, output.stdout);
  assert.equal(f.app.children.length, 0);
});

fullTest('running executor survives waiter termination and the queue runs one executor at a time', { timeout: 60000 }, async t => {
  const f = await fixture(t, { hold: true });
  await writeFile(f.shot, '<div id="stage" style="width:16px;height:16px;background:red"></div><script>window.SHOT={duration:0.1,fps:10,ready:new Promise(r=>setTimeout(r,2500)),render(){}}</script>');
  const first = f.start(['--no-lint']), firstRequest = await f.request();
  const second = f.start(['--no-lint']);
  await until(() => f.app.requests.length === 2);
  const secondRequest = f.app.requests[1];
  await until(() => second.stderr.includes('queued'));
  f.app.release();
  await until(async () => {
    const state = JSON.parse(await readFile(path.join(firstRequest.jobDir, 'status.json')));
    return state.state === 'running';
  });
  assert.equal(f.app.children.length, 1);
  await stopOwned(first.child);
  const resumed = await f.cli(['wait', firstRequest.jobId, '--json', '--timeout', '30']);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(resumed.stdout, await readFile(path.join(firstRequest.jobDir, 'events.jsonl'), 'utf8'));
  assert.equal((await second.done).code, 0);
  assert.equal(final(await f.cli(['status', secondRequest.jobId, '--json'])).data.state, 'succeeded');
  assert.equal(f.app.children.length, 2);
});

fullTest('render and verify use the same hosted executor path and propagate execution failure', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const command of ['render', 'verify']) {
    const output = await f.start(command === 'render' ? ['--workers', '1', '--no-post'] : ['--at', '0', '--workers', '1'], command, command !== 'render').done;
    assert.equal(output.code, 0, output.stdout + output.stderr);
    const request = f.app.requests.at(-1);
    assert.equal(request.command, command);
    assert.equal(output.stdout, await readFile(path.join(request.jobDir, 'events.jsonl'), 'utf8'));
  }
  await writeFile(f.shot, '<div id="stage" style="width:16px;height:16px"></div><script>window.SHOT={duration:1,render(){throw Error("fixture")}}</script>');
  const failed = await f.start().done;
  assert.equal(failed.code, 1); assert.equal(final(failed).code, 'render_threw');
  const replay = await f.cli(['wait', final(failed).jobId, '--json']);
  assert.equal(replay.code, 1); assert.equal(replay.stdout, failed.stdout);
});

for (const [mode, reason] of [['reject', /Rejected by|app rejected/], ['ignore', /5 seconds/], ['crash', /15 seconds/]]) {
  (mode === 'ignore' ? test : fullTest)('local fallback: ' + mode, { timeout: 60000 }, async t => {
    const f = await fixture(t, { mode }), output = await f.start().done;
    assert.equal(output.code, 0, output.stdout + output.stderr);
    assert.match(output.stderr, reason); assert.match(output.stderr, /Rendering locally/);
    assert.equal((await readdir(f.jobs)).length, 1);
    const job = path.join(f.jobs, final(output).jobId);
    assert.equal(output.stdout, await readFile(path.join(job, 'events.jsonl'), 'utf8'));
    assert.equal((await f.cli(['wait', job, '--json'])).stdout, output.stdout);
    if (mode !== 'reject') assert.ok((await readdir(path.join(f.home, 'hosted'))).some(name => name.endsWith('.withdrawn.json')));
    const before = await readFile(path.join(job, 'status.json'));
    const late = await f.cli(['stills', f.shot, '--job-dir-exact', job, '--hosted-executor', '--json']);
    assert.equal(late.code, 0); assert.equal(late.stdout, ''); assert.equal(late.stderr, '');
    assert.deepEqual(await readFile(path.join(job, 'status.json')), before);
  });
}

fullTest('configuration, overrides, identity mismatch and lint failure never submit requests', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const value of ['true', 'false']) {
    const saved = await f.cli(['config', 'set', 'hosted', value, '--json']);
    assert.equal(saved.code, 0); assert.equal(final(saved).data.values.hosted, value === 'true');
  }
  assert.equal((await f.cli(['config', 'set', 'hosted', 'yes', '--json'])).code, 2);
  assert.equal(loadUserConfig('stills', {}, f.env).options.hosted, false);
  assert.equal((await f.start().done).code, 0);
  await f.cli(['config', 'set', 'hosted', 'true']);
  assert.equal((await f.start(['--no-hosted']).done).code, 0);
  f.env.MULTIPLANE_HOSTED = '0';
  assert.equal((await f.start().done).code, 0);
  delete f.env.MULTIPLANE_HOSTED;
  const appFile = path.join(f.home, 'app.json'), app = JSON.parse(await readFile(appFile));
  await writeFile(appFile, JSON.stringify({ ...app, createdAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal((await f.start().done).code, 0);
  await writeFile(appFile, JSON.stringify(app));
  await writeFile(f.shot, '<script>window.SHOT={duration:1,render(){return Math.random()}}</script>');
  const invalid = await f.start().done;
  assert.equal(final(invalid).code, 'lint_failed');
  assert.equal(f.app.requests.length, 0);
  assert.equal(await hostedAvailable('doctor', { hosted: true, _hostedCLI: {} }, f.env), false);
  assert.equal(await hostedAvailable('render', { hosted: true, _hostedCLI: {} }, f.env), true);
  assert.equal(await processCreatedAt(2147483647), null);
  for (const value of ['-1', 'NaN', 'Infinity']) {
    const invalidWait = await f.cli(['wait', 'missing', '--timeout', value, '--json']);
    assert.equal(invalidWait.code, 2); assert.equal(final(invalidWait).code, 'invalid_option');
  }
  const missingWait = await f.cli(['wait', 'missing', '--json']);
  assert.equal(missingWait.code, 2); assert.equal(final(missingWait).code, 'job_not_found');
});

test('environment allows runtime variables but never named secrets or proxy credentials', () => {
  assert.deepEqual(hostedEnvironment({ PATH: '/bin', MULTIPLANE_HOME: '/home', MULTIPLANE_TOKEN: 'secret',
    MULTIPLANE_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', HTTPS_PROXY: 'http://user:password@proxy',
    http_proxy: 'http://proxy:8080', LANG: 'C', LC_ALL: 'C', OTHER: 'private' }),
  { PATH: '/bin', MULTIPLANE_HOME: '/home', http_proxy: 'http://proxy:8080', LANG: 'C', LC_ALL: 'C' });
});

test('environment preserves the bundled Node mode without allowing other Electron variables', () => {
  assert.deepEqual(hostedEnvironment({
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_EXTRA_LAUNCH_ARGS: '--inspect',
    ELECTRON_RUN_AS_NODE_EXTRA: '1', NODE_OPTIONS: '--inspect',
  }), { ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(hostedEnvironment({ ELECTRON_RUN_AS_NODE: undefined }), {});
  assert.deepEqual(hostedEnvironment({ ELECTRON_RUN_AS_NODE: '0' }), { ELECTRON_RUN_AS_NODE: '0' });
});

test('event follower preserves partial UTF-8 and completed failure exit information', async () => {
  const job = createTempDirectory('multiplane-follow-'), file = path.join(job, 'events.jsonl');
  await writeFile(path.join(job, 'status.json'), JSON.stringify({ schema: 'multiplane/1', pid: process.pid, state: 'queued' }));
  const bytes = Buffer.from('{"type":"warning","message":"中文"}\n{"type":"result","ok":false,"code":"cancelled"}\n');
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  await writeFile(file, bytes.subarray(0, split));
  const output = [];
  const done = followJob(job, { timeout: 2, interval: 10, onBytes: data => output.push(data) });
  await delay(30); assert.equal(output.length, 0);
  await writeFile(file, bytes);
  assert.equal((await done).code, 'cancelled');
  assert.deepEqual(Buffer.concat(output), bytes);
});

test('executor claim and timeout withdrawal are mutually exclusive', async () => {
  const original = process.env.MULTIPLANE_HOME;
  try {
    for (const executorFirst of [false, true]) {
      const home = createTempDirectory('multiplane-claim-'), jobDir = path.join(home, 'job');
      process.env.MULTIPLANE_HOME = home;
      await mkdir(jobDir);
      await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ state: 'running', pid: process.pid }));
      const request = { schema: 'multiplane/1', jobId: 'job', jobDir, command: 'stills' };
      const result = handoff(request, { home, timeout: 1000, startTimeout: 80, interval: 5, announce() {} });
      const base = path.join(home, 'hosted/job');
      await until(async () => { try { await rename(base + '.request.json', base + '.claimed.json'); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; } });
      if (!executorFirst) assert.match((await result).reason, /did not start/);
      assert.equal(await claimExecutor(jobDir, 'stills'), executorFirst);
      if (executorFirst) assert.equal((await result).hosted, true);
      const names = await readdir(path.join(home, 'hosted'));
      assert.deepEqual(names, [executorFirst ? 'job.running.json' : 'job.withdrawn.json']);
    }
  } finally { process.env.MULTIPLANE_HOME = original; }
});

test('handoff announces a valid queue position once and falls back for an absent position', async () => {
  for (const position of [1, 3, undefined, 0]) {
    const home = createTempDirectory('multiplane-position-'), jobDir = path.join(home, 'job'); await mkdir(jobDir);
    const request = { schema: 'multiplane/1', jobId: 'job', jobDir, command: 'stills' }, messages = [];
    const done = handoff(request, { home, timeout: 1000, interval: 5, announce: message => messages.push(message) });
    const base = path.join(home, 'hosted/job');
    await until(async () => { try { await rename(base + '.request.json', base + '.claimed.json'); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; } });
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ state: 'queued', queuePosition: position }));
    assert.equal((await done).hosted, true); assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(position > 0 ? `queued; #${position}` : 'position unavailable'));
  }
});
