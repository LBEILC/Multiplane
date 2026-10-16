import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { renderShot, resumeRender, MultiplaneError } from '../src/index.mjs';
import { readStatus } from '../src/jobs.mjs';
import { JobStore } from '../app/src/main/store.mjs';
import { run } from './helpers.mjs';

const [root, mode] = process.argv.slice(2);
await mkdir(root, { recursive: true });
const shot = path.join(root, 'shot.html');
await writeFile(shot, `<style>body{margin:0}#stage{width:64px;height:36px;background:#abc}i{display:block;width:7px;height:6px;background:#e24}</style><div id="stage"><i></i></div><script>window.SHOT={duration:1,fps:8,render(t){if(t>=.5&&globalThis.__stall){console.log('stop-test-blocked');while(true){}}console.log('stop-test-healthy');document.querySelector('i').style.transform='translateX('+t*20+'px)'}}</script>`);
const options = { root, 'job-dir': path.join(root, 'jobs'), workers: 2, raster: 'software', 'no-lint': true,
  'no-post': true, _segmentFrames: 4, _stallTimeoutMs: 30000, _stopGraceMs: 100, onEvent() {} };
const hashFile = path.join(root, 'hashes.json');
process.env.RENDER_FRAME_HASHES = hashFile;
process.env.MULTIPLANE_STALL_COUNT = '0';
await renderShot(shot, { ...options, out: path.join(root, 'baseline.mp4') });
const baseline = JSON.parse(await readFile(hashFile));
process.env.MULTIPLANE_STALL_COUNT = '1';
process.env.MULTIPLANE_STALL_FIXTURE = root;
process.env.STOP_STALL_MODE = mode;
let directory, started, cancelCommand;
const warnings = [];
await assert.rejects(renderShot(shot, { ...options, out: path.join(root, 'resumed.mp4'),
  onEvent(event) {
    if (event.type === 'start') directory = path.join(options['job-dir'], event.jobId);
    if (event.type === 'warning') warnings.push(event.code);
  },
  _segmentHook: async (phase, index) => {
    if (phase !== 'sealed' || index !== 0) return;
    const deadline = performance.now() + 5000;
    while (!existsSync(path.join(root, 'blocked')) && performance.now() < deadline) await delay(10);
    assert.ok(existsSync(path.join(root, 'blocked')), 'peer must be inside the infinite render loop');
    started = performance.now();
    if (mode === 'failure') await writeFile(path.join(root, 'fail-now'), '');
    if (mode === 'hook') throw new MultiplaneError('cancelled');
    if (mode === 'cli') cancelCommand = run(process.execPath, ['bin/multiplane', 'cancel', directory, '--json', '--wait', '15']);
    if (mode === 'app') {
      // Exercise the actual application stop writer, without an Electron window.
      await JobStore.prototype.stop.call({ refresh: async () => {}, job: () => ({ state: 'running', jobDir: directory }), schedule() {} }, 'test');
    }
  },
}), { code: mode === 'failure' ? 'render_threw' : 'cancelled' });
const elapsed = performance.now() - started;
assert.ok(elapsed < 5000, `stop took ${elapsed} ms`);
assert.ok(elapsed >= 90, 'blocked worker must receive its grace period');
if (cancelCommand) { const result = await cancelCommand; assert.equal(result.code, 0, result.stdout + result.stderr); }
const status = await readStatus(directory);
assert.equal(status.state, mode === 'failure' ? 'failed' : 'cancelled');
assert.equal(status.resume.available, true);
assert.equal(status.resume.framesDone, 4);
assert.ok(!warnings.includes('worker_stalled'));
process.env.MULTIPLANE_STALL_COUNT = '0';
delete process.env.STOP_STALL_MODE;
const resumed = await resumeRender(directory, { onEvent() {} });
assert.equal(resumed.data.resume.framesReused, 4);
assert.deepEqual(JSON.parse(await readFile(hashFile)), baseline);
console.log(JSON.stringify({ mode, elapsed, state: status.state, framesReused: 4, framesMatched: baseline.length }));
