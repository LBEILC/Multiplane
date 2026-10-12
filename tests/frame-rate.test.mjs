import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { frameRate } from '../src/frame-rate.mjs';
import { renderShot } from '../src/render.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { probeVideo } from '../src/output-check.mjs';
import { createTempDirectory, run } from './helpers.mjs';

test('encoding rates normalize NTSC shorthand and reduce other decimals at micro-fps precision', () => {
  for (const [fps, fraction] of [[24, '24/1'], [30, '30/1'], [60, '60/1'], [23.976, '24000/1001'],
    [29.97, '30000/1001'], [59.94, '60000/1001'], [30000 / 1001, '30000/1001'],
    [29.5, '59/2'], [12.345678, '6172839/500000'], [1e-6, '1/1000000'],
    [29.9702, '149851/5000']]) {
    assert.equal(frameRate(fps).argument, fraction);
  }
  const ntsc = 30000 / 1001;
  assert.equal(frameRate(ntsc + 0.000099).argument, '30000/1001');
  assert.equal(frameRate(ntsc - 0.000099).argument, '30000/1001');
  assert.notEqual(frameRate(ntsc + 0.000101).argument, '30000/1001');
  assert.notEqual(frameRate(ntsc - 0.000101).argument, '30000/1001');
  for (const fps of [Math.PI, 12.3456784, 12.3456786]) assert.ok(Math.abs(frameRate(fps).fps - fps) <= 0.0000005);
  assert.equal(frameRate(29.97).seconds(30), 1.001);
  for (const fps of [0, -1, NaN, Infinity, 1e-8, 2147483648]) assert.throws(() => frameRate(fps), { code: 'invalid_option' });
});

test('all output formats preserve every supplied frame with integer, NTSC and decimal rates, with and without audio', { timeout: 240000 }, async t => {
  const root = createTempDirectory('multiplane-frame-rate-');
  const shot = path.join(root, 'shot.html'), audio = path.join(root, 'short.wav');
  await writeFile(shot, '<div id="stage" style="width:64px;height:48px;background:#123456"></div><script>window.SHOT={duration:1,fps:24,cuts:[],render(t){document.querySelector("#stage").style.opacity=String(0.5+t/2)}}</script>');
  const ffmpeg = await resolveFFmpeg();
  const generated = await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.2', audio]);
  assert.equal(generated.code, 0, generated.stderr);
  for (const format of ['mp4', 'webm', 'mov']) {
    for (const [fps, numerator, denominator] of [[24, 24, 1], [23.976, 24000, 1001], [29.97, 30000, 1001], [59.94, 60000, 1001], [29.5, 59, 2]]) {
      for (const withAudio of [false, true]) {
        await t.test(`${format} / ${fps} / audio=${withAudio}`, async () => {
          let expected;
          const diagnostic = process.env.CI === 'true' && process.env.MULTIPLANE_CI_FRAME_DIAGNOSTICS === '1';
          const result = await renderShot(shot, { root, 'job-dir': path.join(root, 'jobs'),
            format, fps, ...(withAudio ? { audio } : {}), workers: 1, raster: 'software',
            'no-lint': true, 'no-post': true,
            _probeVideo: async (exe, file, events, spawn, expectation) => {
              expected = expectation;
              if (diagnostic) await saveDiagnostics(exe, file, { format, fps, withAudio, expected: expectation });
              return probeVideo(exe, file, events, spawn, expectation);
            },
          });
          const frames = Math.ceil(fps), duration = frames * denominator / numerator;
          const check = result.data.outputCheck;
          assert.equal(result.data.frames, frames);
          assert.equal(check.verified, true);
          assert.equal(check.frames, result.data.frames);
          assert.equal(expected.durationSeconds, duration);
          assert.equal(expected.fps, numerator / denominator);
          assert.ok(Math.abs(check.fps - numerator / denominator) / (numerator / denominator) <= 1e-4);
          // WebM timestamps have millisecond precision; retain the production check.
          assert.ok(Math.abs(check.durationSeconds - duration) <= 0.002);
          if (withAudio) assert.ok(Math.abs(check.audioDurationSeconds - duration) < 0.05);
          else assert.equal(check.audioDurationSeconds, undefined);
        });
      }
    }
  }
});

// Retain successful cases too: a passing isolated probe plus a failing mixed
// probe is the evidence for a probe-only failure, even when CI becomes green.
async function saveDiagnostics(ffmpeg, file, { format, fps, withAudio, expected }) {
  const directory = path.resolve('out/ci/frame-rate', format + '-' + fps + '-audio-' + withAudio);
  await mkdir(directory, { recursive: true });
  await copyFile(file, path.join(directory, 'output.' + format));
  const passes = {
    packets: ['-map', '0:v:0', '-an', '-c', 'copy', '-debug_ts', '-loglevel', 'verbose'],
    frames: ['-map', '0:v:0', '-an', '-vf', 'showinfo=checksum=0', '-fps_mode', 'passthrough'],
    mixed: ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'showinfo=checksum=0', '-af', 'ashowinfo', '-fps_mode', 'passthrough'],
  };
  const summary = { expected };
  for (const [name, args] of Object.entries(passes)) {
    const result = await run(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-i', file, ...args, '-f', 'null', '-']);
    await writeFile(path.join(directory, name + '.log'), result.stderr);
    summary[name] = { exitCode: result.code, count: name === 'packets'
      ? Number([...result.stderr.matchAll(/Output stream #0:0 \(video\):\s*(\d+) packets muxed/g)].at(-1)?.[1] ?? NaN)
      : result.stderr.split('\n').filter(line => line.includes('Parsed_showinfo')
        && /\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:.*?fmt:(\S+).*?\bs:(\d+)x(\d+)/.test(line)).length };
  }
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
}
