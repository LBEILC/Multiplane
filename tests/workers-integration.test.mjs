import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { userHome } from '../src/platform.mjs';
import { launchBrowser, environment } from '../src/environment.mjs';
import { benchmarkMachine, classifyShot, shotTypes, readBenchmark, selectWorkers } from '../src/workers.mjs';
import { saveBenchmark } from '../src/benchmark.mjs';
import { renderShot } from '../src/render.mjs';
import { openShot } from '../src/capture.mjs';
import { doctor } from '../src/doctor.mjs';

fullTest('render applies typed cached workers, reports provenance, and doctor marks stale cache without failure', { timeout: 120000 }, async () => {
  const home = userHome(), root = path.join(home, 'shots');
  await mkdir(root, { recursive: true });
  const browser = await launchBrowser();
  let machine;
  try { machine = benchmarkMachine(await environment(browser)); }
  finally { await browser.close(); }
  const record = { schema: 'multiplane/1', testedAt: new Date().toISOString(), machine,
    shots: Object.fromEntries(shotTypes.map((type, i) => [type, { workers: i + 1, fps: 30 }])) };
  await saveBenchmark(record);
  const sources = {
    dom: "const draw = () => { document.querySelector('#stage').style.background = '#345'; };",
    canvas: "const c = document.querySelector('canvas').getContext('2d'); const draw = () => { c.fillStyle = '#345'; c.fillRect(0, 0, 64, 64); };",
    three: "const gl = document.querySelector('canvas').getContext('webgl'); const draw = () => { gl.clearColor(.2,.3,.4,1); gl.clear(gl.COLOR_BUFFER_BIT); };",
  };
  for (const type of shotTypes) {
    await writeFile(path.join(root, type + '.html'), `<!doctype html><link rel="icon" href="data:,"><style>html,body{margin:0}#stage{width:64px;height:64px}</style><div id="stage">${type === 'dom' ? '' : '<canvas width="64" height="64"></canvas>'}</div><script>${sources[type]}window.SHOT={duration:1,fps:12,render:draw};</script>`);
    const capture = await openShot(path.join(root, type + '.html'), 1, { root });
    try { assert.equal(await classifyShot(capture), type); }
    finally { await capture.close(); }
  }
  const run = async (type, source, workers, extra = {}) => {
    const events = [];
    const result = await renderShot(type + '.html', { root, 'job-dir': path.join(home, 'jobs'), 'no-post': true,
      'no-lint': true, _resources: false, _preview: false, onEvent: event => events.push(event), ...extra });
    assert.equal(result.ok, true);
    assert.equal(events[0].workersSource, source);
    assert.equal(result.data.resources.workersSource, source);
    if (workers !== undefined) {
      assert.equal(events[0].options.workers, workers);
      assert.equal(result.data.resources.workers, Math.min(workers, 3));
    }
    return result;
  };
  for (const [index, type] of shotTypes.entries()) await run(type, 'benchmark', index + 1);
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ workers: 2 }));
  await run('dom', 'config', 2);
  await run('dom', 'option', 1, { workers: 1 });
  await unlink(path.join(home, 'config.json'));
  assert.equal((await doctor()).data.checks.find(check => check.name === 'benchmark').ok, true);
  await saveBenchmark({ ...record, machine: { ...machine, version: 'older' } });
  await run('dom', 'estimate');
  const stale = await doctor();
  assert.equal(stale.ok, true);
  const check = stale.data.checks.find(check => check.name === 'benchmark');
  assert.equal(check.ok, false); assert.match(check.detail, /benchmark/);
  await unlink(path.join(home, 'benchmark.json'));
  await run('dom', 'estimate');
});


test('stored typed recommendations retain provenance and stale records fall back without rendering', async () => {
  const home = path.join(userHome(), 'quick-workers');
  await mkdir(home, { recursive: true });
  const machine = benchmarkMachine({ chromium: 'fixture', gpu: { renderer: 'fixture' } });
  const record = { schema: 'multiplane/1', machine,
    shots: Object.fromEntries(shotTypes.map((type, i) => [type, { workers: i + 1, fps: 30 }])) };
  await saveBenchmark(record, { home });
  const hardware = { cores: 16, free: 16 * 1024 ** 3, total: 16 * 1024 ** 3 };
  const cached = readBenchmark(home);
  for (const [i, type] of shotTypes.entries()) {
    const input = { record: cached, machine, type, hardware };
    assert.deepEqual(selectWorkers(input), { workers: i + 1, source: 'benchmark' });
    assert.deepEqual(selectWorkers({ ...input, workers: 7, source: 'config' }), { workers: 7, source: 'config' });
    assert.deepEqual(selectWorkers({ ...input, workers: 1, source: 'option' }), { workers: 1, source: 'option' });
    assert.equal(selectWorkers({ ...input, machine: { ...machine, version: 'older' } }).source, 'estimate');
    assert.equal(selectWorkers({ ...input, record: null }).source, 'estimate');
  }
});
