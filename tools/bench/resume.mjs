// Run with --import ./tests/test-home.mjs to use the local FFmpeg test setup.
// Usage: node --import ./tests/test-home.mjs tools/bench/resume.mjs <baseline-root>
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { isolateDevelopmentHome } from '../development-home.mjs';

isolateDevelopmentHome('bench-resume');

if (!process.argv[2]) throw Error('Provide a baseline checkout or source snapshot.');
const root = path.resolve('out/bench/resume');
await mkdir(root, { recursive: true });
const shot = path.join(root, 'shot.html');
await writeFile(shot, `<!doctype html><style>
body{margin:0}#stage{position:relative;width:1920px;height:1080px;background:#dde2e7;overflow:hidden}
.stripe{position:absolute;width:110px;height:1080px;background:#a1a9b1;opacity:.3}
#block{position:absolute;top:390px;width:220px;height:220px;background:#386386}
</style><div id="stage"><div id="block"></div></div><script>
const stage=document.querySelector('#stage'),block=document.querySelector('#block');
for(let i=0;i<8;i++){const stripe=document.createElement('div');stripe.className='stripe';stripe.style.left=(i*240)+'px';stage.append(stripe)}
window.SHOT={duration:25,fps:30,render(t){block.style.transform='translateX('+(40+1500*(t/25))+'px) rotate('+(t*20)+'deg)'}};
</script>`);
const options = { root, 'job-dir': path.join(root, 'jobs'), workers: 4, encoder: 'x264',
  'no-lint': true, 'motion-blur': 1, 'max-motion-blur': 1, overwrite: true };
const measurements = {};
for (const [name, source] of [['before', path.resolve(process.argv[2])], ['after', process.cwd()]]) {
  process.env.RENDER_FRAME_HASHES = path.join(root, name + '-hashes.json');
  process.env.RENDER_PROFILE = path.join(root, name + '-profile.json');
  const { renderShot } = await import(pathToFileURL(path.join(source, 'src/render.mjs')));
  const started = performance.now();
  const result = await renderShot(shot, { ...options, out: path.join(root, name + '.mp4') });
  const wallMs = performance.now() - started;
  const profile = JSON.parse(await readFile(process.env.RENDER_PROFILE, 'utf8'));
  measurements[name] = { wallMs, frames: result.data.frames, outputCheck: result.data.outputCheck,
    encoderWriteMs: profile.encoderWriteMs, encoderDrainMs: profile.encoderDrainMs,
    outputCheckMs: profile.outputCheckMs, capture: profile.stats };
  console.log(name, JSON.stringify(measurements[name]));
}
const before = JSON.parse(await readFile(path.join(root, 'before-hashes.json')));
const after = JSON.parse(await readFile(path.join(root, 'after-hashes.json')));
assert.deepEqual(after, before);
const summary = { width: 1920, height: 1080, fps: 30, duration: 25, workers: options.workers,
  segments: 3, identicalRGBAFrames: before.length, ...measurements,
  overheadPercent: (measurements.after.wallMs / measurements.before.wallMs - 1) * 100 };
await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
