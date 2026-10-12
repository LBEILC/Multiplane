// Task 031 evidence: use the current machine's Chromium and FFmpeg only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { decodePNG } from '../src/png.mjs';
import { renderShot } from '../src/render.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { probeVideo } from '../src/output-check.mjs';
import { checkAlphaVideo } from '../src/output-alpha.mjs';

const directory = path.resolve('out/031');
await mkdir(directory, { recursive: true });
process.env.MULTIPLANE_HOME = path.join(directory, 'home');
process.env.MULTIPLANE_NO_INDEX = '1';
const ffmpeg = await resolveFFmpeg();
const report = { screenshot: {}, regression: {}, output: {} };
const capture = await openShot('examples/alpha.html');
try {
  await capture.frame(0.5);
  const session = await capture.page.context().newCDPSession(capture.page);
  const times = { fast: [], normal: [] }, sizes = { fast: [], normal: [] };
  for (let i = 0; i < 22; i++) {
    const images = [];
    for (const fast of (i % 2 ? [true, false] : [false, true])) {
      const start = performance.now();
      const result = await session.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: fast,
        captureBeyondViewport: false, clip: { x: 0, y: 0, width: capture.width, height: capture.height, scale: 1 } });
      const ms = performance.now() - start, png = Buffer.from(result.data, 'base64');
      const image = decodePNG(png);
      images.push(image);
      assert.equal(png[25], 6);
      assert.ok(image.data.some((v, p) => p % 4 === 3 && v === 0));
      assert.ok(image.data.some((v, p) => p % 4 === 3 && v > 0 && v < 255));
      if (i >= 2) { times[fast ? 'fast' : 'normal'].push(ms); sizes[fast ? 'fast' : 'normal'].push(png.length); }
    }
    assert.deepEqual(images[0].data, images[1].data);
  }
  for (const name of ['fast', 'normal']) {
    const sorted = times[name].sort((a, b) => a - b);
    report.screenshot[name] = { frames: sorted.length, medianMs: (sorted[9] + sorted[10]) / 2,
      meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, pngBytes: sizes[name][0] };
  }
  report.screenshot.equalRGBA = true;
} finally { await capture.close(); }

function git(args) {
  const result = spawnSync('git', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr.toString());
  return result.stdout;
}
const reference = process.argv[2];
if (reference) {
  report.baselineCommit = git(['rev-parse', reference]).toString().trim();
  const baseline = path.join(directory, 'baseline-renderer');
  const files = git(['ls-tree', '-r', '--name-only', reference, '--', 'src', 'package.json']).toString().trim().split('\n');
  for (const file of files) {
    const target = path.join(baseline, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, git(['show', `${reference}:${file}`]));
  }
  const { renderShot: renderBefore } = await import(pathToFileURL(path.join(baseline, 'src/render.mjs')).href);
  for (const name of ['animation', 'typography', 'three-cards']) {
    const hashes = {}, videos = {};
    for (const [label, render] of [['before', renderBefore], ['after', renderShot]]) {
      const hashFile = path.join(directory, `${name}-${label}-frames.json`);
      process.env.RENDER_FRAME_HASHES = hashFile;
      const result = await render(`examples/${name}.html`, { out: path.join(directory, `${name}-${label}.mp4`),
        overwrite: true, grain: 2, workers: 1, 'job-dir': path.join(directory, 'jobs'), onEvent() {} });
      hashes[label] = JSON.parse(await readFile(hashFile, 'utf8'));
      videos[label] = await decodeHash(result.data.output);
    }
    delete process.env.RENDER_FRAME_HASHES;
    assert.deepEqual(hashes.before, hashes.after);
    assert.deepEqual(videos.before, videos.after);
    report.regression[name] = { frames: hashes.after.length, equalSourceRGBA: true, equalDecodedRGBA: true, ...videos.after };
  }
}

function decodeHash(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    let bytes = 0, stderr = ''; const hash = createHash('sha256');
    child.stdout.on('data', data => { hash.update(data); bytes += data.length; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ decodedBytes: bytes, sha256: hash.digest('hex') }) : reject(Error(stderr)));
  });
}

const references = new Map();
const alpha = await openShot('examples/alpha.html');
try {
  const post = createPostCapture(alpha, { transport: 'raw' });
  for (const frame of [0, 12]) references.set(frame, (await post.frame(frame / 12, frame)).filter((_, i) => i % 4 === 3));
} finally { await alpha.close(); }
for (const format of ['mp4', 'webm', 'mov']) {
  const file = path.join(directory, `evidence.${format}`);
  const result = await renderShot(format === 'mp4' ? 'examples/animation.html' : 'examples/alpha.html', {
    out: file, overwrite: true, workers: 1, 'job-dir': path.join(directory, 'jobs'), onEvent() {},
  });
  report.output[format] = { result: { ...result.data, output: `evidence.${format}` },
    decode: await probeVideo(ffmpeg, file, undefined, undefined, { alpha: format !== 'mp4', format }),
    ...(format !== 'mp4' ? { alpha: await checkAlphaVideo(ffmpeg, file, format, references, 320, 180) } : {}) };
  if (process.env.MULTIPLANE_FFPROBE) {
    const probe = spawnSync(process.env.MULTIPLANE_FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames:stream_tags=alpha_mode', '-of', 'json', file], { windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr.toString());
    report.output[format].ffprobe = JSON.parse(probe.stdout.toString());
  }
}
await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
