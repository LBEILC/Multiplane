import './test-home.mjs';
import test from 'node:test';
import { chromium } from 'playwright';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createTempDirectory, run } from './helpers.mjs';
import { renderShot, resumeRender, MultiplaneError } from '../src/index.mjs';
import { readStatus } from '../src/jobs.mjs';
import { inspectFFmpeg, resolveFFmpeg } from '../src/ffmpeg.mjs';
import { atomicJSON, lockSegments, manifestStore, readManifest, reusableSegments, checkInputs, checkEnvironment } from '../src/segments.mjs';
import { digest, inputRecords } from '../src/input-records.mjs';
import { startServer } from '../src/server.mjs';
import { launch } from './fixtures/fake-hosted-app.mjs';
import { stopOwned } from '../app/src/main/owned-process.mjs';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('out/tests', { recursive: true });
const root = createTempDirectory(path.resolve('out/tests/resume-'));
const jobs = path.join(root, 'jobs');
const options = { root, 'job-dir': jobs, workers: 2, 'no-lint': true, _segmentFrames: 4, 'no-post': true };
const shot = path.join(root, 'shot.html');
const late = path.join(root, 'late.json');
await writeFile(late, '{}');
await writeFile(shot, `<!doctype html><style>body{margin:0}#stage{width:640px;height:360px;background:#abc}i{display:block;width:70px;height:60px;background:#e24}</style><div id="stage"><i></i></div><script>window.SHOT={duration:2,fps:8};window.SHOT.render=async t=>{document.querySelector('i').style.transform='translateX('+t*50+'px)';if(t>=.5)await fetch('late.json')}</script>`);
const reason = value => error => error.code === 'resume_unavailable' && error.details.reason === value;

test('input collection records requested files and whole-file hashes for media ranges', async () => {
  const requested = {}, media = path.join(root, 'media.wav');
  const bytes = Buffer.alloc(1024 * 1024 + 1, 42);
  await writeFile(media, bytes);
  await inputRecords.run((file, record) => { requested[file] = record; }, async () => {
    const server = await startServer(0, root);
    try {
      await (await fetch(server.url + '/shot.html')).arrayBuffer();
      const response = await fetch(server.url + '/media.wav', { headers: { Range: 'bytes=10-20' } });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(10, 21));
    } finally { await server.close(); }
  });
  assert.deepEqual(requested[media], { bytes: bytes.length, sha256: digest(bytes) });
  assert.equal(requested[shot].sha256, digest(await readFile(shot)));
});

test('manifest verifies inputs, treats damaged segments as missing, and locks living owners', async () => {
  const directory = path.join(root, 'unit-segments');
  const release = lockSegments(directory);
  assert.throws(() => lockSegments(directory), reason('running'));
  release();
  atomicJSON(path.join(directory, 'render.lock'), { pid: 2147483647 });
  lockSegments(directory)();
  const bytes = Buffer.from('segment');
  await writeFile(path.join(directory, 'segment.mp4'), bytes);
  const manifest = { schema: 'multiplane-segments/1', shot, first: 0, end: 1, total: 1, segmentFrames: 1,
    options: {}, inputs: {}, segments: [{ file: 'segment.mp4', first: 0, end: 1, bytes: bytes.length, sha256: digest(bytes) }] };
  const store = manifestStore(directory, manifest);
  store.input(shot, { bytes: (await stat(shot)).size, sha256: digest(await readFile(shot)) });
  assert.equal((await reusableSegments(directory, readManifest(directory))).length, 1);
  await writeFile(path.join(directory, 'segment.mp4'), 'damaged');
  assert.equal((await reusableSegments(directory, manifest)).length, 0);
  await checkInputs(manifest);
  for (const key of ['multiplane', 'chromium', 'raster', 'ffmpeg', 'encoder']) {
    assert.throws(() => checkEnvironment({ [key]: 'old' }, { [key]: 'new' }), reason('environment_changed'));
  }
  assert.doesNotThrow(() => checkEnvironment({ renderer: 'old' }, { renderer: 'new' }));
  const original = await readFile(shot);
  await writeFile(shot, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(checkInputs(manifest), reason('inputs_changed'));
  await writeFile(shot, original);
});

test('resume rejects live/succeeded/non-render jobs and picture options before launching', async () => {
  const directory = path.join(jobs, 'fake'); await mkdir(directory, { recursive: true });
  for (const [state, command, expected] of [['running', 'render', 'running'], ['succeeded', 'render', 'succeeded'], ['failed', 'verify', 'not_render']]) {
    atomicJSON(path.join(directory, 'status.json'), { schema: 'multiplane/1', pid: process.pid, state, command });
    await assert.rejects(resumeRender(directory), reason(expected));
  }
  await assert.rejects(resumeRender(directory, { fps: 30 }), { code: 'invalid_option' });
  const cli = await run(process.execPath, ['bin/multiplane', 'resume', directory, '--fps', '30', '--json']);
  assert.equal(cli.code, 2); assert.match(cli.stdout, /invalid_option/);
});

async function interrupted(action) {
  try { await action(); assert.fail('Expected interruption'); }
  catch (error) { assert.equal(error.code, 'cancelled'); return path.join(jobs, error.result.jobId); }
}
const stopAt = (phase, index) => (stage, segment) => { if (phase === stage && index === segment) throw new MultiplaneError('cancelled'); };
async function md5(file) {
  const result = await run(await resolveFFmpeg(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

test('renderer changes warn and resume successfully without rewriting the original environment', { timeout: 60000 }, async t => {
  const smallShot = path.join(root, 'renderer-change.html');
  await writeFile(smallShot, '<div id="stage" style="width:64px;height:36px;background:#abc"></div><script>window.SHOT={duration:1,fps:2,render(){}}</script>');
  const original = await interrupted(() => renderShot(smallShot, { ...options, workers: 1,
    out: path.join(root, 'renderer-change.mp4'), _segmentFrames: 1, _segmentHook: stopAt('sealed', 0) }));
  const directory = path.join(original, 'segments');
  const before = readManifest(directory).environment;
  const after = before.renderer + ' (test driver update)';
  const realLaunch = chromium.launch.bind(chromium);
  t.mock.method(chromium, 'launch', async (...args) => {
    const browser = await realLaunch(...args);
    const realSession = browser.newBrowserCDPSession.bind(browser);
    t.mock.method(browser, 'newBrowserCDPSession', async () => {
      const session = await realSession();
      const realSend = session.send.bind(session);
      t.mock.method(session, 'send', async (method, ...params) => {
        const info = await realSend(method, ...params);
        if (method === 'SystemInfo.getInfo') info.gpu.auxAttributes = { ...info.gpu.auxAttributes, glRenderer: after };
        return info;
      });
      return session;
    });
    return browser;
  });
  const events = [];
  let checkedManifest = false;
  const result = await resumeRender(original, { onEvent: event => events.push(event),
    _segmentHook: phase => {
      if (phase === 'sealed') {
        assert.deepEqual(readManifest(directory).environment, before);
        checkedManifest = true;
      }
    } });
  assert.equal(checkedManifest, true);
  assert.equal(result.data.outputCheck.verified, true);
  assert.deepEqual(result.data.resume, { segmentsReused: 1, framesReused: 1 });
  const warnings = events.filter(event => event.type === 'warning' && event.code === 'resume_renderer_changed');
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].details, { before: before.renderer, after });
});

fullTest('two resumptions preserve every RGBA frame and decoded x264 frame; originals stay immutable', { timeout: 120000 }, async () => {
  process.env.RENDER_FRAME_HASHES = path.join(root, 'baseline-hashes.json');
  const baseline = await renderShot(shot, { ...options, out: path.join(root, 'baseline.mp4') });
  process.env.RENDER_FRAME_HASHES = path.join(root, 'resumed-hashes.json');
  const original = await interrupted(() => renderShot(shot, { ...options, out: path.join(root, 'resumed.mp4'), _segmentHook: stopAt('sealed', 0) }));
  const originalStatus = await readFile(path.join(original, 'status.json'));
  const status = await readStatus(original);
  assert.deepEqual(status.resume, { available: true, reason: null, framesDone: 4, framesTotal: 16 });
  const manifest = readManifest(path.join(original, 'segments'));
  assert.ok(Object.keys(manifest.inputs).includes(shot));
  const originalBytes = await readFile(shot); await writeFile(shot, Buffer.concat([originalBytes, Buffer.from(' ')]));
  await assert.rejects(resumeRender(original), reason('inputs_changed'));
  await writeFile(shot, originalBytes);
  await assert.rejects(resumeRender(original, { _inspectFFmpeg: async (...args) => ({ ...await inspectFFmpeg(...args), version: 'different' }) }), reason('environment_changed'));
  const manifestFile = path.join(original, 'segments/manifest.json');
  atomicJSON(manifestFile, { ...manifest, environment: { ...manifest.environment, multiplane: 'different' } });
  await assert.rejects(resumeRender(original), reason('environment_changed'));
  atomicJSON(manifestFile, manifest);
  const second = await interrupted(() => resumeRender(original, { _segmentHook: stopAt('sealed', 1) }));
  const secondStatus = await readFile(path.join(second, 'status.json'));
  assert.equal((await readStatus(second)).resume.framesDone, 8);
  assert.equal(readManifest(path.join(original, 'segments')).inputs[late].sha256, digest(Buffer.from('{}')));
  await rm(late);
  await assert.rejects(resumeRender(second), reason('inputs_changed'));
  await writeFile(late, '{}');
  const secondSegment = readManifest(path.join(original, 'segments')).segments[1];
  const segmentFile = path.join(original, 'segments', secondSegment.file);
  const damaged = await readFile(segmentFile); damaged[0] ^= 1;
  await writeFile(segmentFile, damaged);
  const events = [];
  const config = path.join(process.env.MULTIPLANE_HOME, 'config.json');
  const previousConfig = await readFile(config).catch(() => null);
  await writeFile(config, JSON.stringify({ encoder: 'nvenc-hevc', raster: 'software', ffmpeg: 'missing-ffmpeg' }));
  let result;
  try { result = await resumeRender(second, { workers: 1, onEvent: event => events.push(event) }); }
  finally { if (previousConfig) await writeFile(config, previousConfig); else await rm(config, { force: true }); }
  assert.deepEqual(result.data.resume, { segmentsReused: 1, framesReused: 4 });
  assert.equal(result.data.resumedFrom, path.basename(second));
  assert.deepEqual(events.find(event => event.type === 'start').resume, result.data.resume);
  assert.equal(result.command, 'render');
  assert.equal(result.data.encoder, 'x264');
  assert.deepEqual(await readFile(path.join(original, 'status.json')), originalStatus);
  assert.deepEqual(await readFile(path.join(second, 'status.json')), secondStatus);
  assert.deepEqual(JSON.parse(await readFile(process.env.RENDER_FRAME_HASHES)), JSON.parse(await readFile(path.join(root, 'baseline-hashes.json'))));
  assert.deepEqual(await md5(result.data.output), await md5(baseline.data.output));
  await assert.rejects(stat(path.join(original, 'segments')), { code: 'ENOENT' });
  await assert.rejects(resumeRender(path.join(jobs, result.jobId)), reason('succeeded'));
  delete process.env.RENDER_FRAME_HASHES;
});

fullTest('unsealed segments rerender; stop-file cancellation keeps sealed segments', { timeout: 120000 }, async () => {
  const launchFailure = await interrupted(() => renderShot(shot, { ...options, out: path.join(root, 'unsealed.mp4'),
    _inspectFFmpeg: async () => { throw new MultiplaneError('cancelled'); } }));
  assert.equal((await readStatus(launchFailure)).resume.available, true);
  const original = await interrupted(() => resumeRender(launchFailure, { _segmentHook: stopAt('beforeSeal', 0) }));
  assert.equal((await readStatus(original)).resume.framesDone, 0);
  let newJob;
  const second = await interrupted(() => resumeRender(original, {
    onEvent: event => { if (event.type === 'start') newJob = path.join(jobs, event.jobId); },
    _segmentHook: async (phase, index) => { if (phase === 'sealed' && index === 0) await writeFile(path.join(newJob, 'stop'), ''); },
  }));
  assert.equal((await readStatus(second)).state, 'cancelled');
  const result = await resumeRender(second);
  assert.deepEqual(result.data.resume, { segmentsReused: 1, framesReused: 4 });
  assert.equal(result.data.outputCheck.verified, true);
});

fullTest('killed renderer leaves a recoverable running job and stale segment lock', { timeout: 60000 }, async t => {
  const ready = path.join(root, 'crash-ready.json');
  const child = launch(process.execPath, ['tests/fixtures/crash-render.mjs', shot, jobs, path.join(root, 'crash.mp4'), ready]);
  t.after(() => stopOwned(child.child));
  let record;
  const deadline = performance.now() + 30000;
  while (!record && performance.now() < deadline) {
    record = await readFile(ready, 'utf8').then(JSON.parse).catch(() => null);
    if (!record) await delay(25);
  }
  assert.ok(record, child.stderr);
  await stopOwned(child.child);
  const directory = path.join(jobs, record.jobId);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'status.json'))).state, 'running');
  const status = await readStatus(directory);
  assert.equal(status.state, 'failed');
  assert.equal(status.resume.available, true);
  const resumed = await resumeRender(directory);
  assert.deepEqual(resumed.data.resume, { segmentsReused: 1, framesReused: 4 });
});

for (const format of ['webm', 'mov']) fullTest(`${format}: concatenated transparent segments pass final alpha checks`, { timeout: 120000 }, async () => {
  const transparent = path.join(root, 'transparent.html');
  await writeFile(transparent, (await readFile(shot, 'utf8')).replace('background:#abc', 'background:rgba(170,187,204,.35)'));
  const renderOptions = { ...options, alpha: true, format, out: path.join(root, 'alpha.' + format), to: 1 };
  const result = format === 'webm'
    ? await resumeRender(await interrupted(() => renderShot(transparent, { ...renderOptions, _segmentHook: stopAt('sealed', 0) })))
    : await renderShot(transparent, renderOptions);
  assert.equal(result.data.outputCheck.verified, true);
  assert.equal(result.data.outputCheck.frames, 8);
});

for (const encoder of ['nvenc-h264', 'nvenc-hevc']) fullTest(`${encoder}: segmented MP4 stream copy passes output checks`, { timeout: 60000 }, async t => {
  let result;
  try { result = await renderShot(shot, { ...options, encoder, to: 1, out: path.join(root, encoder + '.mp4') }); }
  catch (error) {
    if (error.code === 'ffmpeg_unusable' || /Cannot load|No capable devices|No NVENC capable|Driver does not support/.test(error.details?.stderr ?? '')) {
      t.skip('NVENC is unavailable on this host: ' + (error.details?.reason ?? error.details?.stderr)); return;
    }
    throw error;
  }
  assert.equal(result.data.outputCheck.verified, true);
  assert.equal(result.data.outputCheck.frames, 8);
});

fullTest('concatenation applies audio offset and from once, with correct video/audio duration', { timeout: 120000 }, async () => {
  const audio = path.join(root, 'sound.wav');
  const generated = await run(await resolveFFmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', audio]);
  assert.equal(generated.code, 0, generated.stderr);
  const result = await renderShot(shot, { ...options, fps: 29.97, _segmentFrames: 15,
    out: path.join(root, 'audio.mp4'), audio, from: 0.5, 'audio-offset': 0.25 });
  assert.equal(result.data.outputCheck.frames, 45);
  assert.ok(Math.abs(result.data.outputCheck.durationSeconds - 1.5015) < 1e-8);
  assert.ok(Math.abs(result.data.outputCheck.audioDurationSeconds - 1.5015) < 0.05);
});
