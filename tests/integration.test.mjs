import './test-home.mjs';
import { errorCodes } from '../src/errors.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { openShot } from '../src/capture.mjs';
import { verifyShot } from '../src/verify.mjs';
import { createPostCapture } from '../src/post.mjs';
import { createRenderPool } from '../src/render-pool.mjs';
import { decodePNG } from '../src/png.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { browserOptions } from '../src/platform.mjs';
import { run } from './helpers.mjs';

await mkdir('out/tests', { recursive: true });
const out = await mkdtemp(path.resolve('out/tests/run-'));
process.env.MULTIPLANE_JOBS_DIR = path.join(out, 'jobs');
const cli = (args, extra = {}) => run(process.execPath, ['bin/multiplane', ...args], extra);
const silence = () => {};

for (const name of ['animation', 'typography', 'three-cards']) {
  test(`${name}: unordered, reload and single/multiple worker determinism`, { timeout: 120000 }, async () => {
    const result = await verifyShot(`examples/${name}.html`, { out: path.join(out, name, 'verify'), at: '0,0.5,1,1.5',
      grain: 2, workers: 2, onEvent: silence });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(await readFile(result.artifacts[0].path, 'utf8')).changedPixels, 0);
  });
  test(`${name}: CLI encodes complete example to a playable video`, { timeout: 120000 }, async () => {
    const file = path.join(out, name, 'video.mp4');
    const result = await cli(['render', `examples/${name}.html`, '--workers', '2', '--out', file, '--json']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = result.stdout.trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(report.ok, true); assert.equal(report.data.frames, 24);
    assert.equal(report.artifacts[0].path, file);
    const inspection = await run(await resolveFFmpeg(), ['-hide_banner', '-i', file, '-map', '0:v:0', '-f', 'null', '-', '-progress', 'pipe:1']);
    assert.equal(inspection.code, 0, inspection.stderr);
    assert.equal(Number([...inspection.stdout.matchAll(/^frame=(\d+)/gm)].at(-1)[1]), 24);
    assert.match(inspection.stderr, /Duration: 00:00:02\.00/);
    assert.match(inspection.stderr, /Video: h264/); assert.match(inspection.stderr, /640x360/); assert.match(inspection.stderr, /yuv420p/);
    await writeFile(path.join(out, name, 'inspection.txt'), inspection.stderr + inspection.stdout);
    const bytes = await readFile(file);
    assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')));
  });
}
test('stills and verify emit final NDJSON results; failures exit nonzero', { timeout: 120000 }, async () => {
  const result = await cli(['stills', 'examples/animation.html', '--at', '0.99,1', '--out', path.join(out, 'stills'), '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = result.stdout.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(report.data.stills.length, 2); assert.equal(report.artifacts.length, 3);
  const verification = await cli(['verify', 'examples/animation.html', '--out', path.join(out, 'cli-verify'), '--json']);
  assert.equal(verification.code, 0, verification.stdout + verification.stderr);
  assert.equal(verification.stdout.trim().split('\n').map(JSON.parse).at(-1).ok, true);
  for (const args of [
    ['render', 'examples/animation.html', '--ffmpeg', path.join(out, 'missing-ffmpeg')],
    ['stills', 'examples/animation.html', '--at', '0.001,0.002'],
    ['verify', 'examples/animation.html', '--at', '0.01'],
    ['render', 'examples/animation.html', '--workers', '1.5'],
    ['stills', 'examples/missing.html'],
    ['render', 'examples/animation.html', '--unknown', '1'],
  ]) {
    const failure = await cli([...args, '--json']);
    const event = failure.stdout.trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.type, 'result'); assert.equal(event.ok, false);
    assert.equal(failure.code, errorCodes[event.code].exitCode);
  }
});
test('bundled font loads as a custom font; server enforces resource boundary', async () => {
  const capture = await openShot('examples/typography.html');
  try {
    await capture.frame(1);
    const session = await capture.page.context().newCDPSession(capture.page);
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    assert.ok(fonts.length > 0 && fonts.every(f => f.isCustomFont && /Roboto/.test(f.familyName)), JSON.stringify(fonts));
    for (const resource of ['/.git/config', '/node_modules/playwright/package.json', '/multiplane/vendor/three/package.json']) {
      assert.equal((await fetch(capture.server.url + resource)).status, 403);
    }
  } finally { await capture.close(); }
});
test('three uses accumulated depth of field and records GPU details', async () => {
  const capture = await openShot('examples/three-cards.html');
  try {
    await capture.frame(1);
    const info = await capture.page.evaluate(() => ({ ...EXAMPLE_LAYER.gpuInfo(), sampling: EXAMPLE_LAYER.sampling,
      stats: EXAMPLE_LAYER.stats, target: [EXAMPLE_LAYER.accumulationTarget.width, EXAMPLE_LAYER.accumulationTarget.height] }));
    assert.equal(info.sampling.quality, 'final'); assert.ok(info.stats.samples >= 16);
    assert.ok(info.stats.maxBlurRadius > 0); assert.deepEqual(info.target, [640, 360]);
    await writeFile(path.join(out, 'gpu.json'), JSON.stringify(info, null, 2));
  } finally { await capture.close(); }
});
test('software raster and 2x rendering preserve repeated frames', async () => {
  const capture = await openShot('examples/animation.html', 2, { raster: 'software' });
  try {
    const processed = createPostCapture(capture, { scale: 2, grain: 3 });
    const first = decodePNG(await processed.frame(0.5));
    await processed.frame(1.5);
    assert.equal(first.width, 1280); assert.equal(first.height, 720);
    assert.deepEqual(decodePNG(await processed.frame(0.5)), first);
  } finally { await capture.close(); }
  assert.ok(browserOptions('gpu', {}, 'win32').args.includes('--use-angle=d3d11'));
  assert.ok(!browserOptions('gpu', {}, 'linux').args.includes('--use-angle=d3d11'));
});
test('worker load failure propagates and closes the pool', { timeout: 15000 }, async () => {
  const pool = createRenderPool('examples/missing.html', {}, 12, 2);
  try { await assert.rejects(async () => { for await (const frame of pool.frames(0, 2)) void frame; }, { code: 'shot_not_found' }); }
  finally { await pool.close(); }
});

for (const name of ['typography', 'three-cards']) test(`${name}: software rendering remains pixel deterministic across workers`, { timeout: 120000 }, async () => {
  const result = await verifyShot(`examples/${name}.html`, { raster: 'software', out: path.join(out, name, 'software-verify'), at: '0,0.5', workers: 2, onEvent: silence });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(await readFile(result.artifacts[0].path, 'utf8')).changedPixels, 0);
});
test('stateful shots fail verification', async () => {
  const file = path.join(out, 'stateful.html');
  await writeFile(file, '<div id="stage" style="width:64px;height:64px"></div><script>let n=0;window.SHOT={duration:1,fps:12,render(){document.querySelector("#stage").style.background=++n%2?"red":"blue"}}</script>');
  await assert.rejects(verifyShot(file, { out: path.join(out, 'bad-verify'), at: '0,0.5', print: silence }), { code: 'nondeterministic_output' });
});
test('FFmpeg discovery honors explicit, environment, then PATH', async () => {
  const executable = await resolveFFmpeg();
  assert.equal(await resolveFFmpeg(executable, { ...process.env, MULTIPLANE_FFMPEG: 'missing' }), executable);
  await assert.rejects(resolveFFmpeg(path.join(out, 'missing'), { ...process.env, MULTIPLANE_FFMPEG: executable }), { code: 'ffmpeg_not_found' });
  if (path.isAbsolute(executable)) {
    const env = { ...process.env, MULTIPLANE_FFMPEG: undefined };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = path.dirname(executable);
    assert.equal(await resolveFFmpeg(undefined, env), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }
});

test('Shot.define forwards blurAt and post capture uses the hook', async () => {
  const file = path.join(out, 'blur-hook.html');
  await writeFile(file, '<div id="stage" style="width:32px;height:32px"></div><script src="/multiplane/runtime/shot.js"></script><script>Shot.define({duration:1,post:{motionBlur:5},blurAt:t=>t<0.5?1:3,render(){}})</script>');
  const capture = await openShot(file);
  try {
    assert.equal(await capture.blurAt(0), 1); assert.equal(await capture.blurAt(0.5), 3);
    const processed = createPostCapture(capture); await processed.frame(0.5);
    assert.equal(processed.stats.hookFrames, 1); assert.equal(processed.stats.samples, 3);
  } finally { await capture.close(); }
});
