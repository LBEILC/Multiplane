import { defaultWorkers } from '../../src/render-pool.mjs';
import { measureBenchmark } from '../../src/benchmark.mjs';
import { readBenchmark, validBenchmark, benchmarkMachine, shotTypes } from '../../src/workers.mjs';
import { launchBrowser, environment } from '../../src/environment.mjs';
import { stopSignals } from '../../src/platform.mjs';

// Compare an existing cache against the old formula without replacing it.
const record = readBenchmark();
if (!record) throw Error('Run multiplane benchmark first, using the same MULTIPLANE_HOME.');
const raster = record.machine.raster;
let browser, pool, stopped = false;
const stop = () => { stopped = true; void browser?.close().catch(() => {}); void pool?.cancel().catch(() => {}); };
const check = () => { if (stopped) throw Error('Comparison interrupted.'); };
const signals = stopSignals();
for (const signal of signals) process.on(signal, stop);
try {
  browser = await launchBrowser({ raster });
  check();
  if (!validBenchmark(record, benchmarkMachine(await environment(browser), raster))) throw Error('Benchmark is stale; retest before comparing.');
  await browser.close(); browser = undefined;
  const estimate = defaultWorkers(1);
  const rows = [];
  for (const type of shotTypes) {
    const options = { raster, check, onPool: value => { pool = value; } };
    const workers = record.shots[type].workers;
    const fps = await measureBenchmark(type, workers, options);
    const estimateFps = workers === estimate ? fps : await measureBenchmark(type, estimate, options);
    rows.push({ type, workers, fps, estimate, estimateFps, improvementPercent: (fps / estimateFps - 1) * 100 });
  }
  check();
  console.log(JSON.stringify(rows, null, 2));
} finally {
  for (const signal of signals) process.off(signal, stop);
  await browser?.close(); await pool?.close();
}
