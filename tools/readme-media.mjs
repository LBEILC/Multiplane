import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { run } from './process.mjs';
import { captureDesktop } from './readme-media-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/images');
await mkdir(path.join(root, 'out/readme-media'), { recursive: true });
const work = await mkdtemp(path.join(root, 'out/readme-media/run-'));
await mkdir(output, { recursive: true });
const env = { ...process.env, MULTIPLANE_HOME: path.join(work, 'renderer'), MULTIPLANE_NO_INDEX: '1' };
const ffmpeg = process.env.MULTIPLANE_FFMPEG || 'ffmpeg';
const report = { images: [], captures: [], checks: [] };
const options = { root, raster: 'gpu', scale: 1, grain: 0, 'adaptive-blur': 0, 'static-reuse': false };
async function cli(command, shot, args = []) {
  const { stdout } = await run(process.execPath, ['bin/multiplane', command, `examples/${shot}.html`, '--json', ...args], { cwd: root, env, capture: true });
  const result = stdout.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function still(name, t, settings = {}, cutOverride) {
  const capture = await openShot(`examples/${name}.html`, 1, options);
  try {
    if (cutOverride) capture.cuts = cutOverride;
    const post = createPostCapture(capture, { ...options, ...settings });
    const png = await post.frame(t);
    report.captures.push({ shot: name, t, frame: Math.round(t * capture.fps), settings, cuts: capture.cuts, samples: post.lastBlurSamples });
    return png;
  } finally { await capture.close(); }
}
async function plate(name, images, crop) {
  const width = (await sharp(images[0]).metadata()).width;
  const height = (await sharp(images[0]).metadata()).height;
  const gap = 12, zoom = 4;
  const layers = images.map((input, i) => ({ input, left: i * (width + gap), top: 0 }));
  if (crop) for (const [i, image] of images.entries()) {
    const input = await sharp(image).extract(crop).resize(crop.width * zoom, crop.height * zoom, { kernel: 'nearest' }).png().toBuffer();
    layers.push({ input, left: i * (width + gap), top: height + gap });
  }
  await sharp({ create: { width: width * images.length + gap * (images.length - 1), height: height + (crop ? gap + crop.height * zoom : 0), channels: 3, background: '#e6e8eb' } })
    .composite(layers).png({ compressionLevel: 9, effort: 10 }).toFile(path.join(output, name));
  report.images.push({ name, crop, zoom: crop ? zoom : null });
}

for (const shot of ['readme-cards', 'readme-wheel', 'readme-cut', 'readme-depth']) {
  console.log(`Checking ${shot}`);
  await cli('lint', shot);
  const result = await cli('verify', shot, ['--at', '0,1', '--workers', '2', '--raster', options.raster, '--job-dir', path.join(work, 'verify')]);
  report.checks.push({ shot, data: result.data });
}
console.log('Capturing comparisons');
const blur = [];
// No blur, a fixed 8 samples (cap equal to the start), and the high preset starting from 8.
for (const settings of [{ 'motion-blur': 1 }, { 'motion-blur': 8, 'max-motion-blur': 8 }, { 'motion-blur': 8, quality: 'high' }]) blur.push(await still('readme-wheel', 1, { ...settings, shutter: 1 }));
await plate('motion-blur.png', blur, { left: 245, top: 45, width: 132, height: 70 });
const cut = { 'motion-blur': 16, shutter: 1 };
await plate('hard-cut.png', [await still('readme-cut', 1, cut, []), await still('readme-cut', 1, cut)]);
const depth = [await still('readme-depth', 0), await still('readme-depth', 1)];
await plate('depth-of-field.png', depth, { left: 85, top: 165, width: 200, height: 90 });
const preview = await still('readme-cards', 58 / 24);
await writeFile(path.join(work, 'preview.png'), preview);

console.log('Rendering 96 hero frames');
const video = path.join(work, 'hero.mp4');
const hero = await cli('render', 'readme-cards', ['--out', video, '--from', '1', '--to', '5', '--quality', 'high', '--workers', '1', '--raster', options.raster, '--job-dir', path.join(work, 'render'), '--ffmpeg', ffmpeg]);
report.hero = hero.data;
await run(ffmpeg, ['-y', '-i', video, '-an', '-c:v', 'libwebp_anim', '-quality', '72', '-compression_level', '6', '-loop', '0', path.join(output, 'hero.webp')], { cwd: root, env, capture: true });
const animated = await sharp(path.join(output, 'hero.webp'), { animated: true }).metadata();
assert.equal(animated.width, 960); assert.equal(animated.pages, 96); assert.equal(animated.loop, 0);
assert.ok(Math.abs(animated.delay.reduce((sum, ms) => sum + ms, 0) - 4000) < 50);
assert.ok((await stat(path.join(output, 'hero.webp'))).size <= 3_000_000);
// A closed-form periodic shot must agree at the exact loop endpoints.
const start = await still('readme-cards', 1), end = await still('readme-cards', 5);
assert.deepEqual(await sharp(start).raw().toBuffer(), await sharp(end).raw().toBuffer());
report.checks.push({ loopEndpointsEqual: true });
report.images.push({ name: 'hero.webp', frames: 96, fps: 24, seconds: 4, motionBlur: 8, shutter: 0.8, aperture: 0.65, focusDistance: 8, depthSamples: '32–64' });

console.log('Capturing isolated desktop');
await captureDesktop({ root, work, output, preview: path.join(work, 'preview.png'), report });
let total = 0;
for (const image of report.images) {
  const file = path.join(output, image.name), input = await readFile(file);
  if (image.name.endsWith('.png')) await sharp(input).png({ compressionLevel: 9, effort: 10 }).toFile(file);
  const info = await sharp(file).metadata();
  image.bytes = (await stat(file)).size; image.width = info.width; image.height = info.height;
  total += image.bytes;
}
assert.equal(report.images.length, 10);
assert.ok(total <= 8_000_000, `Media total ${total} exceeds 8 MB`);
report.totalBytes = total;
await writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ images: report.images, totalBytes: total, report: path.join(work, 'report.json') }, null, 2));
