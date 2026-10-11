import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { run, createTempDirectory } from './helpers.mjs';
import { cancelJob, statusJob, stillsShot, verifyShot, renderShot } from '../src/index.mjs';
import { publishVideo } from '../src/artifacts.mjs';
import { decodePNG } from '../src/png.mjs';
import { warnGpuFallback } from '../src/environment.mjs';

await mkdir('out/tests', { recursive: true });
const root = createTempDirectory(path.resolve('out/tests/lint-protocol-'));
const shot = path.join(root, 'tiny.html');
const html = '<div id="stage" style="width:32px;height:32px;background:red"></div><script>window.SHOT={duration:0.25,fps:4,render(){}}</script>';
await writeFile(shot, html);
const opts = { 'job-dir': root };

test('each command exposes human-readable help even with --json', async () => {
  for (const command of ['render', 'stills', 'verify', 'lint', 'doctor', 'status', 'cancel']) {
    const result = await run(process.execPath, ['bin/multiplane', command, '--help', '--json']);
    assert.equal(result.code, 0); assert.ok(result.stdout.startsWith('Usage: multiplane ' + command));
    assert.match(result.stdout, /--json/); assert.ok(!result.stdout.includes('"schema"'));
    if (['render', 'stills', 'verify'].includes(command)) assert.match(result.stdout, /--overwrite/);
  }
});
test('missing and corrupt snapshots use job_not_found; wait timeout retains snapshot', async () => {
  for (const value of ['not json', 'null', '{}', '{"schema":"multiplane/1","pid":1,"state":"invalid"}']) {
    const job = createTempDirectory(path.join(root, 'corrupt-')); await writeFile(path.join(job, 'status.json'), value);
    for (const action of [statusJob, cancelJob]) await assert.rejects(action(job), { code: 'job_not_found', exitCode: 2 });
  }
  const job = createTempDirectory(path.join(root, 'waiting-'));
  await writeFile(path.join(job, 'status.json'), JSON.stringify({ schema: 'multiplane/1', pid: process.pid, state: 'running' }));
  await assert.rejects(cancelJob(job, { wait: 0 }), error => error.code === 'cancel_timeout' && error.exitCode === 1 && error.result.data.state === 'running');
});
test('doctor reports unsupported_node, dedicated software warning and a single-line reason', async () => {
  const preload = path.join(root, 'old-node.mjs');
  await writeFile(preload, 'Object.defineProperty(process.versions,"node",{value:"22.0.0"});');
  const old = await run(process.execPath, ['--import',pathToFileURL(preload).href,'bin/multiplane','doctor','--json']);
  assert.equal(old.code, 3); assert.equal(JSON.parse(old.stdout.trim().split('\n').at(-1)).code, 'unsupported_node');
  const missing = await run(process.execPath, ['bin/multiplane','doctor','--json'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'no-browser') } });
  const final = JSON.parse(missing.stdout.trim().split('\n').at(-1));
  assert.equal(final.code, 'browser_not_installed'); assert.ok(!/[\r\n╔║]/.test(final.details.reason));
  const software = await run(process.execPath, ['bin/multiplane','doctor','--raster','software','--json']);
  const events = software.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(software.code, 0, software.stdout);
  assert.ok(!events.some(e => e.type === 'warning' && e.code === 'gpu_software_fallback'));
  const warnings = [], sink = { emit: (type, event) => warnings.push({ type, ...event }) };
  warnGpuFallback(sink, { gpu: { hardware: false } }, { raster: 'gpu' });
  assert.deepEqual(warnings.map(e => [e.type, e.code]), [['warning', 'gpu_software_fallback']]);
  warnGpuFallback(sink, { gpu: { hardware: true } }, { raster: 'gpu' });
  warnGpuFallback(sink, { gpu: { hardware: false } }, { raster: 'software' });
  assert.equal(warnings.length, 1);
});
test('default verification times are unique for sub-frame-duration shots', async () => {
  const result = await verifyShot(shot, opts);
  assert.deepEqual(result.data.times, [0]);
});
test('overwrite replaces completed output only, for video and both directory commands', { timeout: 120000 }, async () => {
  for (const [command, action] of [['render', renderShot], ['stills', stillsShot], ['verify', verifyShot]]) {
    const out = path.join(root, command === 'render' ? 'existing.mp4' : command);
    if (command === 'render') await writeFile(out, 'original');
    else { await mkdir(out); await writeFile(path.join(out, 'original.txt'), 'original'); }
    const original = command === 'render' ? out : path.join(out, 'original.txt');
    await assert.rejects(action(shot, { ...opts, out }), { code: 'output_exists', exitCode: 2 });
    assert.equal(await readFile(original, 'utf8'), 'original');
    const failed = path.join(root, 'failed.html'); await writeFile(failed, html.replace('render(){}', 'render(){throw Error("fixture")}'));
    await assert.rejects(action(failed, { ...opts, out, overwrite: true }), { code: 'render_threw' });
    assert.equal(await readFile(original, 'utf8'), 'original');
    const events = [];
    const result = await action(shot, { ...opts, out, overwrite: true, onEvent: e => events.push(e) });
    assert.equal(result.ok, true); assert.ok(result.artifacts.length);
    for (const a of result.artifacts) { assert.ok(a.path.startsWith(out)); assert.equal((await readFile(a.path)).length, a.bytes); }
    assert.ok(!events.filter(e => e.type === 'artifact').some(e => e.path.includes('.partial-')));
    if (command === 'stills') {
      const bypass = await stillsShot(shot, { ...opts, 'no-lint': true });
      assert.deepEqual(decodePNG(await readFile(result.artifacts[0].path)), decodePNG(await readFile(bypass.artifacts[0].path)));
    }
  }
  assert.ok(!(await readdir(root)).some(f => f.includes('.partial-') || f.endsWith('.previous') || f.endsWith('.partial.mp4')));
  const target = path.join(root, 'publish.mp4'); await writeFile(target, 'keep');
  await assert.rejects(publishVideo(path.join(root, 'missing-partial'), target, true));
  assert.equal(await readFile(target, 'utf8'), 'keep');
});
test('failed overwrite verification retains diff artifacts without destroying old output', async () => {
  const out = path.join(root, 'preserved-verify'); await mkdir(out); await writeFile(path.join(out, 'report.json'), 'old');
  const stateful = path.join(root, 'stateful.html');
  await writeFile(stateful, html.replace('window.SHOT', 'let n=0;window.SHOT').replace('render(){}', 'render(){document.querySelector("#stage").style.opacity=++n%2?"1":"0"}'));
  await assert.rejects(verifyShot(stateful, { ...opts, out, overwrite: true }), asyncError => {
    assert.equal(asyncError.code, 'nondeterministic_output'); assert.equal(asyncError.result.artifacts.length, 3);
    return true;
  });
  assert.equal(await readFile(path.join(out, 'report.json'), 'utf8'), 'old');
});
test('warnings flow through jobs without blocking capture', async () => {
  const warning = path.join(root, 'warning.html'); await writeFile(warning, html + '<script>setTimeout(()=>{},0)</script>');
  const events = [];
  const result = await stillsShot(warning, { ...opts, onEvent: e => events.push(e) });
  assert.equal(result.ok, true); assert.ok(events.some(e => e.type === 'finding' && e.code === 'timer_driven'));
});
