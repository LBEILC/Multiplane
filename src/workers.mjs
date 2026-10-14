import { cpus, availableParallelism, freemem, totalmem, release, arch } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { userHome } from './platform.mjs';
import { defaultWorkers } from './render-pool.mjs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
export const shotTypes = ['dom', 'canvas', 'three'];

export function memoryWorkers(scale = 1, hardware = {}) {
  const free = Math.min(hardware.free ?? freemem(), hardware.total ?? totalmem());
  return Math.max(0, Math.floor((free - 2 * 1024 ** 3) / ((0.25 + 0.1875 * scale * scale) * 1024 ** 3)));
}

export function benchmarkMachine(info, raster = 'gpu') {
  return { cpu: cpus().map(cpu => cpu.model), cores: availableParallelism(), memory: totalmem(),
    gpu: info.gpu, os: { platform: process.platform, release: release(), arch: arch() },
    chromium: info.chromium, version: packageVersion, raster };
}

export function readBenchmark(home = userHome()) {
  try { return JSON.parse(readFileSync(path.join(home, 'benchmark.json'), 'utf8')); }
  catch { return null; }
}

function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export function validBenchmark(record, machine) {
  return record?.schema === 'multiplane/1' && equal(record.machine, machine)
    && shotTypes.every(type => Number.isSafeInteger(record.shots?.[type]?.workers) && record.shots[type].workers > 0
      && Number.isFinite(record.shots[type].fps) && record.shots[type].fps > 0);
}

export function selectWorkers({ workers, source, record, machine, type, scale = 1, memoryScale = scale, hardware = {} }) {
  if (workers !== undefined && ['option', 'config'].includes(source)) return { workers, source };
  if (validBenchmark(record, machine) && shotTypes.includes(type)) {
    return { workers: Math.max(1, Math.min(record.shots[type].workers, memoryWorkers(memoryScale, hardware))), source: 'benchmark' };
  }
  return { workers: defaultWorkers(scale, hardware), source: 'estimate' };
}

// Inspect the loaded probe only; its context is discarded before real rendering.
export async function classifyShot(capture) {
  return capture.page.evaluate(() => {
    const canvases = [];
    const visit = root => {
      canvases.push(...root.querySelectorAll('canvas'));
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
    };
    visit(document);
    if (canvases.some(canvas => {
      try { return !canvas.getContext('2d') && !!(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')); }
      catch { return false; }
    })) return 'three';
    return canvases.length ? 'canvas' : 'dom';
  });
}
