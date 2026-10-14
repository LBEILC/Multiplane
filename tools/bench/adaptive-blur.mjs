import { mkdir, writeFile } from 'node:fs/promises';
import { openShot } from '../../src/capture.mjs';
import { createPostCapture, imageDifference, sampleTimes } from '../../src/post.mjs';
import { renderShot } from '../../src/render.mjs';
import { decodePNG } from '../../src/png.mjs';
import { isolateDevelopmentHome } from '../development-home.mjs';
import sharp from 'sharp';

isolateDevelopmentHome('bench-adaptive-blur');
const out = 'out/bench/adaptive-blur', shot = 'tools/bench/shots/adaptive-blur.html';
await mkdir(out, { recursive: true });
const groups = [ ['fixed-8', 8, 8], ['fixed-64', 64, 64], ['adaptive-8-64', 8, 64] ];
const common = { raster: 'software', grain: 0, shutter: 0.5, workers: 1, 'no-lint': true, onEvent() {} };
const calibration = [];
const capture = await openShot(shot, 1, common);
try {
  for (const t of [0.2, 0.6, 1]) {
    const grid = sampleTimes(t, 30, 1.2, [], { motionBlur: 8, shutter: 0.5 });
    const images = [];
    for (const time of [grid[0], grid.at(-1), t]) images.push(decodePNG(await capture.frame(time)));
    calibration.push({ t, difference: Math.max(imageDifference(images[0], images[1]), imageDifference(images[0], images[2]), imageDifference(images[1], images[2])) });
  }
  for (const [name, base, maximum] of groups) {
    const processed = createPostCapture(capture, { ...common, 'motion-blur': base, 'max-motion-blur': maximum, 'adaptive-blur': maximum === base ? 0 : 0.5 });
    const png = await processed.frame(1, 30);
    await writeFile(`${out}/${name}.png`, png);
    await sharp(png).extract({ left: 350, top: 98, width: 64, height: 64 }).resize(512, 512, { kernel: 'nearest' }).png().toFile(`${out}/${name}-crop-8x.png`);
  }
} finally { await capture.close(); }
console.log(JSON.stringify({ calibration }));
const runs = [];
// Rotate all three groups through first, second and third position.
for (let round = 0; round < 3; round++) {
  for (let index = 0; index < groups.length; index++) {
    const [name, base, maximum] = groups[(round + index) % groups.length];
    const start = performance.now();
    const result = await renderShot(shot, { ...common, 'motion-blur': base, 'max-motion-blur': maximum,
      'adaptive-blur': maximum === base ? 0 : 0.5, out: `${out}/${name}-${round}.mp4`, overwrite: true, 'job-dir': `${out}/jobs` });
    if (!result.ok) throw Error(JSON.stringify(result));
    const entry = { round, name, seconds: (performance.now() - start) / 1000, blurSamples: result.data.blurSamples };
    runs.push(entry); console.log(JSON.stringify(entry));
  }
}
const medians = groups.map(([name]) => {
  const seconds = runs.filter(run => run.name === name).map(run => run.seconds).sort((a, b) => a - b);
  return { name, median: seconds[1], min: seconds[0], max: seconds[2] };
});
await writeFile(`${out}/report.json`, JSON.stringify({ calibration, runs, medians }, null, 2));
console.log(JSON.stringify({ medians }));
