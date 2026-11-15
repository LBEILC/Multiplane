import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import { MultiplaneError } from '../src/errors.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { encodePNG, decodePNG } from '../src/png.mjs';
import { renderShot, resumeRender } from '../src/index.mjs';
import { verifyShot } from '../src/verify.mjs';
import { stillsShot } from '../src/stills.mjs';

const out = createTempDirectory(path.resolve('out/tests/frame-time-'));
const options = { quality: 'standard', raster: 'software', 'no-lint': true, onEvent() {}, 'job-dir': path.join(out, 'jobs') };
const html = (clock = 'SHOT.sampleContext.frameTime') => `<style>body{margin:0}#stage{width:64px;height:48px;background:#111;overflow:hidden}i{display:block;width:24px;height:48px;background:#eee}</style><div id="stage"><i></i></div><script>
window.SHOT={duration:1,fps:30,post:{motionBlur:4},render(t){const c=SHOT.sampleContext;if(c.time!==t||!Number.isFinite(c.frameTime))throw Error('context');document.querySelector('i').style.transform='translateX('+(Math.floor((${clock})*24)%2)*40+'px)'}};
</script>`;
async function shot(name, content = html()) { const file = path.join(out, name + '.html'); await writeFile(file, content); return file; }

// Fake captures make every context path observable without costly browser scenes.
test('frameTime stays at the requested center across observations, cuts, inspection and lens recaptures', async () => {
  const pixel = value => encodePNG({ width: 2, height: 2, data: Buffer.from([value,value,value,255,value,value,value,255,value,value,value,255,value,value,value,255]) });
  const paths = new Set();
  for (const pipeline of [false, true]) for (const motionBlur of [1, 4]) {
    let records = [];
    const record = (kind, time, context) => { paths.add(kind); records.push({ time, ...context }); };
    const frame = async (time, context) => { record('frame', time, context); return pixel(Math.round(time * 12000) % 256); };
    const capture = { width: 2, height: 2, duration: 2, fps: 30, cuts: [1], motionProbeUsed: true,
      frame, observe: async (time, context) => { record('observe', time, context); return true; },
      _inspectSample: async (time, context) => record('inspect', time, context),
      ...(pipeline ? { beginFrame: async (time, context) => ({ png: frame(time, context) }) } : {}) };
    const post = createPostCapture(capture, { pipeline, 'static-reuse': true, 'motion-blur': motionBlur, 'max-motion-blur': 8 });
    for (const time of [1.001, 0, 0.999, 2]) {
      records = [];
      await post.frame(time);
      assert.ok(records.length);
      assert.ok(records.every(record => record.frameTime === time));
      if (motionBlur === 1) assert.ok(records.every(record => record.time === time));
      else assert.ok(records.some(record => record.motionProbeTime === undefined && record.dofMotionSamples > 0));
    }
  }
  assert.deepEqual([...paths].sort(), ['frame', 'inspect', 'observe']);
});

test('direct capture defaults frameTime to time and only motionBlur reads mark contextUsed', async () => {
  const file = await shot('context', html().replace("const c=SHOT.sampleContext;", "const c=SHOT.sampleContext;window.seen=[c.time,c.frameTime];if(t===0.5)void c.motionBlur;"));
  const capture = await openShot(file, 1, options);
  try {
    await capture.frame(0.25);
    assert.deepEqual(await capture.page.evaluate(() => window.seen), [0.25, 0.25]);
    assert.equal(capture.sampleContextUsed, false);
    await capture._inspectSample(0.3, { frameTime: 0.4 });
    assert.deepEqual(await capture.page.evaluate(() => window.seen), [0.3, 0.4]);
    assert.equal(capture.sampleContextUsed, false);
    await capture.frame(0.5);
    assert.equal(capture.sampleContextUsed, true);
  } finally { await capture.close(); }
});

fullTest('24 Hz pattern avoids upward sampling with frameTime and triggers it with sample time; resume preserves frame pixels', { timeout: 120000 }, async t => {
  for (const clock of ['SHOT.sampleContext.frameTime', 't']) {
    const name = clock === 't' ? 'sample' : 'frame';
    const file = await shot(name, html(clock));
    const hashes = path.join(out, name + '-hashes.json');
    process.env.RENDER_FRAME_HASHES = hashes;
    t.after(() => { delete process.env.RENDER_FRAME_HASHES; });
    const result = await renderShot(file, { ...options, workers: 1, out: path.join(out, name + '.mp4') });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.frames, 30);
    t.diagnostic(name + ': ' + JSON.stringify(result.data.blurSamples));
    if (clock === 't') assert.ok(result.data.blurSamples.max > result.data.post.motionBlur);
    else {
      assert.ok(result.data.blurSamples.max <= result.data.post.motionBlur);
      const baseline = JSON.parse(await readFile(hashes));
      let interrupted;
      try {
        await renderShot(file, { ...options, workers: 2, _segmentFrames: 10, out: path.join(out, 'resumed.mp4'),
          _segmentHook: (phase, index) => { if (phase === 'sealed' && index === 0) throw new MultiplaneError('cancelled'); } });
      } catch (error) { assert.equal(error.code, 'cancelled'); interrupted = path.join(options['job-dir'], error.result.jobId); }
      assert.ok(interrupted);
      const resumed = await resumeRender(interrupted, { workers: 1, onEvent() {} });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.data.resume.framesReused, 10);
      assert.deepEqual(JSON.parse(await readFile(hashes)), baseline);
    }
    delete process.env.RENDER_FRAME_HASHES;
  }
});

test('frameTime verify passes reordered, reloaded, worker, range and static-reuse captures', { timeout: 120000 }, async () => {
  const result = await verifyShot(await shot('verify'), { ...options, workers: 2, at: '0,0.1,0.2', 'static-reuse': true, out: path.join(out, 'verify') });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const name of ['reorder', 'reload', 'workers:1', 'workers:2', 'range', 'static-reuse:workers:1', 'static-reuse:workers:2']) assert.ok(result.data.checks.some(c => c.name === name && c.passed), name);
  assert.equal(JSON.parse(await readFile(result.artifacts.at(-1).path)).changedPixels, 0);
});

test('stills keep the exact unaligned requested time across shutter samples', { timeout: 60000 }, async () => {
  const time = 0.1234;
  const file = await shot('still', html().replace('const c=SHOT.sampleContext;', `const c=SHOT.sampleContext;if(c.frameTime!==${time})throw Error('center changed');`));
  const result = await stillsShot(file, { ...options, at: String(time), out: path.join(out, 'stills') });
  assert.equal(result.ok, true, JSON.stringify(result));
  const capture = await openShot(file, 1, options);
  try { assert.deepEqual(decodePNG(await readFile(result.data.stills[0].path)), decodePNG(await capture.frame(time))); }
  finally { await capture.close(); }
});
