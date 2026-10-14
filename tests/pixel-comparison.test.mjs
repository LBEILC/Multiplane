import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelDifference, classifyPixelDifference, GPU_JITTER_BLOCK_THRESHOLD } from '../src/pixel-comparison.mjs';

const image = (width = 16, height = 16) => ({ width, height, data: Buffer.alloc(width * height * 4) });
test('block differences retain sparse changes and independent channel averages', () => {
  const a = image(), b = image();
  b.data[0] = 5; b.data[4] = 3; b.data[8 * 4 + 1] = 4;
  assert.deepEqual(pixelDifference(a, b), { changedPixels: 3, maxChannelDiff: 5, maxBlockMeanDiff: 8 / 64 });
  const { blockMeans } = pixelDifference(a, b, { distribution: true });
  assert.equal(blockMeans.length, 12);
  assert.equal(blockMeans[0], 8 / 64);
});
test('partial blocks use their actual area and alpha participates in comparison', () => {
  const a = image(10, 10), b = image(10, 10);
  b.data[(9 * 10 + 9) * 4 + 3] = 4;
  assert.deepEqual(pixelDifference(a, b), { changedPixels: 1, maxChannelDiff: 4, maxBlockMeanDiff: 1 });
});
test('equal images have zero differences and incompatible images are rejected', () => {
  assert.deepEqual(pixelDifference(image(), image()), { changedPixels: 0, maxChannelDiff: 0, maxBlockMeanDiff: 0 });
  assert.throws(() => pixelDifference(image(), image(8, 8)), /dimensions/);
});

test('injected comparison metrics apply the block threshold only to GPU raster', () => {
  const sparse = { changedPixels: 3, maxChannelDiff: 5, maxBlockMeanDiff: 8 / 64 };
  assert.equal(classifyPixelDifference(sparse), 'jitter');
  assert.equal(classifyPixelDifference({ ...sparse, maxBlockMeanDiff: GPU_JITTER_BLOCK_THRESHOLD }), 'jitter');
  assert.equal(classifyPixelDifference({ ...sparse, maxBlockMeanDiff: GPU_JITTER_BLOCK_THRESHOLD + 1 / 64 }), 'different');
  assert.equal(classifyPixelDifference({ ...sparse, maxChannelDiff: 33 }), 'different');
  assert.equal(classifyPixelDifference({ changedPixels: 1, maxChannelDiff: 1, maxBlockMeanDiff: 1 / 64 }, 'software'), 'different');
  assert.equal(classifyPixelDifference({ changedPixels: 0, maxChannelDiff: 0, maxBlockMeanDiff: 0 }, 'software'), 'identical');
});
