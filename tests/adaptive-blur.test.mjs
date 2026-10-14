import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createPostCapture, resolvePost, localMotionDifference, sampleTimes, nestedSampleGrids, averageLinear, blurSampleReport } from '../src/post.mjs';
import { encodePNG, decodePNG } from '../src/png.mjs';
import { verifyShot } from '../src/verify.mjs';
import { createRenderPool } from '../src/render-pool.mjs';
import { stillsShot } from '../src/stills.mjs';
import { openShot } from '../src/capture.mjs';
import { run, createTempDirectory } from './helpers.mjs';

const out = createTempDirectory(path.resolve('out/tests/adaptive-blur-'));
const solid = (value, alpha = 255) => ({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? alpha : value)) });
const settings = { 'motion-blur': 8, 'max-motion-blur': 64, 'no-static-reuse': true };
const fixture = (frame, extra = {}) => ({ width: 2, height: 2, duration: 2, fps: 30, cuts: [], frame: async (t, context) => encodePNG(frame(t, context)), ...extra });

test('maximum precedence, validation, draft and no-post', () => {
  assert.equal(resolvePost({ 'motion-blur': 8 }).maxMotionBlur, 64);
  assert.equal(resolvePost({}, { motionBlur: 8, maxMotionBlur: 32 }).maxMotionBlur, 32);
  assert.equal(resolvePost({ 'max-motion-blur': 64 }, { motionBlur: 8, maxMotionBlur: 32 }).maxMotionBlur, 64);
  for (const options of [{ draft: true }, { 'no-post': true }]) assert.equal(resolvePost({ ...settings, ...options }, { maxMotionBlur: 32 }).maxMotionBlur, 1);
  for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '']) {
    assert.throws(() => resolvePost({ 'max-motion-blur': value }), { code: 'invalid_option' });
  }
  assert.equal(resolvePost({ 'motion-blur': 8, 'max-motion-blur': 4 }).maxMotionBlur, 4);
});

test('local metric detects sparse motion and ignores transparent hidden colors', () => {
  const edge = offset => {
    const data = Buffer.alloc(64 * 48 * 4, 255);
    for (let y = 16; y < 32; y++) for (let x = 16 + offset; x < 24 + offset; x++) for (let c = 0; c < 3; c++) data[(y * 64 + x) * 4 + c] = 0;
    return { width: 64, height: 48, data };
  };
  assert.equal(localMotionDifference(edge(0), edge(1)), 1);
  assert.equal(localMotionDifference(edge(0), edge(2)), 2);
  assert.equal(localMotionDifference(solid(0, 0), solid(255, 0), true), 0);
});

test('upward samples use only the selected uniform grid and selected sample context', async () => {
  const calls = [];
  const draw = (t, { motionBlur }) => solid(t < 1 ? 0 : 255 - motionBlur);
  const processed = createPostCapture(fixture((t, context) => { calls.push([t, context.motionBlur]); return draw(t, context); }, { sampleContextUsed: true }), settings);
  const actual = decodePNG(await processed.frame(1));
  const grid = sampleTimes(1, 30, 2, [], { motionBlur: 64, shutter: 0.5 });
  assert.equal(processed.lastBlurSamples, 64);
  assert.deepEqual(calls.filter(([t, n]) => n === 64 && t !== 1), grid.map(t => [t, 64]));
  assert.deepEqual(actual, averageLinear(grid.map(t => draw(t, { motionBlur: 64 }))));
});

test('center probe detects matching endpoints and alpha-only motion', async () => {
  for (const alpha of [false, true]) {
    const processed = createPostCapture(fixture(t => alpha ? solid(0, Math.abs(t - 1) < 0.002 ? 255 : 0) : solid(Math.abs(t - 1) < 0.002 ? 255 : 0)), { ...settings, alpha });
    const actual = decodePNG(await processed.frame(1));
    assert.equal(processed.lastBlurSamples, 64);
    assert.ok(actual.data[alpha ? 3 : 0] > 0);
  }
});

test('nested grids retain samples, equal weights and a centered shutter', async () => {
  for (const [base, maximum] of [[6, 64], [8, 256], [3, 17], [5, 64]]) {
    const grids = nestedSampleGrids(1, 30, 2, [], { motionBlur: base, maxMotionBlur: maximum, shutter: 0.5 });
    let previous = [];
    for (const [count, grid] of [...grids].reverse()) {
      assert.equal(grid.length, count);
      assert.ok(Math.abs(grid.reduce((sum, time) => sum + time, 0) / count - 1) < 1e-14);
      assert.ok(previous.every(time => time === 1 || grid.includes(time)));
      previous = grid;
    }
    const calls = [];
    const processed = createPostCapture(fixture(t => { calls.push(t); return solid(t < 1 ? 0 : 255); }), { ...settings, 'motion-blur': base, 'max-motion-blur': maximum });
    const actual = decodePNG(await processed.frame(1));
    assert.equal(processed.lastBlurSamples, maximum);
    assert.ok(calls.length <= maximum + 3);
    assert.equal(new Set(calls).size, calls.length);
    assert.deepEqual(actual, averageLinear(grids.get(maximum).map(t => solid(t < 1 ? 0 : 255))));
  }
});

test('static detection takes only three screenshots before the initial grid', async () => {
  const processed = createPostCapture(fixture(() => solid(123)), { ...settings, 'motion-blur': 6 });
  await processed.frame(1);
  assert.equal(processed.stats.samples, 3);
  assert.equal(processed.lastBlurSamples, 1);
});

test('base one stays disabled; hard cuts and duration boundaries stay protected', async () => {
  const calls = [];
  const processed = createPostCapture(fixture(t => { calls.push(t); return solid(t < 1 ? 0 : Math.round((t - 1) * 15000) % 256); }, { cuts: [1] }), { ...settings, 'motion-blur': 1 });
  await processed.frame(1.005);
  assert.equal(processed.lastBlurSamples, 1);
  assert.ok(calls.every(t => t >= 1));
  const active = createPostCapture(fixture(t => { calls.push(t); return solid(t < 1 ? 0 : Math.round((t - 1) * 15000) % 256); }, { cuts: [1] }), settings);
  for (const t of [0, 0.999, 1, 1.005, 1.999]) {
    calls.length = 0;
    await processed.frame(t);
    assert.ok(calls.every(s => s >= 0 && s <= 2 && (t < 1 ? s < 1 : s >= 1)));
  }
});

test('static reuse bypasses upward probes and shot hooks retain exact counts', async () => {
  let calls = 0;
  const capture = fixture(() => { calls++; return solid(20); }, { observe: async () => false });
  const processed = createPostCapture(capture, { ...settings, 'no-static-reuse': false });
  await processed.frame(0, 0); await processed.frame(1 / 30, 1);
  const before = calls;
  await processed.frame(2 / 30, 2);
  assert.equal(calls, before); assert.equal(processed.lastBlurSamples, 1);
  const hooked = createPostCapture(fixture(t => solid(t < 1 ? 0 : 255), { blurAt: async () => 3 }), settings);
  await hooked.frame(1); assert.equal(hooked.lastBlurSamples, 3);
});

test('equal and smaller maximum preserve fixed sampling pixels', async () => {
  const capture = fixture(t => solid(Math.round(t * 777) % 256));
  for (const adaptive of [0, 0.5]) {
    const base = { 'motion-blur': 8, 'max-motion-blur': 8, 'adaptive-blur': adaptive, grain: 2 };
    const expected = await createPostCapture(capture, base).frame(1);
    for (const maximum of [1, 8]) assert.deepEqual(await createPostCapture(capture, { ...base, 'max-motion-blur': maximum }).frame(1), expected);
  }
  assert.deepEqual(blurSampleReport({ 64: 2, 1: 1, 8: 1 }), { min: 1, max: 64, mean: 34.25, histogram: { 1: 1, 8: 1, 64: 2 } });
});

test('frame-selected counts and pixels do not depend on order or a fresh processor', async () => {
  const capture = fixture(t => solid(t < 0.5 ? 40 : Math.round(t * 12000) % 256));
  const processed = createPostCapture(capture, settings), references = new Map();
  for (const t of [0.1, 0.4, 0.6, 1]) references.set(t, { png: await processed.frame(t), count: processed.lastBlurSamples });
  for (const renderer of [processed, createPostCapture(capture, settings)]) for (const t of [1, 0.4, 0.6, 0.1]) {
    assert.deepEqual(await renderer.frame(t), references.get(t).png);
    assert.equal(renderer.lastBlurSamples, references.get(t).count);
  }
});

const html = `<style>html,body{margin:0}#stage{width:64px;height:48px;background:#181818;overflow:hidden}i{display:block;width:24px;height:40px;background:#eee}</style><div id="stage"><i></i></div><script>
window.SHOT={duration:1,fps:8,cuts:[0.5],post:{motionBlur:8,maxMotionBlur:64},render(t){document.querySelector('i').style.transform='translateX('+(t<0.5?0:24+20*Math.sin((t-0.5)*80))+'px)'}};
</script>`;
async function browserFixture(name) {
  const file = path.join(out, name + '.html'); await writeFile(file, html); return file;
}

test('conditional browser sampleContext reads restart on compatible grids', async () => {
  const shot = path.join(out, 'context.html');
  await writeFile(shot, `<style>html,body{margin:0}#stage{width:2px;height:2px}</style><div id="stage"></div><script>
window.SHOT={duration:2,fps:30,render(t){const n=Math.abs(t-1)>.001&&Math.abs(t-1)<.003?SHOT.sampleContext.motionBlur:0;document.querySelector('#stage').style.background='rgb('+(t<1?0:255-n)+',0,0)'}};
</script>`);
  const options = { ...settings, 'motion-blur': 6, raster: 'software' };
  const capture = await openShot(shot, 1, options);
  try {
    const adaptive = createPostCapture(capture, options);
    const actual = decodePNG(await adaptive.frame(1));
    const fixed = createPostCapture(capture, { ...options, 'motion-blur': 64, 'adaptive-blur': 0 });
    assert.equal(adaptive.lastBlurSamples, 64);
    assert.deepEqual(actual.data, decodePNG(await fixed.frame(1)).data);
    assert.ok(adaptive.stats.samples > 67);
  } finally { await capture.close(); }
});

for (const quality of ['standard', 'high']) (quality === 'standard' ? test : fullTest)(quality + ' verify passes reorder, reload, workers and explicit static reuse', { timeout: quality === 'high' ? 300000 : 120000 }, async () => {
  const maximum = quality === 'high' ? 256 : 64;
  const shot = await browserFixture('verify');
  // Two static frames and one changing frame retain every verification path.
  // A tiny changing surface still exercises upward sampling through the high grid.
  await writeFile(shot, `<style>html,body{margin:0}#stage{width:16px;height:12px}</style><div id="stage"></div><script>
window.SHOT={duration:0.375,fps:8,cuts:[0.1875],render(t){const v=t<0.1875?24:Math.round(t*12000)%256;document.querySelector('#stage').style.background='rgb('+v+','+v+','+v+')'}};
</script>`);
  const result = await verifyShot(shot, { ...settings, quality, 'max-motion-blur': maximum, 'no-static-reuse': false, 'static-reuse': true,
    raster: 'software', grain: 2, workers: 2, at: '0,0.25', 'no-lint': true,
    out: path.join(out, 'verify-' + quality), 'job-dir': path.join(out, 'jobs'), onEvent() {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const name of ['reorder', 'reload', 'workers:1', 'workers:2', 'range', 'static-reuse:workers:1', 'static-reuse:workers:2']) assert.ok(result.data.checks.some(c => c.name === name && c.passed));
  assert.equal(result.data.post.maxMotionBlur, maximum);
  assert.equal(result.data.blurSamples.min, 1);
  assert.ok(result.data.blurSamples.max <= maximum);
  assert.ok(result.data.blurSamples.max >= (quality === 'high' ? 128 : 64));
  assert.equal(JSON.parse(await readFile(result.artifacts.at(-1).path)).changedPixels, 0);
});

fullTest('worker histograms count only delivered frames, including audit repairs', { timeout: 120000 }, async () => {
  const shot = await browserFixture('pool');
  await writeFile(shot, html.replace('cuts:[0.5]', 'cuts:[]').replaceAll('0.5', '0.25')
    .replace('window.SHOT=', 'if(globalThis.__multiplaneStatic)globalThis.__multiplaneStatic.read=()=>false;window.SHOT='));
  const histograms = [];
  for (const workers of [1, 2]) {
    const pool = createRenderPool(shot, { ...settings, 'no-static-reuse': false, transport: 'raw', raster: 'software' }, 8, workers, { width: 64, height: 48 });
    try {
      const counts = {};
      for await (const frame of pool.frames(0, 8)) counts[frame.blurSamples] = (counts[frame.blurSamples] ?? 0) + 1;
      assert.deepEqual(pool.blurSamples, blurSampleReport(counts));
      assert.equal(Object.values(counts).reduce((a, b) => a + b), 8);
      assert.equal(pool.staticReuse.disabledReason, 'pixel_mismatch');
      histograms.push(pool.blurSamples);
    } finally { await pool.close(); }
  }
  assert.deepEqual(histograms[0], histograms[1]);
});

fullTest('stills report effective post and contributing samples, and CLI accepts the maximum', { timeout: 120000 }, async () => {
  const shot = await browserFixture('stills');
  const result = await stillsShot(shot, { raster: 'software', at: '0,0.75', 'no-lint': true, onEvent() {}, 'job-dir': path.join(out, 'jobs'), out: path.join(out, 'stills') });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.post.maxMotionBlur, 64);
  assert.deepEqual(result.data.blurSamples, { min: 1, max: 64, mean: 32.5, histogram: { 1: 1, 64: 1 } });
  const cli = await run(process.execPath, ['bin/multiplane', 'stills', shot, '--max-motion-blur', '16', '--at', '0.75', '--no-lint', '--json', '--out', path.join(out, 'cli'), '--job-dir', path.join(out, 'jobs')]);
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  const data = JSON.parse(cli.stdout.trim().split('\n').at(-1)).data;
  assert.equal(data.post.maxMotionBlur, 16); assert.equal(data.blurSamples.max, 16);
});

fullTest('crash during selected grid restarts from probes with unchanged pixels and counts', { timeout: 120000 }, async t => {
  const shot = await browserFixture('recovery'), options = { ...settings, raster: 'software' };
  const capture = await openShot(shot, 1, options); t.after(() => capture.close());
  const expected = await createPostCapture(capture, options).frame(0.75);
  const begin = capture.beginFrame; let calls = 0;
  capture.beginFrame = async (...args) => { if (++calls === 5) await capture.page.close(); return begin(...args); };
  const processed = createPostCapture(capture, options);
  assert.deepEqual(await processed.frame(0.75), expected);
  assert.equal(processed.stats.frames, 1); assert.equal(processed.lastBlurSamples, 64);
});

fullTest('render result aggregates sample counts and invalid CLI maximum fails before launch', { timeout: 120000 }, async () => {
  const shot = await browserFixture('render');
  const command = ['bin/multiplane', 'render', shot, '--workers', '2', '--no-lint', '--json', '--out', path.join(out, 'render.mp4'), '--job-dir', path.join(out, 'jobs')];
  for (const value of ['0', '-1', '1.5', 'NaN']) {
    const result = await run(process.execPath, [...command, '--max-motion-blur', value]);
    assert.notEqual(result.code, 0);
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).code, 'invalid_option');
    assert.ok(events.every(e => e.type !== 'environment'));
  }
  const result = await run(process.execPath, [...command, '--max-motion-blur', '16']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout.trim().split('\n').at(-1)).data;
  assert.equal(data.post.maxMotionBlur, 16); assert.equal(data.blurSamples.max, 16);
  assert.equal(Object.values(data.blurSamples.histogram).reduce((a, b) => a + b), data.frames);
});
