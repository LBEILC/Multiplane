import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { averageAlpha, resizeAlpha, clearHiddenColors } from '../src/alpha.mjs';
import { createPostCapture } from '../src/post.mjs';
import { openShot } from '../src/capture.mjs';
import { encodePNG, decodePNG } from '../src/png.mjs';
import { resolveFormat, videoEncoding } from '../src/format.mjs';
import { renderShot } from '../src/render.mjs';
import { stillsShot } from '../src/stills.mjs';
import { verifyShot } from '../src/verify.mjs';
import { doctor } from '../src/doctor.mjs';
import { resolveFFmpeg, ffmpegOutput } from '../src/ffmpeg.mjs';
import { checkVideo, probeVideo } from '../src/output-check.mjs';
import { checkAlphaVideo } from '../src/output-alpha.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const image = (...values) => ({ width: values.length / 4, height: 1, data: Buffer.from(values) });
const observer = { check() {}, warning() {} };
await mkdir('out/tests', { recursive: true });
const out = createTempDirectory(path.resolve('out/tests/alpha-'));
const options = { 'job-dir': path.join(out, 'jobs'), workers: 1, onEvent() {} };
const ffmpeg = await resolveFFmpeg();
const encoderList = await ffmpegOutput(ffmpeg, ['-encoders']);
const decoderList = await ffmpegOutput(ffmpeg, ['-decoders']);
const hasEncoder = name => new RegExp(`\\b${name}\\b`).test(encoderList);

test('premultiplied averaging ignores hidden RGB, preserves linear light and zeros empty pixels', () => {
  assert.deepEqual(averageAlpha([image(255, 0, 0, 128), image(0, 255, 0, 0)]).data, Buffer.from([255, 0, 0, 64]));
  assert.deepEqual(averageAlpha([image(255, 0, 0, 128), image(0, 0, 255, 128)]).data, Buffer.from([188, 0, 188, 128]));
  assert.deepEqual(averageAlpha([image(255, 0, 255, 0), image(0, 255, 0, 0)]).data, Buffer.alloc(4));
  assert.deepEqual(clearHiddenColors(image(255, 255, 255, 0, 25, 30, 35, 1)).data, Buffer.from([0, 0, 0, 0, 25, 30, 35, 1]));
});

test('both resize directions weight linear premultiplied RGBA, including nearest and hidden colors', () => {
  const source = image(255, 0, 0, 128, 0, 255, 0, 0);
  assert.deepEqual(resizeAlpha(source, 1, 1).data, Buffer.from([255, 0, 0, 64]));
  assert.deepEqual(resizeAlpha(image(255, 0, 0, 128, 0, 0, 255, 128), 1, 1).data, Buffer.from([188, 0, 188, 128]));
  for (const kernel of ['neighbor', 'lanczos']) {
    const scaled = resizeAlpha(source, 8, 1, kernel);
    for (let p = 0; p < scaled.data.length; p += 4) {
      assert.equal(scaled.data[p + 1], 0); assert.equal(scaled.data[p + 2], 0);
      assert.equal(scaled.data[p], scaled.data[p + 3] ? 255 : 0);
    }
  }
  // Negative Lanczos lobes may overshoot alpha=1; constant visible RGB must stay constant.
  const edge = resizeAlpha(image(80, 120, 160, 255, 255, 0, 255, 0), 12, 1);
  for (let p = 0; p < edge.data.length; p += 4) {
    assert.deepEqual(edge.data.subarray(p, p + 3), Buffer.from(edge.data[p + 3] ? [80, 120, 160] : [0, 0, 0]));
  }
});

test('moving translucent block averages coverage; alpha-only motion cannot use the opaque adaptive shortcut', async () => {
  const samples = [image(255, 0, 0, 128, 0, 255, 0, 0), image(0, 255, 0, 0, 255, 0, 0, 128)];
  const capture = { width: 2, height: 2, fps: 2, duration: 1, cuts: [], alpha: true, post: {},
    frame: async t => encodePNG({ width: 2, height: 2, data: Buffer.concat([samples[t < 0.5 ? 0 : 1].data, samples[t < 0.5 ? 0 : 1].data]) }) };
  const post = createPostCapture(capture, { 'motion-blur': 2, shutter: 1, transport: 'raw' });
  assert.deepEqual(await post.frame(0.5), Buffer.from(Array(4).fill([255, 0, 0, 64]).flat()));
  capture.frame = async t => encodePNG({ width: 2, height: 2, data: Buffer.from(Array(4).fill([255, 0, 0, t < 0.5 ? 64 : 192]).flat()) });
  assert.deepEqual(await createPostCapture(capture, { 'motion-blur': 2, transport: 'raw' }).frame(0.5), Buffer.from(Array(4).fill([255, 0, 0, 128]).flat()));
});

test('grain preserves every alpha value and leaves zero-alpha colors at zero', async () => {
  const source = { width: 2, height: 2, data: Buffer.from([200, 30, 70, 0, 100, 100, 100, 1, 100, 100, 100, 128, 100, 100, 100, 255]) };
  const capture = { ...source, fps: 12, duration: 1, cuts: [], alpha: true, post: {}, frame: async () => encodePNG(source) };
  const result = await createPostCapture(capture, { grain: 8, transport: 'raw' }).frame(0);
  assert.deepEqual([...result.filter((_, i) => i % 4 === 3)], [0, 1, 128, 255]);
  assert.deepEqual(result.subarray(0, 4), Buffer.alloc(4));
  assert.notDeepEqual(result.subarray(4), source.data.subarray(4));
});

test('format inference, mismatch errors, alpha MP4 hint and fixed encoders', () => {
  assert.equal(resolveFormat(), 'mp4');
  for (const format of ['mp4', 'webm', 'mov']) assert.equal(resolveFormat({ out: `clip.${format}` }), format);
  assert.throws(() => resolveFormat({ out: 'clip.mp4', format: 'mov' }), { code: 'invalid_option' });
  assert.throws(() => resolveFormat({ format: 'webm', encoder: 'x264' }), { code: 'invalid_option' });
  assert.throws(() => resolveFormat({ format: 'webm', 'max-bitrate': 5 }), { code: 'invalid_option' });
  assert.throws(() => resolveFormat({ alpha: true }), e => e.code === 'invalid_option' && /--format webm.*--format mov/.test(e.hint));
  assert.equal(videoEncoding({ format: 'mov', alpha: true }).pixelFormat, 'yuva444p10le');
  assert.equal(videoEncoding({ format: 'webm', alpha: true }).pixelFormat, 'yuva420p');
  assert.deepEqual(videoEncoding({ format: 'mp4', encoder: null }).args, ['-c:v', 'libx264', '-profile:v', 'high', '-crf', '16']);
});

test('fast PNG preserves alpha; authored opaque backgrounds remain opaque; explicit alpha overrides metadata', async () => {
  const capture = await openShot('examples/alpha.html');
  try {
    const fast = decodePNG(await capture.frame(0.5));
    assert.ok(fast.data.some((v, i) => i % 4 === 3 && v === 0));
    assert.ok(fast.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255));
    const cdp = await capture.page.context().newCDPSession(capture.page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: false, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 320, height: 180, scale: 1 } });
    assert.deepEqual(fast.data, decodePNG(Buffer.from(data, 'base64')).data);
  } finally { await capture.close(); }
  for (const [shot, alpha] of [['examples/animation.html', true], ['examples/alpha.html', false]]) {
    const c = await openShot(shot, 1, { alpha });
    try { assert.ok(decodePNG(await c.frame(0.5)).data.every((v, i) => i % 4 !== 3 || v === 255)); }
    finally { await c.close(); }
  }
});

test('transparent browser canvas needs no runtime CSS and preserves authored page backgrounds', async () => {
  const file = path.join(out, 'plain-alpha.html');
  await writeFile(file, '<style>html,body{margin:0}#stage{width:16px;height:16px}</style><div id="stage"></div><script>window.SHOT={duration:1,post:{alpha:true},render(){}}</script>');
  for (const backend of ['cdp', 'playwright']) {
    const capture = await openShot(file, 0.5, { capture: backend });
    try {
      const processed = createPostCapture(capture, { scale: 0.5, transport: 'raw' });
      assert.deepEqual(await processed.frame(0), Buffer.alloc(8 * 8 * 4));
      await capture.page.evaluate(() => { document.body.style.background = 'rgb(20, 40, 60)'; });
      assert.deepEqual(await processed.frame(0), Buffer.from(Array(8 * 8).fill([20, 40, 60, 255]).flat()));
    } finally { await capture.close(); }
  }
});

test('transparent stills, scaling and contact sheet; start and result report effective defaults', { timeout: 120000 }, async () => {
  for (const [scale, renderScale] of [[1, 1], [0.5, 0.5], [1, 0.5]]) {
    const recorded = [];
    const result = await stillsShot('examples/alpha.html', { ...options, scale, 'render-scale': renderScale, at: '0.5', out: path.join(out, `stills-${scale}-${renderScale}`), onEvent: e => recorded.push(e) });
    const png = await readFile(result.data.stills[0].path), decoded = decodePNG(png);
    assert.equal(png[25], 6); assert.equal(decoded.width, 320 * scale);
    assert.equal(result.data.alpha, true); assert.equal(result.data.format, 'png');
    assert.equal(recorded[0].type, 'start'); assert.equal(recorded[0].options.alpha, true);
    assert.equal(recorded[0].options.format, 'png');
    assert.ok(decoded.data.some((v, i) => i % 4 === 3 && v === 0));
    const sheet = decodePNG(await readFile(result.data.contactSheet));
    assert.ok(sheet.data.every((v, i) => i % 4 !== 3 || v === 255));
    assert.notDeepEqual(sheet.data.subarray(0, 3), sheet.data.subarray(12 * 4, 12 * 4 + 3));
  }
});

test('alpha RGBA determinism: reordered samples, reload, one and two workers, blur, grain and scaling', { timeout: 120000 }, async () => {
  const result = await verifyShot('examples/alpha.html', { ...options, workers: 2, grain: 2, 'render-scale': 0.5, at: '0,0.5,1,1.5', out: path.join(out, 'verify') });
  assert.equal(result.data.passed, true); assert.equal(result.data.alpha, true);
  assert.deepEqual(result.data.checks.map(c => c.name), ['reorder', 'reload', 'workers:1', 'workers:2', 'range']);
});

for (const [format, encoder] of [['webm', 'libvpx-vp9'], ['mov', 'prores_ks']]) {
  const missing = !hasEncoder(encoder) ? `${process.platform}: FFmpeg lacks ${encoder}; ${format} alpha test requires it.`
    : format === 'webm' && !/\blibvpx-vp9\b/.test(decoderList) ? `${process.platform}: FFmpeg lacks libvpx-vp9 decoder; alpha cannot be inspected.` : false;
  test(`${process.platform}: ${format} encoder availability and real alpha round trip`, { timeout: 120000, skip: missing }, async t => {
    t.diagnostic(`${process.platform}: ${encoder} available${format === 'webm' ? '; libvpx-vp9 decoder available' : ''}.`);
    const recorded = [];
    const result = await renderShot('examples/alpha.html', { ...options, out: path.join(out, `alpha.${format}`), onEvent: e => recorded.push(e) });
    assert.equal(result.data.format, format); assert.equal(result.data.alpha, true);
    assert.equal(result.data.outputCheck.verified, true); assert.match(result.data.outputCheck.pixelFormat, /^yuva/);
    assert.equal(recorded[0].options.alpha, true); assert.equal(recorded[0].options.format, format);
    const capture = await openShot('examples/alpha.html');
    const references = new Map();
    try {
      const processed = createPostCapture(capture, { transport: 'raw' });
      for (const frame of [0, 12]) references.set(frame, (await processed.frame(frame / 12, frame)).filter((_, i) => i % 4 === 3));
    } finally { await capture.close(); }
    const checked = await checkAlphaVideo(ffmpeg, result.data.output, format, references, 320, 180, observer);
    t.diagnostic(`frames 0,12: maximum alpha error ${checked.maxAlphaError}/255.`);
    assert.ok(checked.maxAlphaError <= 2);
    // A real file with alpha removed must never be accepted based on metadata alone.
    const original = await readFile(result.data.output);
    await assert.rejects(renderShot('examples/alpha.html', { ...options, out: result.data.output, overwrite: true,
      _probeVideo: async (executable, file, events) => {
        const stripped = file + '.stripped.' + format;
        const encoded = await run(executable, ['-v', 'error', '-i', file, '-an', '-c:v', encoder, ...(format === 'mov' ? ['-profile:v', '4'] : []), '-pix_fmt', format === 'mov' ? 'yuv444p10le' : 'yuv420p', stripped]);
        assert.equal(encoded.code, 0, encoded.stderr); await rename(stripped, file);
        // Deliberately forge the pixel-format report to exercise the decoded-alpha guard.
        return { ...await probeVideo(executable, file, events), pixelFormat: 'yuva420p' };
      },
    }), { code: 'output_invalid' });
    assert.deepEqual(await readFile(result.data.output), original);
    assert.equal((await readdir(out)).some(name => name.includes('.partial.')), false);
    const opaque = await renderShot('examples/alpha.html', { ...options, alpha: false, to: 0.25, out: path.join(out, `opaque.${format}`) });
    assert.equal(opaque.data.alpha, false); assert.equal(opaque.data.outputCheck.verified, true);
    const implicit = await renderShot('examples/alpha.html', { ...options, format, to: 1 / 12 });
    assert.equal(path.extname(implicit.data.output), '.' + format);
    assert.equal(implicit.data.frames, 1); assert.equal(implicit.data.alpha, true);
  });
}

test('missing requested encoder fails render with ffmpeg_unusable; doctor reports optional availability', { timeout: 120000 }, async () => {
  const { inspectFFmpeg } = await import('../src/ffmpeg.mjs');
  for (const [format, encoder] of [['webm', 'libvpx-vp9'], ['mov', 'prores_ks']]) {
    await assert.rejects(renderShot('examples/alpha.html', { ...options, format,
      _inspectFFmpeg: (executable, env, requested) => inspectFFmpeg(executable, env, requested,
        async (_, args) => args[0] === '-version' ? 'ffmpeg version test' : ' V....D libx264'),
    }), e => e.code === 'ffmpeg_unusable' && e.details.reason === `Missing encoder: ${encoder}`);
  }
  const result = await doctor({ ffmpeg, onEvent() {} });
  for (const name of ['libvpx-vp9', 'prores_ks']) {
    const check = result.data.checks.find(c => c.name === name);
    assert.equal(check.ok, hasEncoder(name)); assert.match(check.detail, /optional/);
  }
});

test('transparent probe failure is fatal and opaque-format metadata cannot claim alpha', async () => {
  const expected = { frames: 1, width: 2, height: 2, fps: 1, durationSeconds: 1, alpha: true };
  await assert.rejects(checkVideo('', '', expected, observer, async () => { throw Error('probe unavailable'); }), { code: 'output_invalid' });
  await assert.rejects(checkVideo('', '', expected, observer, async () => ({ ...expected, codec: 'vp9', pixelFormat: 'yuv420p' })), { code: 'output_invalid' });
});

test('CLI accepts alpha for stills and verify, rejects alpha MP4 and conflicting format flags', { timeout: 120000 }, async () => {
  for (const args of [['--alpha'], ['--format', 'webm', '--encoder', 'x264'], ['--format', 'mov', '--out', path.join(out, 'bad.webm')]]) {
    const result = await run(process.execPath, ['bin/multiplane', 'render', 'examples/alpha.html', ...args, '--json', '--job-dir', path.join(out, 'jobs')]);
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).code, 'invalid_option');
  }
  for (const command of ['stills', 'verify']) {
    const help = await run(process.execPath, ['bin/multiplane', command, 'examples/alpha.html', '--help']);
    assert.equal(help.code, 0); assert.match(help.stdout, /--alpha(?! <value>)/);
    const result = await run(process.execPath, ['bin/multiplane', command, 'examples/alpha.html', '--alpha', '--no-post',
      '--at', '0', '--out', path.join(out, 'cli-' + command), '--job-dir', path.join(out, 'jobs'), '--json']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const last = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(last.data.alpha, true); assert.equal(last.data.format, 'png');
  }
});

test('fixed-format rendering ignores a saved MP4 encoder preference but rejects an explicit encoder', { timeout: 60000, skip: !hasEncoder('prores_ks') && `${process.platform}: FFmpeg lacks prores_ks.` }, async () => {
  const home = path.join(out, 'configured-home'); await mkdir(home);
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ schema: 'multiplane/1', encoder: 'nvenc-h264' }));
  const result = await run(process.execPath, ['bin/multiplane', 'render', 'examples/alpha.html', '--format', 'mov', '--to', '0.08333333333333333', '--workers', '1', '--job-dir', path.join(out, 'jobs'), '--json'], { env: { ...process.env, MULTIPLANE_HOME: home } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const recorded = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(recorded[0].options.encoder, undefined);
  assert.equal(recorded.at(-1).data.encoder, 'prores_ks');
  assert.equal(path.extname(recorded.at(-1).data.output), '.mov');
});
