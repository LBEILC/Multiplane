// Task 030 reproducible local measurements. All generated media stays in out/.
import { isolateDevelopmentHome } from './development-home.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { probeVideo } from '../src/output-check.mjs';
import { createProcessTreeReader } from '../src/platform.mjs';
import { renderShot } from '../src/render.mjs';

const directory = path.resolve('out/030/measure');
isolateDevelopmentHome('030/measure');
await mkdir(directory, { recursive: true });
const ffmpeg = await resolveFFmpeg();
const run = args => new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(stderr)));
});
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const probes = [];
for (const seconds of [2, 60]) {
  const file = path.join(directory, `probe-${seconds}.mp4`);
  await run(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-pix_fmt', 'yuv420p', file]);
  const before = await hash(file), start = performance.now();
  const actual = await probeVideo(ffmpeg, file);
  probes.push({ seconds, elapsedMs: performance.now() - start, actual, unchanged: before === await hash(file) });
}
const memory = [];
const reader = createProcessTreeReader();
for (let i = 0; i < 5; i++) {
  const start = performance.now(); const bytes = await reader.sample();
  memory.push({ elapsedMs: performance.now() - start, bytes });
}
await reader.close();
const shot = path.join(directory, 'shot.html');
await writeFile(shot, '<!doctype html><style>body{margin:0}#stage{width:320px;height:180px;background:#456}</style><div id="stage"></div><script>window.SHOT={duration:2,fps:12,render(t){document.querySelector("#stage").style.opacity=String(.5+t/4)}}</script>');
const renders = [];
for (const enabled of [false, true, true, false]) {
  const result = await renderShot(shot, { root: directory, 'job-dir': path.join(directory, 'jobs'), 'no-lint': true, 'no-post': true, workers: 1, raster: 'software', _resources: enabled });
  renders.push({ sampled: enabled, elapsedMs: result.elapsedMs, resources: result.data.resources, outputCheck: result.data.outputCheck });
}
const data = { probes, memory, renders };
await writeFile(path.join(directory, 'results.json'), JSON.stringify(data, null, 2));
console.log(JSON.stringify(data, null, 2));
