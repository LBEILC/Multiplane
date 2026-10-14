// Run with: node --import ./tests/test-home.mjs tools/bench/gpu-jitter.mjs <real-shot> <root>
// Private input stays outside the repository; only numeric measurements are saved.
import path from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { openShot } from '../../src/capture.mjs';
import { decodePNG, encodePNG } from '../../src/png.mjs';
import { videoEncoding } from '../../src/format.mjs';

import { pixelDifference } from '../../src/pixel-comparison.mjs';
function measure(a, b) {
  const { blockMeans, ...stats } = pixelDifference(a, b, { distribution: true });
  blockMeans.sort((a, b) => a - b);
  return { ...stats, median: blockMeans[Math.floor(blockMeans.length * 0.5)],
    p99: blockMeans[Math.floor(blockMeans.length * 0.99)] };
}

const out = path.resolve('out/059-measure');
await mkdir(out, { recursive: true });
const faultsOnly = process.argv.includes('--faults-only');
const results = faultsOnly ? JSON.parse(await readFile(path.join(out, 'measurements.json'), 'utf8')) : { jitter: [], encoding: [], faults: [] };
if (faultsOnly) results.faults = [];
const save = () => writeFile(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2));
const encoding = videoEncoding({ format: 'mp4' });
function ffmpeg(args, input) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error));
  return result.stdout;
}
for (const [label, shot, root] of faultsOnly ? [] : [['real', process.argv[2], process.argv[3]], ['example', 'examples/animation.html', process.cwd()]]) {
  let capture;
  try {
    capture = await openShot(shot, 1, { root, raster: 'gpu', 'no-static-reuse': true });
    const times = [0.25, 0.75].map(k => Math.floor(k * capture.duration * capture.fps) / capture.fps);
    const references = [];
    for (const t of times) references.push(decodePNG(await capture.frame(t)));
    for (const mode of ['reload', 'process']) {
      if (mode === 'reload') {
        await capture.page.reload();
        await capture.page.evaluate(async () => { await SHOT.ready; await document.fonts.ready; });
      } else {
        await capture.close();
        capture = await openShot(shot, 1, { root, raster: 'gpu', 'no-static-reuse': true });
      }
      for (let i = 0; i < times.length; i++) results.jitter.push({ label, mode, t: times[i], ...measure(references[i], decodePNG(await capture.frame(times[i]))) });
    }
    for (let i = 0; i < references.length; i++) {
      const a = references[i], mp4 = path.join(out, 'encoded.mp4');
      try {
        ffmpeg(['-f', 'image2pipe', '-framerate', '30', '-i', 'pipe:0', '-frames:v', '3', ...encoding.args, '-pix_fmt', encoding.pixelFormat, mp4], Buffer.concat(Array.from({ length: 3 }, () => encodePNG(a))));
        const data = ffmpeg(['-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
        results.encoding.push({ label, t: times[i], ...measure(a, { ...a, data }) });
      } finally { await rm(mp4, { force: true }); }
    }
  } finally { await capture?.close(); }
  await save();
  console.log(label + ' measured');
}
for (const kind of ['offset', 'color', 'text', 'gradient']) {
  const shot = path.join(out, kind + '.html');
  await writeFile(shot, `<!doctype html><style>body{margin:0}#stage{width:256px;height:128px;background:#808080}#item{position:absolute;left:32px;top:24px;width:160px;height:80px;background:#eee;font:48px monospace;color:#111}</style><div id="stage"><div id="item">A</div></div><script>let variant=0;window.SHOT={duration:1,fps:30,render(){const v=variant;item.style.transform='translateX('+(v*0.25)+'px)';${kind !== 'offset' ? "item.style.transform='none';" : ''}${kind === 'color' ? "stage.style.background='rgb('+(128+v*3)+','+(128+v*3)+','+(128+v*3)+')';" : ''}${kind === 'text' ? "item.textContent=v?'B':'A';" : ''}${kind === 'gradient' ? "stage.style.background='linear-gradient(90deg, #111 '+v+'px, #eee 256px)';item.style.display='none';" : ''}}};</script>`);
  for (const raster of ['gpu', 'software']) {
    const capture = await openShot(shot, 1, { raster, 'no-static-reuse': true });
    try {
      const a = decodePNG(await capture.frame(0));
      await capture.page.evaluate(() => { variant = 1; });
      results.faults.push({ kind, raster, ...measure(a, decodePNG(await capture.frame(0))) });
    } finally { await capture.close(); }
  }
  await save();
}
await save();
console.log(JSON.stringify(results, null, 2));
