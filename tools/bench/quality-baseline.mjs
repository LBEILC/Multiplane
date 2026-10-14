import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openShot } from '../../src/capture.mjs';
import { createPostCapture } from '../../src/post.mjs';
import { isolateDevelopmentHome } from '../development-home.mjs';

isolateDevelopmentHome('bench-quality-baseline');
const revision = process.argv[2];
if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw Error('Provide the full pre-change Git commit hash.');
const baseline = path.resolve('out/bench/quality-baseline', revision);
for (const file of execFileSync('git', ['ls-tree', '-r', '--name-only', revision, 'src', 'package.json'], { encoding: 'utf8', windowsHide: true }).trim().split('\n')) {
  const destination = path.join(baseline, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, execFileSync('git', ['show', `${revision}:${file}`], { windowsHide: true }));
}
const oldCapture = await import(pathToFileURL(path.join(baseline, 'src/capture.mjs')));
const oldPost = await import(pathToFileURL(path.join(baseline, 'src/post.mjs')));
const cases = [
  ['tools/bench/shots/adaptive-blur.html', { 'motion-blur': 1 }],
  ['tools/bench/shots/adaptive-blur.html', { 'motion-blur': 1, 'adaptive-blur': 0 }],
  ['examples/animation.html', { 'motion-blur': 1, grain: 2 }],
  ['examples/animation.html', { alpha: true, 'motion-blur': 1, grain: 2 }],
  ['tools/bench/shots/static-half.html', { 'motion-blur': 1, scale: 0.5 }],
  ['examples/three-cards.html', { 'motion-blur': 1 }],
];
const results = [];
for (const [shot, settings] of cases) {
  const options = { ...settings, raster: 'software', transport: 'raw' };
  let old, current;
  try {
    old = await oldCapture.openShot(shot, options.scale ?? 1, options);
    current = await openShot(shot, options.scale ?? 1, options);
    const before = oldPost.createPostCapture(old, options);
    const variants = ['draft', 'standard', 'high'].map(quality => createPostCapture(current, { ...options, quality }));
    const times = [0, 1 / old.fps, 2 / old.fps, 0.5, 1];
    for (const t of times) {
      const expected = await before.frame(t);
      for (const after of variants) if (!expected.equals(await after.frame(t))) throw Error(`Baseline pixels differ: ${shot} at ${t}`);
    }
    results.push({ shot, settings, frames: times.length, variants: ['draft', 'standard', 'high'], changedPixels: 0 });
    console.log(JSON.stringify(results.at(-1)));
  } finally { await old?.close(); await current?.close(); }
}
await writeFile('out/bench/quality-baseline.json', JSON.stringify({ revision, results }, null, 2));
