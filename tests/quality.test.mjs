import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { resolveQuality, resolvePost, createPostCapture } from '../src/post.mjs';
import { stillsShot } from '../src/stills.mjs';
import { verifyShot } from '../src/verify.mjs';
import { run, createTempDirectory } from './helpers.mjs';
import { encodePNG, decodePNG } from '../src/png.mjs';
const out = createTempDirectory(path.resolve('out/tests/quality-'));
for (const quality of ['standard', 'fast']) test(quality + ' caps only implicit adaptive bases and preserves explicit and fixed sampling', async () => {
  for (const base of [1, 2, 4, 5, 8]) {
    assert.equal(resolvePost({ quality }, { motionBlur: base }).motionBlur, Math.min(base, 4));
    assert.equal(resolvePost({ quality, 'motion-blur': base }, { motionBlur: 8 }).motionBlur, base);
    for (const quality of ['high', 'draft']) assert.equal(resolvePost({ quality }, { motionBlur: base }).motionBlur, base);
  }
  for (const ceiling of [1, 4, 8]) {
    assert.equal(resolvePost({ quality }, { motionBlur: 8, maxMotionBlur: ceiling }).motionBlur, 8);
    assert.equal(resolvePost({ quality, 'max-motion-blur': ceiling }, { motionBlur: 8 }).motionBlur, 8);
  }
  assert.equal(resolvePost({ quality, 'max-motion-blur': 16 }, { motionBlur: 8, maxMotionBlur: 8 }).motionBlur, 4);
  assert.deepEqual(resolvePost({ quality, 'motion-blur': 12, 'max-motion-blur': 48 }, { motionBlur: 8, maxMotionBlur: 16 }),
    { motionBlur: 12, maxMotionBlur: 48, shutter: 0.5, grain: 0 });
  assert.throws(() => resolvePost({ quality }, { motionBlur: 4.5 }), { code: 'invalid_option' });
  const contexts = [];
  const capture = { width: 2, height: 2, duration: 2, fps: 30, cuts: [], post: { motionBlur: 8 }, frame: async (t, context) => {
    contexts.push(context);
    return encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  } };
  const processed = createPostCapture(capture, { quality, 'adaptive-blur': 0 });
  await processed.frame(1);
  assert.equal(processed.post.motionBlur, 4);
  assert.ok(contexts.length > 0);
  assert.ok(contexts.every(context => context.motionBlurBase === 4));
});
test('quality defaults, custom ceilings and conflicts are validated', async () => {
  assert.equal(resolveQuality(), 'standard');
  assert.equal(resolveQuality({ draft: true }), 'draft');
  for (const quality of ['draft', 'fast', 'standard', 'high']) {
    assert.equal(resolveQuality({ quality }), quality);
    assert.equal(resolvePost({ quality }).maxMotionBlur, quality === 'draft' ? 1 : quality === 'high' ? 256 : quality === 'fast' ? 16 : 32);
  }
  assert.equal(resolvePost({ quality: 'high', 'max-motion-blur': 13 }, { maxMotionBlur: 21 }).maxMotionBlur, 13);
  assert.equal(resolvePost({ quality: 'high' }, { maxMotionBlur: 21 }).maxMotionBlur, 21);
  for (const options of [{ quality: 'bad' }, { quality: '' }, { quality: 'high', draft: true }, { quality: 'standard', draft: true }, { quality: 'fast', draft: true }]) assert.throws(() => resolveQuality(options), { code: 'invalid_option' });
  const capture = { width: 2, height: 2, duration: 2, fps: 30, cuts: [], frame: async t =>
    encodePNG({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 255 : t < 1 ? 0 : 255)) }) };
  for (const [quality, ceiling] of [['fast', 16], ['standard', 32], ['high', 256]]) {
    const processed = createPostCapture(capture, { quality, 'motion-blur': 2 });
    await processed.frame(1);
    assert.equal(processed.lastBlurSamples, ceiling);
  }
});
test('one sample never enables blur and local motion doubles to a custom ceiling', async () => {
  const capture = { width: 64, height: 48, duration: 2, fps: 30, cuts: [], frame: async t => {
    const data = Buffer.alloc(64 * 48 * 4, 255);
    const x0 = Math.round(10 + 1200 * (t - 1));
    for (let y = 16; y < 24; y++) for (let x = Math.max(0, x0); x < Math.min(64, x0 + 8); x++) for (let c = 0; c < 3; c++) data[(y * 64 + x) * 4 + c] = 0;
    return encodePNG({ width: 64, height: 48, data });
  } };
  for (const quality of ['draft', 'fast', 'standard', 'high']) {
    const processed = createPostCapture(capture, { quality, 'motion-blur': 1 });
    assert.deepEqual(await processed.frame(1), await capture.frame(1));
    assert.equal(processed.lastBlurSamples, 1);
  }
  const counts = [];
  for (const quality of ['fast', 'standard', 'high']) {
    const processed = createPostCapture(capture, { quality, 'motion-blur': 2, 'max-motion-blur': 31 });
    await processed.frame(1); counts.push(processed.lastBlurSamples);
  }
  assert.ok(counts[0] > 2); assert.equal(counts[0], counts[1]); assert.ok(counts[2] > counts[1]); assert.ok(counts[2] <= 31);
});
test('CLI and JS expose quality on stills, draft alias and verify', { timeout: 120000 }, async () => {
  const shot = path.join(out, 'quality.html');
  await writeFile(shot, '<style>html,body{margin:0}#stage{width:64px;height:48px;background:#777}</style><div id="stage"></div><script>window.SHOT={duration:1,fps:2,render(t){}}</script>');
  const common = { raster: 'software', 'no-lint': true, onEvent() {}, 'job-dir': path.join(out, 'jobs') };
  for (const quality of ['draft', 'fast', 'standard', 'high']) {
    const result = await stillsShot(shot, { ...common, quality, at: '0', out: path.join(out, quality) });
    assert.equal(result.data.quality, quality);
    assert.equal(result.data.post.motionBlur, 1);
    assert.equal(result.data.post.maxMotionBlur, resolvePost({ quality }).maxMotionBlur);
    assert.deepEqual(decodePNG(await readFile(path.join(out, quality, 't-0.00.png'))).data, decodePNG(await readFile(path.join(out, 'draft/t-0.00.png'))).data);
  }
  const alias = await stillsShot(shot, { ...common, draft: true, at: '0', out: path.join(out, 'alias') });
  assert.equal(alias.data.quality, 'draft');
  assert.deepEqual(await readFile(path.join(out, 'alias/t-0.00.png')), await readFile(path.join(out, 'draft/t-0.00.png')));
  const verified = await verifyShot(shot, { ...common, quality: 'draft', at: '0', workers: 1, out: path.join(out, 'verify') });
  assert.equal(verified.data.quality, 'draft'); assert.equal(verified.ok, true);
  for (const command of ['render', 'stills', 'verify']) {
    const result = await run(process.execPath, ['bin/multiplane', command, shot, '--draft', '--quality', 'high', '--json']);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).code, 'invalid_option');
  }
  const cli = await run(process.execPath, ['bin/multiplane', 'stills', shot, '--quality', 'fast', '--at', '0', '--json', '--out', path.join(out, 'cli'), '--job-dir', path.join(out, 'jobs')]);
  assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout.trim().split('\n').at(-1)).data.quality, 'fast');
});
