import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createEvents, jobDirectory } from '../src/events.mjs';
import { errorCodes, MultiplaneError } from '../src/errors.mjs';
import { stillsShot } from '../src/stills.mjs';
import { decodePNG } from '../src/png.mjs';
import { run } from './helpers.mjs';

await mkdir('out/tests', { recursive: true });
const directory = await mkdtemp(path.resolve('out/tests/protocol-'));
const evidence = [];
const cli = async (args, options = {}) => {
  const result = await run(process.execPath, ['bin/multiplane', ...args, '--json'], options);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  const final = events.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(events.filter(e => e.type === 'result').length, 1);
  for (const e of events) { assert.equal(e.schema, 'multiplane/1'); assert.ok(Number.isFinite(Date.parse(e.ts))); }
  assert.equal(result.code, final.ok ? 0 : errorCodes[final.code].exitCode);
  const progress = events.filter(e => e.type === 'progress');
  for (let i = 1; i < progress.length; i++) assert.ok(Date.parse(progress[i].ts) - Date.parse(progress[i-1].ts) >= 249);
  evidence.push({ args, ...result });
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  return { ...result, events, final };
};

test('event stream is final, throttled, and identical to the job log', async () => {
  const events = [];
  const e = createEvents('render', path.resolve('example.html'), { 'job-dir': directory, onEvent: event => events.push(event) }, true);
  e.start(); e.progress('capture', 0, 2); e.progress('capture', 1, 2);
  const result = e.finish({}); e.emit('warning', { message: 'late' }); e.dispose();
  assert.equal(events.filter(e => e.type === 'progress').length, 1);
  assert.equal(events.at(-1).type, 'result');
  const status = JSON.parse(await readFile(path.join(e.directory, 'status.json')));
  assert.equal(status.state, 'succeeded'); assert.equal(status.done, 1);
  assert.deepEqual(status.result, events.at(-1));
  assert.deepEqual((await readFile(path.join(e.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), events);
  assert.equal(jobDirectory({}, { MULTIPLANE_JOBS_DIR: directory }), directory);
  assert.match(result.jobId, /^\d{8}-\d{6}-example-[0-9a-f]{4}$/);
});

test('all commands have structured success and failure, with separate stderr', { timeout: 120000 }, async () => {
  const shot = path.join(directory, 'tiny.html');
  await writeFile(shot, '<div id="stage" style="width:32px;height:32px;background:red"></div><script>console.log("browser-diagnostic");window.SHOT={duration:0.25,fps:4,render(){}}</script>');
  for (const command of ['render', 'stills', 'verify']) {
    const good = await cli([command, shot, '--job-dir', directory]);
    assert.equal(good.final.ok, true, good.stdout + good.stderr);
    assert.match(good.stderr, /browser-diagnostic/);
    assert.ok(!good.stdout.includes('browser-diagnostic'));
    const job = path.join(directory, good.final.jobId);
    assert.equal(await readFile(path.join(job, 'events.jsonl'), 'utf8'), good.stdout);
    const status = await cli(['status', job]); assert.equal(status.final.data.state, 'succeeded');
    const cancel = await cli(['cancel', job]); assert.equal(cancel.final.data.state, 'succeeded');
    const bad = await cli([command, path.join(directory, 'absent.html'), '--job-dir', directory]);
    assert.equal(bad.final.code, 'shot_not_found');
  }
  assert.equal((await cli(['doctor'])).final.ok, true);
  const browserMissing = await cli(['doctor'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'missing-browsers') } });
  assert.equal(browserMissing.final.code, 'browser_not_installed'); assert.match(browserMissing.final.hint, /playwright install chromium/);
  const missing = path.join(directory, 'missing-ffmpeg');
  for (const command of ['doctor', 'render']) {
    const args = command === 'render' ? [command, shot] : [command];
    const bad = await cli([...args, '--ffmpeg', missing]);
    assert.equal(bad.final.code, 'ffmpeg_not_found'); assert.equal(bad.code, 3); assert.ok(bad.final.hint);
  }
  for (const command of ['status', 'cancel']) assert.equal((await cli([command, path.join(directory, 'absent-job')])).final.code, 'job_not_found');
  for (const flags of [['--unknown'], ['--at'], ['--at','0','--at','0']]) {
    const bad = await cli(['stills', shot, ...flags]); assert.equal(bad.final.code, 'invalid_option'); assert.equal(bad.events.length, 1);
  }
});

test('stateful verification provides metrics and three valid images per finding', async () => {
  const shot = path.join(directory, 'stateful.html');
  await writeFile(shot, '<style>body{margin:0}</style><div id="stage" style="width:32px;height:32px"></div><script>let n=0;window.SHOT={duration:1,fps:4,render(){document.querySelector("#stage").style.background=++n%2?"red":"blue"}}</script>');
  const bad = await cli(['verify', shot, '--at', '0,0.5', '--job-dir', directory]);
  assert.equal(bad.final.code, 'nondeterministic_output');
  const findings = bad.events.filter(e => e.type === 'finding');
  assert.ok(findings.length); assert.equal(bad.final.data.findings, findings.length);
  assert.equal(bad.final.artifacts.length, findings.length * 3);
  for (const finding of findings) {
    assert.equal(finding.details.check, 'reorder'); assert.equal(finding.details.changedPixels, 1024);
    assert.equal(finding.details.maxChannelDiff, 255); assert.deepEqual(finding.details.bbox, { x: 0, y: 0, w: 32, h: 32 });
    for (const file of Object.values(finding.details.images)) assert.equal(decodePNG(await readFile(file)).width, 32);
  }
});

test('concurrent same-name jobs isolate outputs and cancellation completes cleanup', { timeout: 60000 }, async () => {
  const shot = path.join(directory, 'long.html');
  await writeFile(shot, '<div id="stage" style="width:32px;height:32px;background:red"></div><script>window.SHOT={duration:100,fps:30,render(){}}</script>');
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['bin/multiplane','render',shot,'--workers','1','--job-dir',directory,'--json'], { windowsHide: true });
    let stdout = '', stderr = '', jobId;
    child.stdout.on('data', bytes => { stdout += bytes; for (const line of stdout.split('\n').slice(0,-1)) { const event = JSON.parse(line); if(event.type === 'start') jobId = event.jobId; } });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = new Promise(resolve => child.once('close', code => resolve({ code, get stdout(){return stdout;}, get stderr(){return stderr;} })));
    return { child, closed, get jobId(){return jobId;} };
  });
  try {
    const deadline = performance.now() + 20000;
    while (children.some(c => !c.jobId) && performance.now() < deadline) await setTimeout(50);
    assert.ok(children.every(c => c.jobId)); assert.notEqual(children[0].jobId, children[1].jobId);
    // Wait until capture is active, rather than cancelling during startup.
    while (performance.now() < deadline) {
      const states = await Promise.all(children.map(c => readFile(path.join(directory,c.jobId,'status.json'),'utf8').then(JSON.parse)));
      if (states.every(s => s.done > 0)) break;
      await setTimeout(100);
    }
    const cancelled = await Promise.all(children.map(c => cli(['cancel',path.join(directory,c.jobId),'--wait','20'])));
    for (const c of cancelled) { assert.equal(c.final.ok,true,c.stdout+c.stderr); assert.equal(c.final.data.state,'cancelled'); }
    for (const child of children) {
      const result = await child.closed;
      assert.equal(result.code,130,result.stderr);
      const events = result.stdout.trim().split('\n').map(JSON.parse); assert.equal(events.at(-1).code,'cancelled');
      const job = path.join(directory,child.jobId);
      assert.equal(await readFile(path.join(job,'events.jsonl'),'utf8'),result.stdout);
      assert.equal(JSON.parse(await readFile(path.join(job,'status.json'))).state,'cancelled');
      const index = (await readFile(path.join(process.env.MULTIPLANE_HOME, 'jobs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.jobId === child.jobId);
      assert.deepEqual(index.map(row => row.event), ['start', 'end']);
      assert.equal(index[1].state, 'cancelled');
      assert.ok(!(await readdir(job)).some(f=>f.endsWith('.partial.mp4')));
    }
  } finally { for(const c of children) if(c.child.exitCode===null)c.child.kill(); }
  const completed = await Promise.all([0,1].map(()=>cli(['stills',shot,'--at','0','--job-dir',directory])));
  assert.notEqual(completed[0].final.artifacts[0].path,completed[1].final.artifacts[0].path);
});

test('JS API errors retain code, details, final result and callback', async () => {
  const events = [];
  await assert.rejects(stillsShot('examples/animation.html', { at:'0', scale:0.333, 'job-dir':directory, onEvent:e=>events.push(e) }), error => {
    assert.ok(error instanceof MultiplaneError); assert.equal(error.code,'invalid_scale'); assert.equal(error.exitCode,2);
    assert.equal(error.result.code,error.code); assert.ok(error.hint); return true;
  });
  assert.equal(events.at(-1).type,'result');
});

test('known shot failures have specific codes and render time details', async () => {
  const cases = [
    ['contract', '<div></div>', 'shot_contract_invalid'],
    ['stage', '<script>window.SHOT={duration:1,render(){}}</script>', 'stage_size_invalid'],
    ['script', '<script>throw Error("fixture");</script>', 'shot_load_failed'],
    ['resource', '<img src="missing.png"><div id="stage" style="width:32px;height:32px"></div><script>window.SHOT={duration:1,render(){}}</script>', 'resource_failed'],
    ['render', '<div id="stage" style="width:32px;height:32px"></div><script>window.SHOT={duration:1,render(){throw Error("fixture")}}</script>', 'render_threw'],
  ];
  for (const [name, html, code] of cases) {
    const file = path.join(directory, name + '.html'); await writeFile(file, html);
    const result = await cli(['stills', file, '--at', '0', '--no-lint', '--job-dir', directory]);
    assert.equal(result.final.code, code, result.stdout);
    if (code === 'render_threw') assert.equal(result.final.details.t, 0);
  }
  const version = await run(process.execPath, ['bin/multiplane', '--version']);
  assert.equal(version.code, 0); assert.equal(version.stdout.trim(), '0.0.0');
});

test('existing outputs are preserved; vanished process status is synthesized without writing', async () => {
  const output = path.join(directory, 'existing.mp4'); await writeFile(output, 'keep');
  const result = await cli(['render', 'examples/animation.html', '--out', output, '--job-dir', directory]);
  assert.equal(result.final.code, 'output_exists'); assert.equal(await readFile(output, 'utf8'), 'keep');
  const job = path.join(directory, 'ghost'); await mkdir(job);
  const snapshot = { schema: 'multiplane/1', jobId: 'ghost', command: 'render', shot: null, pid: 2147483647,
    state: 'running', phase: 'load', done: 0, total: null, fps: null, etaMs: null,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: null };
  const original = JSON.stringify(snapshot); await writeFile(path.join(job, 'status.json'), original);
  const status = await cli(['status', job]);
  assert.equal(status.final.data.state, 'failed'); assert.equal(status.final.data.result.code, 'internal_error');
  assert.equal(await readFile(path.join(job, 'status.json'), 'utf8'), original);
});
