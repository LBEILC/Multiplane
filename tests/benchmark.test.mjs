import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { benchmarkCurves, measureBenchmark, recommendedPoint, saveBenchmark } from '../src/benchmark.mjs';
import { benchmarkMachine, memoryWorkers, selectWorkers, validBenchmark, readBenchmark, classifyShot, shotTypes } from '../src/workers.mjs';
import { loadUserConfig } from '../src/user-home.mjs';
import { createEvents } from '../src/events.mjs';
import { defaultWorkers } from '../src/render-pool.mjs';
import { userHome } from '../src/platform.mjs';
import { benchmarkCheck } from '../src/doctor.mjs';
import { run } from './helpers.mjs';

const hardware = { cores: 32, free: 16 * 1024 ** 3, total: 32 * 1024 ** 3 };
const machine = benchmarkMachine({ chromium: 'test-browser', gpu: { renderer: 'test-gpu', hardware: true } });
const record = { schema: 'multiplane/1', testedAt: '2026-01-01T00:00:00.000Z', machine,
  shots: Object.fromEntries(shotTypes.map((type, i) => [type, { workers: [6, 4, 2][i], fps: 30 }])) };

test('complete fixed sweep crosses falling throughput and selects the smallest point within 95%', async () => {
  let clock = 0;
  const calls = [];
  const curve = { 1: 10, 2: 20, 4: 76, 6: 63, 8: 70, 12: 96, 16: 100, 24: 90 };
  const shots = await benchmarkCurves({ maxWorkers: 64, cores: 64, memory: () => 64, now: () => clock,
    measure: async (type, workers, { count }) => {
      calls.push([type, workers]);
      return measureBenchmark(type, workers, { count, now: () => clock,
        createPool: () => ({
          async *frames(first, end) { clock += end * 1000 / curve[workers]; yield {}; },
          async close() {},
        }),
      });
    } });
  for (const type of shotTypes) {
    assert.deepEqual(calls.filter(call => call[0] === type).map(call => call[1]), [1, 2, 4, 6, 8, 12, 16, 24]);
    assert.equal(shots[type].workers, 12);
    assert.ok(Math.abs(shots[type].fps - 96) < 1e-8);
  }
  assert.deepEqual(recommendedPoint([{ workers: 4, fps: 100 }, { workers: 1, fps: 95 }, { workers: 2, fps: 99 }]), { workers: 1, fps: 95 });
});

test('two timed samples share one warmed pool and average throughput, not duration', async () => {
  let clock = 0, created = 0, closed = 0;
  const ranges = [], pools = [];
  const fps = await measureBenchmark('dom', 4, { count: 24, now: () => clock, onPool: pool => pools.push(pool),
    createPool: () => {
      created++;
      return {
        async *frames(first, end) { ranges.push([first, end]); clock += [5000, 1000, 2000][ranges.length - 1]; yield {}; },
        async close() { closed++; },
      };
    } });
  assert.equal(fps, 18);
  assert.equal(created, 1); assert.equal(closed, 1);
  assert.deepEqual(ranges, [[0, 4], [0, 24], [0, 24]]);
  assert.equal(pools.length, 2); assert.equal(pools[1], undefined);
});

test('failed or invalid second samples close the shared pool without returning a partial average', async () => {
  for (const failure of ['invalid', 'interrupted']) {
    let clock = 0, batches = 0, closed = 0;
    await assert.rejects(measureBenchmark('dom', 1, { now: () => clock,
      createPool: () => ({
        async *frames() {
          batches++;
          if (batches === 3 && failure === 'interrupted') throw Error('interrupted');
          if (batches < 3) clock += 1000;
          yield {};
        },
        async close() { closed++; },
      }),
    }), failure === 'invalid' ? /Invalid benchmark throughput/ : /interrupted/);
    assert.equal(batches, 3); assert.equal(closed, 1);
  }
});

test('CPU, memory and explicit limits bound the sweep, which requires workers 1 and 2', async () => {
  assert.equal(memoryWorkers(1, { free: 2 * 1024 ** 3, total: 8 * 1024 ** 3 }), 0);
  assert.equal(memoryWorkers(1, { free: 4 * 1024 ** 3, total: 3 * 1024 ** 3 }), 2);
  assert.ok(memoryWorkers(2, hardware) < memoryWorkers(1, hardware));
  const options = { measure: async (_, workers) => workers * 10, now: () => 0, cores: 64 };
  for (const [maxWorkers, cores, memoryLimit] of [[2, 64, 64], [3, 64, 64], [64, 7, 64], [64, 64, 12]]) {
    const shots = await benchmarkCurves({ ...options, maxWorkers, cores, memory: () => memoryLimit });
    const expected = [1, 2, 4, 6, 8, 12, 16, 24].filter(n => n <= Math.min(maxWorkers, cores, memoryLimit));
    for (const shot of Object.values(shots)) {
      assert.deepEqual(shot.points.map(point => point.workers), expected);
      assert.equal(shot.limitedBy, memoryLimit === 12 ? 'memory' : undefined);
      assert.equal(shot.stoppedWorkers, memoryLimit === 12 ? 16 : undefined);
    }
  }
  await assert.rejects(benchmarkCurves({ ...options, maxWorkers: 1, memory: () => 64 }), /requires workers 1 and 2/);
  await assert.rejects(benchmarkCurves({ ...options, maxWorkers: 8, cores: 1, memory: () => 64 }), /requires workers 1 and 2/);
});

test('memory loss saves measured curves and caps later types even after memory recovers', async () => {
  const calls = [], memoryChecks = [];
  let available = 64;
  const shots = await benchmarkCurves({ maxWorkers: 24, cores: 64, now: () => 0,
    memory: () => { const value = available; memoryChecks.push(value); available = 64; return value; },
    measure: async (type, workers) => {
      calls.push([type, workers]);
      if (type === 'dom' && workers === 4) available = 3;
      return { 1: 10, 2: 96, 4: 100 }[workers];
    } });
  assert.deepEqual(calls, [['dom', 1], ['dom', 2], ['dom', 4], ['canvas', 1], ['canvas', 2], ['three', 1], ['three', 2]]);
  assert.equal(memoryChecks.length, calls.length + 1);
  for (const type of shotTypes) {
    const shot = shots[type];
    assert.equal(shot.workers, 2);
    assert.equal(shot.fps, 96);
    assert.equal(shot.limitedBy, 'memory');
    assert.equal(shot.stoppedWorkers, type === 'dom' ? 6 : 4);
    assert.equal(shot.detail, `受内存限制，只测到 ${type === 'dom' ? 4 : 2} 个并发。`);
  }
  const home = path.join(userHome(), 'benchmark-memory-partial');
  await saveBenchmark(record, { home });
  const partial = { ...record, shots };
  await saveBenchmark(partial, { home });
  assert.deepEqual(readBenchmark(home), partial);
  assert.equal(validBenchmark(readBenchmark(home), machine), true);
  const check = benchmarkCheck(readBenchmark(home), machine);
  assert.equal(check.ok, true);
  assert.match(check.detail, /dom: 受内存限制，只测到 4 个并发/);
  assert.match(check.detail, /canvas: 受内存限制，只测到 2 个并发/);
  assert.match(check.detail, /three: 受内存限制，只测到 2 个并发/);
  const stale = benchmarkCheck(partial, { ...machine, raster: 'other' });
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /已过期/);
  assert.match(stale.detail, /受内存限制/);
  assert.doesNotMatch(benchmarkCheck(record, machine).detail, /受内存限制/);
});

test('insufficient memory before completing workers 1 and 2 in any type preserves the old cache', async () => {
  const home = path.join(userHome(), 'benchmark-memory-failure');
  await saveBenchmark(record, { home });
  for (const failureType of shotTypes) {
    for (const completed of [0, 1]) {
      let available = failureType === 'dom' ? completed : 64;
      const calls = [];
      await assert.rejects((async () => {
        const shots = await benchmarkCurves({ maxWorkers: 4, cores: 64, now: () => 0, memory: () => available,
          measure: async (type, workers) => {
            calls.push([type, workers]);
            if (workers === 4 && shotTypes[shotTypes.indexOf(type) + 1] === failureType) available = completed;
            return workers * 10;
          } });
        await saveBenchmark({ ...record, shots }, { home });
      })(), /Insufficient free memory/);
      assert.deepEqual(calls.filter(([type]) => type === failureType).map(([, workers]) => workers), completed ? [1] : []);
      assert.deepEqual(readBenchmark(home), record);
      assert.deepEqual(await readdir(home), ['benchmark.json']);
    }
  }
});

test('budget pressure reduces frame counts without dropping points; exhaustion cancels', async () => {
  let clock = 0;
  const counts = [];
  const shots = await benchmarkCurves({ maxWorkers: 64, cores: 64, memory: () => 64, budgetMs: 9000, now: () => clock,
    measure: async (_, workers, { count }) => {
      counts.push({ workers, count }); clock += count * 20; return workers * 10;
    } });
  assert.ok(clock < 9000);
  assert.ok(counts.some(({ workers, count }) => count < Math.max(24, workers * 4)));
  assert.ok(counts.every(({ workers, count }) => Number.isInteger(count) && count >= workers));
  assert.ok(Object.values(shots).every(shot => shot.points.length === 8));
  clock = 0;
  await assert.rejects(benchmarkCurves({ maxWorkers: 2, cores: 2, memory: () => 2, now: () => clock, budgetMs: 100,
    measure: async () => { clock += 101; return 1; } }), { code: 'cancelled' });
});

test('cancellation before and during measurement does not complete a curve', async () => {
  let stopped = true, calls = 0;
  const check = () => { if (stopped) throw Error('interrupted'); };
  const options = { maxWorkers: 8, memory: () => 8, check,
    measure: async () => { calls++; stopped = true; return 10; } };
  await assert.rejects(benchmarkCurves(options), /interrupted/);
  assert.equal(calls, 0);
  stopped = false;
  await assert.rejects(benchmarkCurves(options), /interrupted/);
  assert.equal(calls, 1);
});

test('cache checks every machine field, ignores object key order and rejects malformed recommendations', () => {
  assert.equal(validBenchmark(record, structuredClone(machine)), true);
  assert.equal(validBenchmark(record, Object.fromEntries(Object.entries(machine).reverse())), true);
  for (const field of Object.keys(machine)) assert.equal(validBenchmark(record, { ...machine, [field]: 'changed' }), false, field);
  for (const value of [0, -1, 1.5, '2', null]) {
    const bad = structuredClone(record); bad.shots.dom.workers = value;
    assert.equal(validBenchmark(bad, machine), false);
  }
  assert.equal(validBenchmark(null, machine), false);
  assert.equal(validBenchmark({ ...record, schema: 'other' }, machine), false);
});

test('option > config > matching benchmark > estimate, with memory clipping only for auto', () => {
  const common = { record, machine, type: 'dom', hardware };
  assert.deepEqual(selectWorkers({ ...common, workers: 100, source: 'option' }), { workers: 100, source: 'option' });
  assert.deepEqual(selectWorkers({ ...common, workers: 7, source: 'config' }), { workers: 7, source: 'config' });
  for (const type of shotTypes) assert.deepEqual(selectWorkers({ ...common, type }), { workers: record.shots[type].workers, source: 'benchmark' });
  assert.deepEqual(selectWorkers({ ...common, hardware: { ...hardware, free: 3 * 1024 ** 3 } }), { workers: 2, source: 'benchmark' });
  assert.deepEqual(selectWorkers({ ...common, hardware: { ...hardware, free: 0 } }), { workers: 1, source: 'benchmark' });
  assert.deepEqual(selectWorkers({ ...common, machine: { ...machine, raster: 'software' } }), { workers: defaultWorkers(1, hardware), source: 'estimate' });
  assert.deepEqual(selectWorkers({ ...common, record: null, memoryScale: 4 }), { workers: defaultWorkers(1, hardware), source: 'estimate' });
});

test('atomic cache publishing preserves old results on interruption and never touches config', async () => {
  const home = path.join(userHome(), 'benchmark-storage');
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'benchmark.json');
  await writeFile(path.join(home, 'config.json'), '{"workers":7}');
  await saveBenchmark(record, { home });
  assert.deepEqual(readBenchmark(home), record);
  let checks = 0;
  await assert.rejects(saveBenchmark({ ...record, testedAt: 'new' }, { home, check: () => { if (++checks === 2) throw Error('interrupted'); } }), /interrupted/);
  assert.deepEqual(readBenchmark(home), record);
  assert.equal(await readFile(path.join(home, 'config.json'), 'utf8'), '{"workers":7}');
  assert.deepEqual((await readdir(home)).sort(), ['benchmark.json', 'config.json']);
  await writeFile(file, '{broken');
  assert.equal(readBenchmark(home), null);
});

test('benchmark uses configured raster only; start reports the selected worker origin', async () => {
  const home = path.join(userHome(), 'benchmark-config');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ raster: 'software', workers: 7 }));
  assert.deepEqual(loadUserConfig('benchmark', {}, { MULTIPLANE_HOME: home }).options, { raster: 'software' });
  assert.deepEqual(loadUserConfig('benchmark', { raster: 'gpu' }, { MULTIPLANE_HOME: home }).options, { raster: 'gpu' });
  const emitted = [];
  const events = createEvents('render', 'shot.html', { workers: 4, onEvent: e => emitted.push(e) }, false, true);
  events.workersSource = 'benchmark'; events.start(true); events.dispose();
  assert.equal(emitted[0].workersSource, 'benchmark'); assert.equal(emitted[0].options.workers, 4);
});

test('loaded shot classification gives WebGL precedence over 2D canvas, including shadow roots', async () => {
  const previous = globalThis.document;
  const root = (canvases, children = []) => ({ querySelectorAll: selector => selector === 'canvas' ? canvases : children });
  const classify = async document => {
    globalThis.document = document;
    return classifyShot({ page: { evaluate: fn => fn() } });
  };
  try {
    assert.equal(await classify(root([])), 'dom');
    assert.equal(await classify(root([{ getContext: () => ({}) }])), 'canvas');
    const webgl = { getContext: type => type === 'webgl' ? {} : null };
    assert.equal(await classify(root([{ getContext: () => ({}) }, webgl])), 'three');
    assert.equal(await classify(root([], [{ shadowRoot: root([webgl]) } ])), 'three');
    assert.equal(await classify(root([{ getContext: () => null }])), 'canvas');
  } finally { globalThis.document = previous; }
});

test('benchmark CLI rejects invalid limits, raster, targets and unsupported options without running a browser', async () => {
  for (const args of [['--max-workers', '0'], ['--max-workers', '1.5'], ['--raster', 'bad'], ['extra'], ['--workers', '2']]) {
    const result = await run(process.execPath, ['bin/multiplane', 'benchmark', '--json', ...args]);
    assert.equal(result.code, 2, result.stderr);
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).code, 'invalid_option');
  }
});
