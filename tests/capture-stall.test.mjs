import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { run, createTempDirectory } from './helpers.mjs';
import { fullTest } from './suite.mjs';
import { createCaptureWatchdog } from '../src/capture-watchdog.mjs';

const html = `<style>body{margin:0}#stage{width:640px;height:360px;background:#123}i{display:block;width:19px;height:21px;background:#fea}</style><div id="stage"><i></i></div><script>
window.SHOT={duration:1,fps:4,render(t){if(globalThis.__stall && t>=0.25 && t<0.5)while(true){}document.querySelector('i').style.transform='translateX('+Math.round(t*80)+'px)'}};
</script>`;

test('watchdog ignores idle/encoding slots, uses job-wide longest frame and excludes recovery time', () => {
  let time = 0;
  const slots = [{ job: { first: 0 }, frame: 0, lastDelivery: 0, frameStarted: 0 }, { job: null }], warnings = [];
  const watch = createCaptureWatchdog(slots, (slot, details) => warnings.push(details), { now: () => time });
  try {
    time = 20000; watch.completed(slots[0]);
    slots[0].job = null;
    slots[1] = { job: { first: 9 }, frame: 9, lastDelivery: time, frameStarted: time };
    time = 219999; watch.check(); assert.equal(warnings.length, 0);
    time++; watch.check(); assert.deepEqual(warnings, [{ worker: 1, frame: 9, waitedSeconds: 200 }]);
    time += 500000; watch.check(); assert.equal(warnings.length, 1);
    watch.recovered(slots[1]);
    time += 1000; watch.completed(slots[1]);
    time += 199999; watch.check(); assert.equal(warnings.length, 1);
    time++; watch.check(); assert.equal(warnings.length, 2);
    watch.stop(); time += 500000; watch.check(); assert.equal(warnings.length, 2);
  } finally { watch.stop(); }
});

test('watchdog uses the 120 second floor and only completed frames reset delivery', () => {
  let time = 0, calls = 0;
  const slot = { job: { first: 5 }, lastDelivery: 0 }, watch = createCaptureWatchdog([slot], () => calls++, { now: () => time });
  try {
    time = 119999; watch.check(); assert.equal(calls, 0);
    time++; watch.check(); assert.equal(calls, 1);
  } finally { watch.stop(); }
});

fullTest('stalled render and screenshot recover whole frames; two retries are bounded and pixel identical', { timeout: 180000 }, async () => {
  await mkdir('out/tests', { recursive: true });
  const root = createTempDirectory(path.resolve('out/tests/stall-'));
  const shot = path.join(root, 'shot.html'); await writeFile(shot, html);
  const execute = async (transport, faults, phase = 'render', workers = 1, mode = '') => {
    const dir = path.join(root, `${transport}-${faults}-${phase}-${workers}-${mode}`); await mkdir(dir);
    const result = await run(process.execPath, ['--import', './tests/stall-fault.mjs', 'tests/stall-runner.mjs', shot, transport, String(workers), mode], {
      env: { ...process.env, MULTIPLANE_STALL_FIXTURE: dir, MULTIPLANE_STALL_COUNT: String(faults), MULTIPLANE_STALL_PHASE: phase },
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  for (const transport of ['raw', 'png']) {
    const baseline = await execute(transport, 0);
    assert.equal(baseline.code, undefined); assert.equal(baseline.warnings.length, 0);
    assert.deepEqual((await execute(transport, 0, 'render', 2)).hashes, baseline.hashes);
    const recovered = await execute(transport, 2);
    assert.equal(recovered.code, undefined); assert.deepEqual(recovered.hashes, baseline.hashes);
    assert.equal(recovered.frames, 4);
    assert.equal(recovered.warnings.length, 2);
    for (const warning of recovered.warnings) {
      assert.equal(warning.code, 'worker_stalled'); assert.equal(warning.severity, 'warning');
      assert.equal(warning.details.worker, 0); assert.equal(warning.details.frame, 1);
      assert.ok(warning.details.waitedSeconds >= 0.4);
    }
    const failed = await execute(transport, 3);
    assert.equal(failed.code, 'browser_crashed'); assert.equal(failed.exitCode, 4); assert.equal(failed.warnings.length, 3);
    const screenshot = await execute(transport, 1, 'screenshot');
    assert.equal(screenshot.code, undefined); assert.equal(screenshot.warnings.length, 1);
    assert.deepEqual(screenshot.hashes, baseline.hashes);
    if (transport === 'raw') {
      const reused = await execute(transport, 1, 'render', 1, 'static');
      assert.equal(reused.code, undefined); assert.deepEqual(reused.hashes, baseline.hashes);
      const cancelled = await execute(transport, 1, 'render', 1, 'cancel');
      assert.equal(cancelled.code, 'cancelled'); assert.equal(cancelled.exitCode, 130);
      assert.equal(cancelled.warnings.length, 1);
    }
  }
});
