import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openShot } from '../../src/capture.mjs';
import { createPostCapture } from '../../src/post.mjs';
import { renderShot } from '../../src/render.mjs';
import { stillsShot } from '../../src/stills.mjs';
import { isolateDevelopmentHome } from '../development-home.mjs';
import sharp from 'sharp';

isolateDevelopmentHome('bench-quality-presets');
const out = 'out/bench/quality-presets';
await mkdir(out, { recursive: true });
const common = { raster: 'software', grain: 0, shutter: 0.5, workers: 1, 'no-lint': true, onEvent() {} };
const groups = [['standard', { quality: 'standard' }], ['high', { quality: 'high' }],
  ['fixed-8', { 'max-motion-blur': 8, 'adaptive-blur': 0 }],
  ['fixed-256', { 'motion-blur': 256, 'max-motion-blur': 256, 'adaptive-blur': 0 }]];
const shots = [
  ['adaptive-blur', 1, { left: 350, top: 98, width: 64, height: 64 }],
  ['small-translation', 16 / 30, { left: 155, top: 156, width: 64, height: 48 }],
  ['slow-translation', 0.6, { left: 72, top: 48, width: 64, height: 64 }],
];
const imagesOnly = process.argv.includes('--images-only');
const previous = imagesOnly ? JSON.parse(await readFile(out + '/report.json', 'utf8')).runs : [];
const runs = [];
for (const [name, t, crop] of shots) for (const [group, settings] of groups) {
  const shot = 'tools/bench/shots/' + name + '.html';
  const options = { ...common, 'motion-blur': 8, ...settings };
  const start = performance.now();
  const saved = previous.find(run => run.shot === name && run.group === group);
  const result = imagesOnly ? { data: saved } : await renderShot(shot, { ...options, out: out + '/' + name + '-' + group + '.mp4', overwrite: true, 'job-dir': out + '/jobs' });
  const seconds = imagesOnly ? saved.seconds : (performance.now() - start) / 1000;
  const capture = await openShot(shot, 1, options);
  let selected;
  try {
    const processed = createPostCapture(capture, options);
    const png = await processed.frame(t); selected = processed.lastBlurSamples;
    const prefix = out + '/' + name + '-' + group;
    await writeFile(prefix + '.png', png);
    await sharp(png).extract(crop).resize(crop.width * 8, crop.height * 8, { kernel: 'nearest' }).png().toFile(prefix + '-crop-8x.png');
  } finally { await capture.close(); }
  const entry = { shot: name, group, seconds, blurSamples: result.data.blurSamples, fastestTime: t, selected };
  runs.push(entry); console.log(JSON.stringify(entry));
  await writeFile(out + '/report.json', JSON.stringify({ runs }, null, 2));
}
const result = await stillsShot('examples/animation.html', { ...common, shutter: 0.8, scale: 2, quality: 'high', at: '0.5', overwrite: true, out: out + '/animation-high-2x', 'job-dir': out + '/jobs' });
await sharp(out + '/animation-high-2x/t-0.50.png').extract({ left: 510, top: 300, width: 120, height: 64 }).resize(960, 512, { kernel: 'nearest' }).png().toFile(out + '/animation-high-2x-crop-8x.png');
await writeFile(out + '/report.json', JSON.stringify({ runs, animation: { quality: result.data.quality, post: result.data.post, blurSamples: result.data.blurSamples } }, null, 2));
console.log(JSON.stringify({ animation: result.data.blurSamples }));
