import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, rename, mkdir } from 'node:fs/promises';
import { run, createTempDirectory } from './helpers.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { probeVideo, checkVideo, checkStill } from '../src/output-check.mjs';
import { renderShot } from '../src/render.mjs';
import { stillsShot } from '../src/stills.mjs';
import { verifyShot } from '../src/verify.mjs';
import { encodePNG } from '../src/png.mjs';
import { MultiplaneError } from '../src/errors.mjs';

await mkdir('out', { recursive: true });
const root = createTempDirectory(path.resolve('out/test-output-check-'));
const shot = path.join(root, 'shot.html');
await writeFile(shot, '<div id="stage" style="width:64px;height:48px;background:#123456"></div><script>window.SHOT={duration:1,fps:12,cuts:[],ready:Promise.resolve()};window.SHOT.render=t=>{document.querySelector("#stage").style.opacity=String(0.5+t/2)}</script>');
const options = { root, 'job-dir': path.join(root, 'jobs'), 'no-lint': true, 'no-post': true, workers: 1, raster: 'software' };
const events = { check() {}, warning() {} };

test('video check rejects every measured mismatch and permits at most one frame of duration error', async () => {
  const expected = { frames: 12, durationSeconds: 1, fps: 12, width: 64, height: 48 };
  const actual = { ...expected, codec: 'h264', pixelFormat: 'yuv420p' };
  assert.equal((await checkVideo('', '', expected, events, async () => actual)).verified, true);
  for (const key of Object.keys(expected)) {
    await assert.rejects(checkVideo('', '', expected, events, async () => ({ ...actual, [key]: actual[key] + 1 })), e => e.code === 'output_invalid' && e.exitCode === 4 && e.details.expected[key] === expected[key]);
  }
  assert.equal((await checkVideo('', '', expected, events, async () => ({ ...actual, durationSeconds: 1 + 1/12 }))).verified, true);
  await assert.rejects(checkVideo('', '', expected, events, async () => ({ ...actual, durationSeconds: 1 + 1/12 + 1e-8 })), { code: 'output_invalid' });
});

test('real render verifies, failed probe publishes, truncated video preserves overwrite target', { timeout: 120000 }, async () => {
  const ffmpeg = await resolveFFmpeg();
  const recorded = {};
  const output = path.join(root, 'video.mp4');
  const success = await renderShot(shot, { ...options, out: output, onEvent: e => { if (e.type === 'result') recorded.success = e; } });
  assert.equal(success.data.outputCheck.verified, true);
  assert.equal(success.data.outputCheck.frames, 12);
  const original = await readFile(output);
  let warning;
  const unverified = await renderShot(shot, { ...options, out: path.join(root, 'unverified.mp4'), _probeVideo: async () => { throw Error('Injected probe failure.'); }, onEvent: e => { if (e.type === 'warning') warning = e; if (e.type === 'result') recorded.unverified = e; } });
  assert.equal(unverified.data.outputCheck.verified, false);
  assert.equal(warning.code, 'output_unverified'); assert.equal(warning.details.reason, 'Injected probe failure.');
  await assert.rejects(renderShot(shot, { ...options, out: output, overwrite: true,
    _probeVideo: async (executable, file, observer) => {
      const short = file + '.short.mp4';
      const result = await run(executable, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-frames:v', '6', short]);
      assert.equal(result.code, 0, result.stderr); await rename(short, file);
      return probeVideo(executable, file, observer);
    }, onEvent: e => { if (e.type === 'result') recorded.invalid = e; },
  }), e => e.code === 'output_invalid' && e.details.actual.frames === 6 && e.details.expected.frames === 12);
  assert.deepEqual(await readFile(output), original);
  assert.equal((await readdir(root)).some(name => name.includes('.partial.')), false);
  assert.equal(recorded.invalid.artifacts.length, 0);
  const probe = await probeVideo(ffmpeg, output);
  assert.equal(probe.fps, 12); assert.equal(probe.durationSeconds, 1);
  assert.deepEqual(await readFile(output), original);
  await mkdir('out/030', { recursive: true });
  await writeFile('out/030/events.json', JSON.stringify(recorded, null, 2));
});

test('unparseable FFmpeg output is unverified; missing executable is unverified', async () => {
  await assert.rejects(probeVideo(process.execPath, shot));
  await assert.rejects(probeVideo('', shot, undefined, () => spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })), /could not be parsed/);
  let warning;
  const result = await checkVideo(path.join(root, 'absent'), shot, {}, { ...events, warning: e => { warning = e; } });
  assert.equal(result.verified, false); assert.equal(warning.code, 'output_unverified');
});

test('probe uses rational fps and the decoded final frame duration', async () => {
  const log = [
    'Stream #0:0: Video: h264', 'Stream mapping:',
    '[Parsed_showinfo_0] config in time_base: 1/1000, frame_rate: 30000/1001',
    '[Parsed_showinfo_0] config out time_base: 0/0, frame_rate: 0/0',
    '[Parsed_showinfo_0] n: 0 pts: 0 pts_time:0 duration: 33 duration_time:0.033 fmt:yuv420p s:64x48',
    '[Parsed_showinfo_0] n: 1 pts: 33 pts_time:0.033 duration: 67 duration_time:0.067 fmt:yuv420p s:64x48',
  ].join('\n');
  const actual = await probeVideo('', '', undefined, () => spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(log)})`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
  assert.equal(actual.fps, 30000 / 1001); assert.equal(actual.durationSeconds, 0.1); assert.equal(actual.frames, 2);
  const missingAudio = 'Stream #0:1: Audio: aac\n' + log;
  await assert.rejects(probeVideo('', '', undefined, () => spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(missingAudio)})`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })), /audio duration could not be parsed/);
});

test('cancelling a running probe stops its child and does not publish an unverified result', { timeout: 10000 }, async () => {
  let cancelled = false, warned = false;
  const observer = { check() { if (cancelled) throw new MultiplaneError('cancelled'); }, warning() { warned = true; },
    onCancel(handler) { const timer = setTimeout(() => { cancelled = true; void handler(); }, 50); return () => clearTimeout(timer); } };
  await assert.rejects(checkVideo('', '', {}, observer, (exe, file, events) => probeVideo(exe, file, events,
    () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }))), { code: 'cancelled' });
  assert.equal(warned, false);
});

test('fractional-rate video records decoded audio duration', { timeout: 60000 }, async () => {
  const audio = path.join(root, 'audio.wav'), ffmpeg = await resolveFFmpeg();
  const generated = await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', audio]);
  assert.equal(generated.code, 0, generated.stderr);
  const result = await renderShot(shot, { ...options, fps: 29.97, audio });
  const check = result.data.outputCheck;
  assert.equal(check.verified, true); assert.equal(check.frames, 30); assert.equal(check.fps, 29.97);
  assert.ok(Math.abs(check.durationSeconds - 30 / 29.97) < 1e-6);
  assert.ok(check.audioDurationSeconds >= 1 && check.audioDurationSeconds < 1.05);
});

test('PNG validation decodes disk bytes, rejects corruption and wrong dimensions', async () => {
  const file = path.join(root, 'still.png'), expected = { width: 2, height: 2 };
  const good = encodePNG({ ...expected, data: Buffer.alloc(16, 255) });
  await writeFile(file, good); await checkStill(file, expected);
  assert.deepEqual(await readFile(file), good);
  for (const data of [Buffer.from('not a PNG'), good.subarray(0, 45), good]) {
    await writeFile(file, data);
    await assert.rejects(checkStill(file, { width: 4, height: 2 }), e => e.code === 'output_invalid');
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
});

test('stills and verify carry resources; sampled and unsampled video pixels match', { timeout: 120000 }, async () => {
  const stills = await stillsShot(shot, { ...options, at: '0' });
  assert.equal(stills.data.resources.workers, 1);
  const verify = await verifyShot(shot, { ...options, at: '0', workers: 2 });
  assert.equal(verify.data.resources.workers, 2);
  assert.ok(verify.data.resources.cpuCount > 0);
  const renders = [];
  for (const enabled of [false, true]) {
    const result = await renderShot(shot, { ...options, _resources: enabled });
    renders.push(result);
    const status = JSON.parse(await readFile(path.join(options['job-dir'], result.jobId, 'status.json')));
    assert.deepEqual(status.result.data.resources, result.data.resources);
    if (enabled) assert.ok(status.memoryBytes === null || status.memoryBytes > 0);
  }
  assert.equal(renders[0].data.resources.peakMemoryBytes, null);
  const ffmpeg = await resolveFFmpeg();
  const pixels = await Promise.all(renders.map(result => run(ffmpeg, ['-v', 'error', '-i', result.data.output, '-map', '0:v:0', '-f', 'framemd5', '-'])));
  assert.equal(pixels[0].code, 0); assert.equal(pixels[1].code, 0);
  assert.equal(pixels[0].stdout, pixels[1].stdout);
});
