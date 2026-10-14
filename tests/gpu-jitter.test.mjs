import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { verifyShot } from '../src/verify.mjs';
import { createPostCapture } from '../src/post.mjs';
import { encodePNG } from '../src/png.mjs';

test('injected sparse capture differences retain reuse and deliver the actual audit frame', async () => {
  const a = { width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 100) };
  const b = { ...a, data: Buffer.from(a.data) }; b.data[0] += 5;
  for (const raster of ['gpu', 'software']) {
    const warnings = [];
    let calls = 0;
    const capture = { width: 16, height: 16, duration: 1, fps: 12, cuts: [], post: {},
      observe: async () => false, frame: async () => encodePNG(calls++ ? b : a) };
    const processed = createPostCapture(capture, { raster, transport: 'raw', onWarning: w => warnings.push(w) });
    assert.deepEqual(await processed.frame(0, 0), a.data);
    assert.deepEqual(await processed.frame(1 / 12, 1, true), b.data);
    assert.deepEqual(await processed.frame(2 / 12, 2), b.data);
    assert.equal(processed.staticReuse.verifiedFrames, 1);
    assert.equal(processed.staticReuse.enabled, raster === 'gpu');
    assert.equal(processed.staticReuse.reusedFrames, raster === 'gpu' ? 1 : 0);
    assert.deepEqual(warnings.map(w => w.code), raster === 'gpu' ? [] : ['static_reuse_disabled']);
  }
});

test('verify keeps warning-only checks successful but software raster rejects a one-level difference', { timeout: 60000 }, async () => {
  const root = createTempDirectory(path.resolve('out/tests/gpu-jitter-'));
  const shot = path.join(root, 'shot.html');
  await writeFile(shot, `<!doctype html><style>body{margin:0}#stage{width:16px;height:16px;background:#404040}#dot{width:1px;height:1px}</style><div id="stage"><div id="dot"></div></div><script>let n=0;window.SHOT={duration:1,fps:2,render(){dot.style.background='rgb('+(64+(n++%2))+',64,64)'}};</script>`);
  const events = [];
  const options = { root, at: '0', workers: 2, 'no-lint': true, 'job-dir': path.join(root, 'jobs'),
    out: path.join(root, 'gpu'), onEvent: e => events.push(e) };
  const result = await verifyShot(shot, options);
  assert.equal(result.ok, true);
  assert.equal(result.data.passed, true);
  assert.ok(result.data.checks.every(c => c.passed));
  assert.ok(result.data.checks.some(c => c.jitter));
  const warnings = events.filter(e => e.type === 'finding');
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every(e => e.code === 'gpu_raster_jitter' && e.severity === 'warning'));
  assert.equal(warnings[0].details.changedPixels, 1);
  assert.equal(warnings[0].details.maxChannelDiff, 1);
  assert.equal(warnings[0].details.maxBlockMeanDiff, 1 / 64);
  const report = JSON.parse(await readFile(result.artifacts.find(a => a.path.endsWith('report.json')).path, 'utf8'));
  assert.ok(report.changedPixels > 0);
  await assert.rejects(verifyShot(shot, { ...options, raster: 'software', out: path.join(root, 'software') }), { code: 'nondeterministic_output' });
});
