import test from 'node:test';
import assert from 'node:assert/strict';
import { totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { processTreeMemory, sumProcessTree, createProcessTreeReader } from '../src/platform.mjs';
import { createResourceSampler } from '../src/resources.mjs';

test('tree includes recursive descendants once and excludes other jobs and observer', () => {
  const rows = [{ pid: 1, parent: 0, bytes: 10 }, { pid: 2, parent: 1, bytes: 20 }, { pid: 3, parent: 2, bytes: 30 }, { pid: 4, parent: 0, bytes: 1000 }, { pid: 5, parent: 1, bytes: 999 }, { pid: 6, parent: 5, bytes: 999 }];
  assert.equal(sumProcessTree(rows.reverse(), 1, [5]), 60);
  assert.equal(sumProcessTree(rows, 999), null);
  assert.equal(sumProcessTree([{ pid: 1, bytes: NaN }], 1), null);
});
for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: process-table parsing, observer exclusion, errors return null`, async () => {
    const run = async (exe, args, options) => {
      assert.ok(options.timeout > 0); assert.ok(Array.isArray(args));
      assert.equal(exe, platform === 'win32' ? 'powershell.exe' : 'ps');
      return { stdout: platform === 'win32' ? JSON.stringify({ observer: 4, rows: [
        { ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 1024 },
        { ProcessId: 2, ParentProcessId: 1, WorkingSetSize: 2048 },
        { ProcessId: 4, ParentProcessId: 1, WorkingSetSize: 9999 },
      ] }) : '1 0 1 node\n2 1 2 chromium\n4 1 99 ps\n5 0 999 other' };
    };
    assert.equal(await processTreeMemory({ platform, pid: 1, run }), 3072);
    assert.equal(await processTreeMemory({ platform, run: async () => { throw Error('unavailable'); } }), null);
    assert.equal(await processTreeMemory({ platform, run: async () => ({ stdout: 'invalid' }) }), null);
  });
}
test('sampler never overlaps, preserves peak, reports null on failures and stops cleanly', async () => {
  let active = 0, maxActive = 0, count = 0, callbackCount = 0;
  const sampler = createResourceSampler({ intervalMs: 1, sample: async () => {
    count++; active++; maxActive = Math.max(maxActive, active); await delay(15); active--;
    if (count === 2) throw Error('unavailable'); return count * 100;
  }, onSample: () => callbackCount++ });
  await Promise.all([sampler.sample(), sampler.sample(), sampler.sample()]);
  await sampler.sample(); await sampler.sample(); await sampler.stop();
  assert.equal(maxActive, 1); assert.equal(sampler.snapshot().peakMemoryBytes, 300);
  assert.equal(sampler.snapshot().memorySamples, 2);
  await delay(20); assert.equal(callbackCount, 3);
  const failed = createResourceSampler({ sample: async () => null });
  await failed.stop(); assert.equal(failed.snapshot().peakMemoryBytes, null); assert.equal(failed.snapshot().memorySamples, 0);
});
test('host process-tree RSS is positive and plausible when platform access is available', async t => {
  const reader = createProcessTreeReader();
  t.after(() => reader.close());
  const first = reader.sample();
  if (process.platform === 'win32') assert.equal(first, reader.sample());
  const value = await first;
  if (value === null) { t.skip('Host process-table access unavailable; platform parser and failure branches are covered above.'); return; }
  assert.ok(value > 1024 * 1024 && value < totalmem() * 4, String(value));
  const next = await reader.sample(); assert.ok(next > 0);
  await reader.close();
  if (process.platform === 'win32') assert.equal(await reader.sample(), null);
});
