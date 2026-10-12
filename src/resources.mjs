import { cpus } from 'node:os';
import { createProcessTreeReader } from './platform.mjs';

// Diagnostics only: never pass these values to frame generation.
export function createResourceSampler({ sample, intervalMs = 1000, onSample = () => {}, enabled = true } = {}) {
  const reader = !sample && enabled ? createProcessTreeReader() : undefined;
  sample ??= reader?.sample;
  let pending, timer, stopped = false, peakMemoryBytes = null, memorySamples = 0, workers = 1;
  const take = () => {
    if (pending || stopped || !enabled) return pending ?? Promise.resolve();
    clearTimeout(timer);
    pending = (async () => {
      let bytes = null;
      try { const value = await sample(); if (Number.isSafeInteger(value) && value > 0) bytes = value; } catch {}
      if (bytes !== null) { peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, bytes); memorySamples++; }
      try { onSample(bytes); } catch {}
    })().finally(() => { pending = undefined; if (!stopped) { timer = setTimeout(take, intervalMs); timer.unref(); } });
    return pending;
  };
  void take();
  return {
    sample: take,
    setWorkers(value) { workers = value; },
    snapshot: () => ({ peakMemoryBytes, memorySamples, workers, cpuCount: cpus().length || null }),
    async stop() { stopped = true; clearTimeout(timer); await pending; await reader?.close(); },
  };
}
