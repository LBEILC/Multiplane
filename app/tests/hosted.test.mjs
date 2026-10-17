import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, rename, utimes, stat, symlink } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { EventEmitter } from 'node:events';
import { Hosted, json, atomic, validRequest, launchExecutor } from '../src/main/hosted.mjs';
import { processIdentity, matchesJob, forceJob, createJobAlive, processPresence } from '../src/main/process-identity.mjs';
import { JobStore } from '../src/main/store.mjs';
import { JobStopper } from '../src/main/stop.mjs';
import { trayTemplate, hideOnClose } from '../src/main/tray.mjs';
const schema = 'multiplane/1';

test('liveness caches identity failures and only ESRCH establishes an exit', async () => {
  const job = { pid: 42, startedAt: '2026-01-01T00:00:01.000Z' };
  for (const code of ['ETIMEDOUT', 'EACCES']) {
    let queries = 0, present = true;
    const alive = createJobAlive({ presence: () => present, inspect: async () => { queries++; throw Object.assign(Error(code), { code }); } });
    assert.equal(await alive(42, job), null);
    assert.equal(await alive(42, job), null);
    assert.equal(queries, 1);
    present = false; assert.equal(await alive(42, job), false);
    assert.equal(processPresence(42, () => { throw Object.assign(Error(code), { code }); }), null);
  }
  assert.equal(processPresence(42, () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); }), false);
  let queries = 0;
  const alive = createJobAlive({ presence: () => true, inspect: async () => { queries++; return { pid: 42, executable: 'node.exe', createdAt: '2026-01-01T00:00:00.000Z' }; } });
  assert.equal(await alive(42, job), true); assert.equal(await alive(42, job), true); assert.equal(queries, 1);
});

test('executor uses the requesting renderer, detached with no inherited stdio or shell', async () => {
  const r = { node: '/tools/node', bin: '/renderer/bin/multiplane', command: 'render', args: ['shot with spaces.html', '--workers', '1'], jobDir: createTempDirectory(), cwd: '/project', env: { PATH: '/tools' } };
  let unreferenced = false;
  const pid = await launchExecutor(r, (file, args, options) => {
    assert.equal(file, r.node); assert.deepEqual(args, [r.bin, 'render', ...r.args, '--job-dir-exact', r.jobDir, '--hosted-executor']);
    assert.deepEqual(options, { cwd: r.cwd, env: r.env, detached: true, stdio: ['ignore', 'ignore', options.stdio[2]], windowsHide: true, shell: false });
    const child = Object.assign(new EventEmitter(), { pid: 17, unref() { unreferenced = true; } });
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.equal(pid, 17); assert.equal(unreferenced, true);
});

async function fixture(t) {
  const home = createTempDirectory('multiplane-host-app-');
  await mkdir(path.join(home, 'hosted'));
  const pkg = path.join(home, 'renderer'); await mkdir(path.join(pkg, 'bin'), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'multiplane' }));
  const bin = path.join(pkg, 'bin/multiplane'); await writeFile(bin, '');
  await atomic(path.join(home, 'config.json'), { hosted: true });
  const requests = new Map(), launched = [];
  const options = { inspect: async pid => ({ pid, createdAt: '2026-01-01T00:00:00.000Z' }), alive: async () => true, launch: async r => {
    launched.push(r.jobId);
    await rename(path.join(home, 'hosted', r.jobId + '.claimed.json'), path.join(home, 'hosted', r.jobId + '.running.json'));
    const file = path.join(r.jobDir, 'status.json'), { queuePosition, ...s } = await json(file);
    await atomic(file, { ...s, state: 'running', pid: 42 });
  } };
  const hosted = new Hosted(home, '0.3.0', options); t.after(() => hosted.close());
  async function request(id, suffix = 'request', age = 0) {
    const jobDir = path.join(home, 'jobs', id); await mkdir(jobDir, { recursive: true });
    const r = { schema, jobId: id, jobDir, command: 'render', args: ['shot.html'], cwd: home, node: process.execPath, bin, env: { MULTIPLANE_HOME: home }, at: new Date().toISOString() };
    const file = path.join(home, 'hosted', id + '.' + suffix + '.json'); await atomic(file, r);
    if (age) { const at = new Date(Date.now() - age); await utimes(file, at, at); }
    await atomic(path.join(jobDir, 'status.json'), { schema, jobId: id, pid: 1, shot: path.join(home, 'shot.html'), command: 'render', state: 'running', startedAt: r.at, updatedAt: r.at, result: null });
    requests.set(id, r); return r;
  }
  const status = id => json(path.join(requests.get(id).jobDir, 'status.json'));
  return { home, hosted, request, status, launched, options, requests };
}

test('claims once, serializes execution, renumbers queue and cancels without launching', async t => {
  const f = await fixture(t);
  for (const id of ['job1', 'job2', 'job3']) await f.request(id);
  await f.hosted.start(); clearInterval(f.hosted.timer);
  assert.deepEqual(f.launched, ['job1']);
  await f.hosted.tick(); assert.equal((await f.status('job2')).queuePosition, 1); assert.equal((await f.status('job3')).queuePosition, 2);
  const r = f.requests.get('job2'); await writeFile(path.join(r.jobDir, 'stop'), '');
  await f.hosted.tick();
  const cancelled = await f.status('job2'); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.result.code, 'cancelled'); assert.equal('queuePosition' in cancelled, false);
  assert.equal(JSON.parse(await readFile(path.join(r.jobDir, 'events.jsonl'), 'utf8')).code, 'cancelled');
  assert.equal((await f.status('job3')).queuePosition, 1);
  await atomic(path.join(f.requests.get('job1').jobDir, 'status.json'), { ...await f.status('job1'), state: 'succeeded', result: { ok: true } });
  await f.hosted.tick(); assert.deepEqual(f.launched, ['job1', 'job3']); assert.equal('queuePosition' in await f.status('job3'), false);
  const app = await json(path.join(f.home, 'app.json')); assert.equal(app.acceptsHosted, true); assert.equal(app.createdAt, '2026-01-01T00:00:00.000Z');
});

test('restart preserves claim order, waits for running work and withdraws presence on quit', async t => {
  const f = await fixture(t);
  await f.request('later', 'claimed', 1000); await f.request('earlier', 'claimed', 2000); await f.request('executing', 'running');
  await f.hosted.start(); clearInterval(f.hosted.timer);
  assert.deepEqual(f.launched, []); assert.equal((await f.status('earlier')).queuePosition, 1);
  await f.hosted.close(); assert.equal(await json(path.join(f.home, 'app.json')), null);
  assert.ok(await stat(path.join(f.home, 'hosted/earlier.claimed.json')));
  const next = new Hosted(f.home, '0.3.0', { ...f.options, alive: async () => false }); t.after(() => next.close());
  await next.start(); clearInterval(next.timer);
  assert.deepEqual(f.launched, ['earlier']);
});

test('hosting defaults off, observes config changes and rejects invalid requests', async t => {
  const f = await fixture(t); await atomic(path.join(f.home, 'config.json'), {});
  const valid = await f.request('valid'); const invalid = await f.request('invalid');
  await atomic(path.join(f.home, 'hosted/invalid.request.json'), { ...invalid, node: path.join(f.home, 'other.exe') });
  await f.hosted.start(); clearInterval(f.hosted.timer);
  assert.equal((await json(path.join(f.home, 'app.json'))).acceptsHosted, false); assert.deepEqual(f.launched, []);
  for (const patch of [{ jobId: 'wrong' }, { jobDir: f.home }, { jobDir: 4 }, { node: 'node' }, { node: null }, { env: 'bad' }, { args: [1] }, { bin: path.join(f.home, 'missing') }]) assert.equal(await validRequest({ ...valid, ...patch }, 'valid'), false);
  await atomic(path.join(f.home, 'config.json'), { hosted: true }); await f.hosted.tick();
  assert.deepEqual(f.launched, ['valid']); assert.equal((await json(path.join(f.home, 'hosted/invalid.rejected.json'))).reason, 'Invalid hosted request.');
});

test('bundled runtime requires the app real path and explicit Node mode', async t => {
  const f = await fixture(t), r = await f.request('bundled');
  const directory = path.join(f.home, 'software'); await mkdir(directory);
  const execPath = path.join(directory, 'Multiplane.exe'); await writeFile(execPath, '');
  const other = path.join(f.home, 'OtherElectron.exe'); await writeFile(other, '');
  const request = { ...r, node: execPath, env: { ...r.env, ELECTRON_RUN_AS_NODE: '1' } };
  const valid = patch => validRequest({ ...request, ...patch }, r.jobId, { execPath });
  assert.equal(await valid({}), true);
  for (const env of [r.env, { ELECTRON_RUN_AS_NODE: '0' }, { ELECTRON_RUN_AS_NODE: 1 }, { ELECTRON_RUN_AS_NODE: '1', INVALID: 1 }]) assert.equal(await valid({ env }), false);
  assert.equal(await valid({ node: other }), false);
  assert.equal(await valid({ node: path.join(f.home, 'missing.exe') }), false);
  assert.equal(await valid({ node: process.execPath, env: r.env }), true);
  const alias = path.join(f.home, 'alias');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await valid({ node: path.join(alias, 'Multiplane.exe') }), true);
  if (process.platform === 'win32') assert.equal(await valid({ node: execPath.toUpperCase() }), true);
  for (const patch of [{ command: 'doctor' }, { args: [1] }, { jobId: 'wrong' }]) assert.equal(await valid(patch), false);
  await writeFile(path.resolve(r.bin, '../../package.json'), JSON.stringify({ name: 'other' }));
  assert.equal(await valid({}), false);
});

test('POSIX identity uses Linux proc exe with args fallback and macOS full comm paths', async () => {
  for (const platform of ['linux', 'darwin']) for (const procAvailable of [true, false]) {
    const commands = [], links = [];
    const executable = platform === 'linux' ? '/opt/node/bin/node' : '/Applications/Node Tools/node';
    const identity = await processIdentity(42, {
      platform,
      readExecutable: async file => {
        links.push(file);
        if (!procAvailable) throw Error('proc unavailable');
        return executable;
      },
      runCommand: async (file, args) => {
        assert.equal(file, 'ps');
        assert.deepEqual(args.slice(0, 3), ['-p', '42', '-o']);
        commands.push(args[3]);
        if (args[3] === 'lstart=') return 'Thu Jan  1 00:00:00 2026';
        if (args[3] === 'args=') return executable + ' executor.mjs --job-dir /jobs/one';
        assert.equal(args[3], 'comm=');
        return executable;
      },
    });
    assert.deepEqual(identity, { pid: 42, createdAt: '2026-01-01T00:00:00.000Z', executable });
    assert.equal(matchesJob(identity, { pid: 42, startedAt: '2026-01-01T00:00:01.000Z' }), true);
    assert.deepEqual(links, platform === 'linux' ? ['/proc/42/exe'] : []);
    assert.deepEqual(commands, ['lstart=', ...(platform === 'darwin' ? ['comm='] : procAvailable ? [] : ['args='])]);
  }
  assert.equal(await processIdentity(42, { platform: 'linux', runCommand: async () => { throw Error('gone'); } }), null);
});

test('job identity rejects PID reuse and wrong executables, and force rechecks creation time', async () => {
  const identity = await processIdentity(process.pid); assert.ok(identity); assert.equal(identity.pid, process.pid);
  const job = { pid: process.pid, startedAt: new Date(Date.parse(identity.createdAt) + 1000).toISOString() };
  assert.equal(matchesJob(identity, job), true);
  for (const patch of [{ pid: job.pid + 1 }, { executable: 'other.exe' }, { createdAt: new Date(Date.parse(job.startedAt) + 1).toISOString() }, { createdAt: new Date(Date.parse(job.startedAt) - 60001).toISOString() }]) assert.equal(matchesJob({ ...identity, ...patch }, job), false);
  let calls = 0, kills = 0;
  assert.equal(await forceJob(job, async () => ++calls === 1 ? identity : { ...identity, createdAt: job.startedAt }, () => kills++), false); assert.equal(kills, 0);
  assert.equal(await forceJob(job, async () => identity, pid => { assert.equal(pid, job.pid); kills++; }), true); assert.equal(kills, 1);
});

test('store recognizes queued and stuck hosted jobs, without queued completion notifications', async t => {
  const f = await fixture(t); const r = await f.request('job', 'claimed');
  const file = path.join(r.jobDir, 'status.json'); await atomic(file, { ...await f.status('job'), state: 'queued', queuePosition: 1 });
  await writeFile(path.join(f.home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: r.jobId, jobDir: r.jobDir }) + '\n');
  let live = true; const store = new JobStore(f.home, { alive: async () => live }); t.after(() => store.close());
  let notifications = 0; store.on('finished', () => notifications++);
  await store.refresh(); await store.refresh(); assert.equal(store.job('job').hosted, true); assert.equal(store.job('job').state, 'queued'); assert.equal(notifications, 0);
  await atomic(file, { ...await f.status('job'), state: 'running', phase: 'capture', done: 0, updatedAt: new Date(Date.now() - 61000).toISOString() });
  await store.refresh(); assert.equal(store.job('job').stuck, true);
  await atomic(file, { ...await f.status('job'), memoryBytes: 1000, updatedAt: new Date().toISOString() });
  await store.refresh(); assert.equal(store.job('job').stuck, true);
  await atomic(file, { ...await f.status('job'), done: 1, updatedAt: new Date().toISOString() });
  await store.refresh(); assert.equal(store.job('job').stuck, false);
  live = null; await store.refresh(); assert.equal(store.job('job').state, 'running'); assert.equal(notifications, 0);
  live = false; await store.refresh(); assert.equal(store.job('job').lost, true); assert.equal(store.job('job').stuck, false);
  live = true; await atomic(file, { ...await f.status('job'), state: 'future-state' });
  await store.refresh(); assert.equal(store.job('job').state, 'running');
});

test('stop waits 15 seconds, asks before force, skips completed and mismatched processes', async () => {
  let job = { jobId: 'job', pid: 7, state: 'running' }, callback, stopped = 0, forced = 0, asked = 0, live = true, accepted = true;
  const store = { refresh: async () => {}, job: () => job, stop: async () => stopped++, forced: new Set() };
  const stopper = new JobStopper(store, { confirm: async () => true, confirmForce: async () => { asked++; return accepted; }, alive: async () => live, force: async () => { forced++; return true; }, schedule: (fn, ms) => { assert.equal(ms, 15000); callback = fn; return 1; }, clear: () => {} });
  await stopper.stop('job'); assert.equal(stopped, 1); assert.equal(asked, 0); await callback(); assert.equal(forced, 1); assert.ok(store.forced.has('job'));
  accepted = false; await stopper.stop('job'); await callback(); assert.equal(forced, 1);
  live = false; await stopper.stop('job'); await callback(); assert.equal(asked, 2);
  job = { ...job, state: 'queued' }; await stopper.stop('job'); await callback(); assert.equal(asked, 2);
  live = true; job.state = 'running'; await stopper.stop('job'); job.state = 'succeeded'; await callback(); assert.equal(asked, 2);
  stopper.close();
});

test('tray shows at most five running jobs, queue count and working actions; only hosting hides the window', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => ({ jobId: String(i), shot: `shot-${i}.html`, state: 'running', done: 1, total: 2 }));
  jobs.push({ state: 'queued' }); const shown = []; let quit = false;
  const menu = trayTemplate(jobs, id => shown.push(id), () => { quit = true; });
  assert.equal(menu.filter(item => item.label?.includes('50%')).length, 5);
  assert.equal(menu.find(item => item.enabled === false).label, '1 queued');
  menu[0].click(); menu[2].click(); menu.at(-1).click(); assert.deepEqual(shown, [undefined, '0']); assert.equal(quit, true);
  assert.equal(hideOnClose(true, false), true); assert.equal(hideOnClose(false, false), false); assert.equal(hideOnClose(true, true), false);
});

test('resume requests pass the whitelist and are claimed and executed', async t => {
  const f=await fixture(t),r=await f.request('resume-job');
  r.command='resume';r.args=['original-job'];
  await atomic(path.join(f.home,'hosted','resume-job.request.json'),r);
  assert.equal(await validRequest(r,r.jobId),true);
  await f.hosted.start();clearInterval(f.hosted.timer);
  assert.deepEqual(f.launched,['resume-job']);
  await launchExecutor(r,(file,args,options)=>{
    assert.deepEqual(args,[r.bin,'resume','original-job','--job-dir-exact',r.jobDir,'--hosted-executor']);
    const child=Object.assign(new EventEmitter(),{pid:17,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;
  });
  assert.equal(await validRequest({...r,command:'config'},r.jobId),false);
});
