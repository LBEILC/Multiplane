import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { validateCapture, intersects, trafficLightPixels, captureWindow } from '../tools/window-smoke.mjs';

test('native capture validation rejects blank and truncated screenshots but accepts HiDPI', async () => {
  const image = async (width, height, varied = true) => {
    const base = sharp({ create: { width, height, channels: 3, background: '#151515' } });
    if (varied) base.composite([{ input: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#eeeeee' } }).png().toBuffer(), left: 5, top: 5 }]);
    return base.png().toBuffer();
  };
  const bounds = { width: 100, height: 80 };
  await assert.rejects(validateCapture(await image(100, 80, false), bounds), /blank/);
  await assert.rejects(validateCapture(await image(100, 40), bounds), /whole window/);
  assert.deepEqual(await validateCapture(await image(200, 160), bounds), { width: 200, height: 160 });
});

test('unavailable native capture records a reason without claiming a screenshot', async () => {
  const evidence = { screenshots: [] };
  await captureWindow({ evaluate: async () => { throw Error('Native capture denied'); } }, '.', evidence, { url: () => 'file:///application/index.html' });
  assert.equal(evidence.wholeWindow.status, 'unavailable');
  assert.match(evidence.wholeWindow.reason, /Native capture denied/);
  assert.deepEqual(evidence.screenshots, []);
});

test('brand collision detects partial overlap and containment without rejecting touching edges', () => {
  const button = { x: 12, y: 15, width: 14, height: 14 };
  assert.equal(intersects(button, { x: 20, y: 20, width: 80, height: 20 }), true);
  assert.equal(intersects(button, { x: 0, y: 0, width: 200, height: 44 }), true);
  assert.equal(intersects(button, { x: 26, y: 15, width: 80, height: 20 }), false);
  assert.equal(intersects(button, { x: 78, y: 15, width: 80, height: 20 }), false);
});

test('traffic-light visibility uses native bounds and rejects absent buttons', async () => {
  const bounds = { x: 200, y: 100, width: 100, height: 80 };
  const buttons = { close: { x: 212, y: 115, width: 12, height: 12 }, minimize: { x: 232, y: 115, width: 12, height: 12 }, maximize: { x: 252, y: 115, width: 12, height: 12 } };
  const patches = await Promise.all(['#ff5f57', '#febc2e', '#28c840'].map(async (color, i) => ({
    input: await sharp({ create: { width: 24, height: 24, channels: 4, background: color } }).png().toBuffer(), left: 24 + i * 40, top: 30
  })));
  const png = await sharp({ create: { width: 200, height: 160, channels: 4, background: '#151515' } }).composite(patches).png().toBuffer();
  assert.deepEqual(await trafficLightPixels(png, bounds, buttons), { close: 576, minimize: 576, maximize: 576 });
  await assert.rejects(trafficLightPixels(png, bounds, { close: { x: 212, y: 145, width: 12, height: 12 } }), /No visible close/);
});
