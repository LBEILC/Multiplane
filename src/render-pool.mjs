import { recoveryBudget } from './browser-recovery.mjs';
import { MultiplaneError } from './errors.mjs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';

export function defaultWorkers(scale = 1, hardware = {}) {
  const cores = hardware.cores ?? availableParallelism();
  const free = Math.min(hardware.free ?? freemem(), hardware.total ?? totalmem());
  const workerBytes = (0.25 + 0.1875 * scale * scale) * 1024 ** 3;
  return Math.max(1, Math.min(12, Math.floor(cores / 2), Math.floor((free - 2 * 1024 ** 3) / workerBytes)));
}

export function createRenderPool(shot, options, fps, workers, size, onWarning) {
  options = { ...options, _browserRecovery: options._browserRecovery ?? recoveryBudget() };
  const slots = [], stats = { frames: 0, samples: 0, staticFrames: 0 };
  let failure;
  for (let i = 0; i < workers; i++) {
    const worker = new Worker(new URL('./render-worker.mjs', import.meta.url), { workerData: { shot, options, fps, size } });
    const slot = { worker, pending: null, closed: false };
    const fail = error => {
      failure ??= error;
      for (const s of slots) { s.pending?.reject(error); s.pending = null; }
    };
    slot.ready = new Promise((resolve, reject) => { slot.pending = { resolve, reject }; });
    slot.ready.catch(() => {});
    worker.on('message', message => {
      if (message.type === 'warning') { onWarning?.(message.warning); return; }
      if (message.type === 'failure') { fail(new MultiplaneError(message.code ?? 'worker_crashed', message.error, { details: message.details, hint: message.hint })); return; }
      const pending = slot.pending; slot.pending = null;
      pending?.resolve(message);
    });
    worker.on('error', error => fail(new MultiplaneError('worker_crashed', undefined, { cause: error })));
    slot.exited = new Promise(resolve => worker.on('exit', code => {
      slot.closed = true;
      if (slot.pending || code !== 0) fail(new MultiplaneError('worker_crashed', `Rendering worker exited early: ${code}`));
      resolve();
    }));
    slots.push(slot);
  }
  return {
    stats,
    progress: () => `Samples: ${stats.samples}; static: ${stats.staticFrames}; adaptive: ${stats.adaptiveFrames ?? 0}; hooks: ${stats.hookFrames ?? 0}`,
    async *frames(first, end) {
      await Promise.all(slots.map(s => s.ready));
      const queue = [], chunk = options.transport === 'raw' ? 1 : 4;
      let next = first;
      const schedule = slot => {
        if (next >= end) return;
        if (failure) throw failure;
        const begin = next;
        next = Math.min(end, next + chunk);
        const promise = new Promise((resolve, reject) => { slot.pending = { resolve, reject }; });
        promise.catch(() => {});
        slot.worker.postMessage({ type: 'render', first: begin, end: next });
        queue.push({ slot, promise });
      };
      for (const slot of slots) schedule(slot);
      while (queue.length) {
        const { slot, promise } = queue.shift();
        const batch = await promise;
        if (failure) throw failure;
        for (const [key, value] of Object.entries(batch.stats)) stats[key] = (stats[key] ?? 0) + value;
        if (options.transport === 'raw') schedule(slot);
        for (const [i, png] of batch.frames.entries()) yield { frame: batch.first + i, png, hash: batch.hashes?.[i] };
        if (options.transport !== 'raw') schedule(slot);
      }
    },
    async close() {
      for (const slot of slots) if (!slot.closed) slot.worker.postMessage({ type: 'close' });
      await Promise.all(slots.map(s => s.exited));
    },
    async cancel() {
      for (const slot of slots) if (!slot.closed) slot.worker.postMessage({ type: 'cancel' });
      await Promise.all(slots.map(s => s.exited));
    },
  };
}
