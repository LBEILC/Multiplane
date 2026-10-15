import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG, decodePNG } from '../src/png.mjs';
import { decodeNativePNG } from '../src/png-native.mjs';
import { createPostCapture, resolvePost, sampleTimes, averageLinear, addGrain } from '../src/post.mjs';

const solid = value => ({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 255 : value)) });
test('PNG decoders and linear-light averaging agree', async () => {
  const image = solid(123), png = encodePNG(image);
  assert.deepEqual(decodePNG(png), image);
  assert.deepEqual(await decodeNativePNG(png), image);
  assert.equal(averageLinear([solid(0), solid(255)]).data[0], 188);
});
test('motion blur never crosses the hard cut', async () => {
  const settings = { motionBlur: 8, shutter: 1 };
  const fixture = { width: 2, height: 2, duration: 2, fps: 30, cuts: [1], post: settings,
    frame: async t => encodePNG(solid(t < 1 ? 0 : 255)) };
  const processed = createPostCapture(fixture);
  for (const t of [0, 0.999, 1, 1.001, 2]) {
    assert.ok(sampleTimes(t, 30, 2, [1], settings).every(s => s >= 0 && s <= 2 && (t < 1 ? s < 1 : s >= 1)));
    assert.deepEqual(decodePNG(await processed.frame(t)).data, solid(t < 1 ? 0 : 255).data);
  }
  const changing = createPostCapture({ ...fixture, cuts: [], frame: async t => encodePNG(solid(Math.round(t * 100))) }, { 'adaptive-blur': 0 });
  assert.deepEqual(decodePNG(await changing.frame(1)).data,
    averageLinear(sampleTimes(1, 30, 2, [], settings).map(t => solid(Math.round(t * 100)))).data);
});
test('grain is seeded by global frame and preserves alpha', () => {
  const image = { width: 20, height: 20, data: Buffer.alloc(1600, 128) };
  const a = addGrain(image, 6, 246);
  assert.deepEqual(a, addGrain(image, 6, 246));
  assert.notDeepEqual(a, addGrain(image, 6, 247));
  for (let p = 0; p < a.data.length; p += 4) {
    assert.equal(a.data[p], a.data[p + 1]); assert.equal(a.data[p], a.data[p + 2]); assert.equal(a.data[p + 3], 128);
  }
});
test('post options retain precedence and reject invalid sample counts', () => {
  assert.deepEqual(resolvePost({ 'no-post': true, grain: 8 }), { motionBlur: 1, maxMotionBlur: 1, grain: 0, shutter: 0.5 });
  assert.deepEqual(resolvePost({ grain: 0 }, { grain: 8, motionBlur: 3 }), { motionBlur: 3, maxMotionBlur: 32, grain: 0, shutter: 0.5 });
  for (const n of ['0', '1.5', 'NaN']) assert.throws(() => resolvePost({ 'motion-blur': n }));
});
