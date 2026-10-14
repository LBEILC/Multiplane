import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { runCommand } from './events.mjs';
import { launchBrowser, environment, warnGpuFallback } from './environment.mjs';
import { createRenderPool } from './render-pool.mjs';
import { benchmarkMachine, memoryWorkers, shotTypes } from './workers.mjs';
import { userHome, stopSignals } from './platform.mjs';
import { invalidOption, MultiplaneError } from './errors.mjs';

export function recommendedPoint(points) {
  const threshold = Math.max(...points.map(point => point.fps)) * 0.95;
  return points.filter(point => point.fps >= threshold).sort((a, b) => a.workers - b.workers)[0];
}

export async function benchmarkCurves({ measure, maxWorkers, cores = availableParallelism(), memory = () => memoryWorkers(), check = () => {}, now = () => performance.now(), budgetMs = 170000 }) {
  const shots = {}, deadline = now() + budgetMs;
  const limit = Math.min(maxWorkers, cores);
  const candidates = [1, 2, 4, 6, 8, 12, 16, 24].filter(workers => workers <= limit);
  if (!candidates.includes(2)) throw new MultiplaneError('internal_error', 'Benchmark requires workers 1 and 2 for every shot type; no result was saved.');
  let memoryLimit = Infinity, lastCost = 0, frameScale = 1;
  for (const type of shotTypes) {
    const points = [];
    let stoppedWorkers;
    for (const workers of candidates) {
      check();
      // Keep a memory ceiling for later shot types, even if free memory recovers.
      if (workers > memoryLimit) { stoppedWorkers = workers; break; }
      const available = memory();
      if (workers > available) {
        memoryLimit = Math.min(memoryLimit, available);
        stoppedWorkers = workers;
        break;
      }
      if (now() >= deadline) throw new MultiplaneError('cancelled', 'Benchmark time budget exceeded; no result was saved.');
      // Divide the time budget only among points still allowed by memory.
      const remaining = candidates.filter(n => n >= workers && n <= memoryLimit).length
        + (shotTypes.length - shotTypes.indexOf(type) - 1) * candidates.filter(n => n <= memoryLimit).length;
      const allowance = (deadline - now()) / remaining;
      if (lastCost > allowance) frameScale *= allowance / lastCost;
      const count = Math.max(workers, Math.floor(Math.max(24, workers * 4) * frameScale));
      const started = now();
      const fps = await measure(type, workers, { count });
      check();
      if (now() >= deadline) throw new MultiplaneError('cancelled', 'Benchmark time budget exceeded; no result was saved.');
      if (!Number.isFinite(fps) || fps <= 0) throw new MultiplaneError('internal_error', 'Invalid benchmark throughput.');
      lastCost = now() - started;
      points.push({ workers, fps });
    }
    if (!points.some(point => point.workers === 2)) throw new MultiplaneError('internal_error', 'Insufficient free memory to benchmark workers 1 and 2 for every shot type; no result was saved.');
    shots[type] = { ...recommendedPoint(points), points,
      ...(stoppedWorkers === undefined ? {} : { limitedBy: 'memory', stoppedWorkers,
        detail: `受内存限制，只测到 ${points.at(-1).workers} 个并发。` }) };
  }
  check();
  return shots;
}

export async function saveBenchmark(record, { home = userHome(), check = () => {} } = {}) {
  const file = path.join(home, 'benchmark.json'), temporary = file + '.' + randomUUID() + '.tmp';
  await mkdir(home, { recursive: true });
  try {
    check();
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    check();
    // Commit synchronously with the last cancellation check; no event-loop gap.
    renameSync(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function measureBenchmark(type, workers, { raster = 'gpu', check = () => {}, onWarning, onPool = () => {}, count = Math.max(24, workers * 4), createPool = createRenderPool, now = () => performance.now() } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const names = { dom: 'dom-light', canvas: 'canvas-2d', three: 'webgl' };
  const fps = Math.max(30, Math.ceil(count / 2));
  check();
  const pool = createPool(path.join(root, 'tools/bench/shots', names[type] + '.html'),
    { root, raster, scale: 1, 'render-scale': 1, 'no-post': true, 'no-static-reuse': true, transport: 'raw' },
    fps, workers, { width: 1920, height: 1080 }, onWarning);
  onPool(pool);
  try {
    // Warm every worker, excluding browser startup from capture throughput.
    for await (const frame of pool.frames(0, workers)) { check(); }
    const samples = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      check();
      const start = now();
      for await (const frame of pool.frames(0, count)) { check(); }
      const throughput = count * 1000 / (now() - start);
      if (!Number.isFinite(throughput) || throughput <= 0) throw new MultiplaneError('internal_error', 'Invalid benchmark throughput.');
      samples.push(throughput);
    }
    return (samples[0] + samples[1]) / 2;
  } finally { await pool.close(); onPool(undefined); }
}

export const benchmark = (options = {}) => runCommand('benchmark', null, options, async events => {
  options = events.options;
  const raster = options.raster ?? 'gpu';
  if (!['gpu', 'software'].includes(raster)) throw invalidOption('--raster', '--raster must be gpu or software.');
  const maxWorkers = Number(options['max-workers'] ?? Math.max(1, availableParallelism()));
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) throw invalidOption('--max-workers', '--max-workers must be a positive integer.');
  let browser, pool, stopped = false;
  const stop = () => { if (stopped) return; stopped = true; void browser?.close().catch(() => {}); void pool?.cancel().catch(() => {}); };
  const check = () => { if (stopped) throw new MultiplaneError('cancelled', 'Benchmark interrupted; no result was saved.'); };
  const signals = stopSignals();
  for (const signal of signals) process.on(signal, stop);
  // Reserve cleanup time inside the three-minute command budget.
  const timer = setTimeout(stop, 175000);
  const started = performance.now();
  try {
    browser = await launchBrowser({ raster });
    check();
    const info = await environment(browser);
    const machine = benchmarkMachine(info, raster);
    warnGpuFallback(events, info, { raster });
    await browser.close(); browser = undefined;
    const shots = await benchmarkCurves({ maxWorkers, check, budgetMs: Math.max(1, 170000 - (performance.now() - started)),
      measure: async (type, workers, { count }) => {
        const fps = await measureBenchmark(type, workers, { raster, check, count, onWarning: events.warning, onPool: value => { pool = value; } });
        events.emit('progress', { phase: 'capture', done: count * 2, total: count * 2, unit: 'frame', fps, etaMs: 0 });
        return fps;
      } });
    check();
    // TODO(design): Document the benchmark result and cache fields in the protocol.
    const record = { schema: 'multiplane/1', testedAt: new Date().toISOString(), machine, shots };
    await saveBenchmark(record, { check });
    return record;
  } catch (error) {
    check();
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, stop);
    await browser?.close();
    await pool?.close();
  }
}, false);
