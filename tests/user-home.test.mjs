import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { userHome } from '../src/platform.mjs';
import { loadUserConfig, appendJobIndex } from '../src/user-home.mjs';
import { renderShot } from '../src/render.mjs';
import { createPreview } from '../src/preview.mjs';
import { scanShot } from '../src/lint.mjs';
import { decodePNG } from '../src/png.mjs';
import { run, createTempDirectory } from './helpers.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';

const directory = createTempDirectory(path.resolve('out/tests/user-home-'));
const home = process.env.MULTIPLANE_HOME;
const readLines = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const cli = async (args, env = {}) => {
  const result = await run(process.execPath, ['bin/multiplane', ...args, '--json'], { env: { ...process.env, ...env } });
  return { ...result, events: result.stdout.trim().split('\n').map(JSON.parse) };
};

test('platform paths and explicit home override', () => {
  assert.equal(userHome({ APPDATA: 'C:\\profile\\Roaming' }, 'win32', 'C:\\profile'), 'C:\\profile\\Roaming\\multiplane');
  assert.equal(userHome({}, 'win32', 'C:\\profile'), 'C:\\profile\\AppData\\Roaming\\multiplane');
  assert.equal(userHome({}, 'darwin', '/users/test'), '/users/test/Library/Application Support/multiplane');
  assert.equal(userHome({}, 'linux', '/users/test'), '/users/test/.config/multiplane');
  assert.equal(userHome({ XDG_CONFIG_HOME: '/config' }, 'linux', '/users/test'), '/config/multiplane');
  assert.equal(userHome({ MULTIPLANE_HOME: '/override' }, 'linux', '/users/test'), '/override');
});

test('configuration validates fields and merges explicit > environment > config > defaults', async () => {
  const file = path.join(home, 'config.json');
  await writeFile(file, JSON.stringify({ schema: 'multiplane/1', ffmpeg: 'config-ffmpeg', jobsDir: directory, raster: 'software', encoder: 'x264', workers: 3, unknown: 7 }));
  const env = { MULTIPLANE_HOME: home };
  const configured = loadUserConfig('render', {}, env);
  assert.equal(configured.options.workers, 3);
  assert.deepEqual(configured.config.applied, ['ffmpeg', 'jobsDir', 'raster', 'encoder', 'workers']);
  assert.equal(loadUserConfig('render', {}, { ...env, MULTIPLANE_FFMPEG: 'env-ffmpeg' }).options.ffmpeg, 'env-ffmpeg');
  const explicit = loadUserConfig('render', { ffmpeg: 'cli-ffmpeg', 'job-dir': home, workers: 1 }, { ...env, MULTIPLANE_FFMPEG: 'env-ffmpeg', MULTIPLANE_JOBS_DIR: '/env-jobs' });
  assert.equal(explicit.options.ffmpeg, 'cli-ffmpeg'); assert.equal(explicit.options['job-dir'], home);
  assert.deepEqual(explicit.config.applied, ['raster', 'encoder']);
  await writeFile(file, JSON.stringify({ schema: 'wrong', workers: 1.5, raster: 'bad', encoder: false, ffmpeg: [], jobsDir: 2 }));
  assert.deepEqual(loadUserConfig('render', {}, env).warnings.map(w => w.details.field), ['schema', 'ffmpeg', 'jobsDir', 'raster', 'encoder', 'workers']);
  await writeFile(file, '{');
  assert.equal(loadUserConfig('render', {}, env).warnings[0].code, 'config_invalid');
  await writeFile(file, JSON.stringify({ workers: null, ffmpeg: null, raster: null }));
  assert.deepEqual(loadUserConfig('render', {}, env).options, {});
  await writeFile(file, JSON.stringify({ raster: 'software', workers: 0 }));
  const doctor = await cli(['doctor']);
  assert.equal(doctor.code, 0, doctor.stderr + doctor.stdout);
  assert.equal(doctor.events[0].options.raster, 'software');
  assert.deepEqual(doctor.events.at(-1).data.config, { path: file, exists: true, applied: ['raster'] });
  assert.ok(doctor.events.some(e => e.code === 'config_invalid' && e.details.field === 'workers'));
  await writeFile(file, '{}');
  const unreadable = path.join(directory, 'config-is-directory');
  await mkdir(path.join(unreadable, 'config.json'), { recursive: true });
  const failedRead = loadUserConfig('doctor', {}, { MULTIPLANE_HOME: unreadable });
  assert.equal(failedRead.config.exists, true);
  assert.equal(failedRead.warnings[0].code, 'home_unavailable');
});

test('CLI start reflects all configuration precedence levels and default values', async () => {
  const configHome = path.join(directory, 'precedence'); await mkdir(configHome);
  const configJobs = path.join(directory, 'config-jobs'), envJobs = path.join(directory, 'env-jobs'), cliJobs = path.join(directory, 'cli-jobs');
  await writeFile(path.join(configHome, 'config.json'), JSON.stringify({ ffmpeg: 'config-ffmpeg', jobsDir: configJobs, raster: 'software', workers: 3, encoder: 'nvenc-h264' }));
  const args = ['render', 'examples/absent.html'];
  let result = await cli(args, { MULTIPLANE_HOME: configHome, MULTIPLANE_FFMPEG: undefined });
  assert.equal(result.events[0].options.ffmpeg, 'config-ffmpeg'); assert.equal(result.events[0].options['job-dir'], configJobs);
  assert.equal(result.events[0].options.workers, 3); assert.equal(result.events[0].options.encoder, 'nvenc-h264');
  const status = await cli(['status', result.events[0].jobId], { MULTIPLANE_HOME: configHome });
  assert.equal(status.code, 0, status.stdout); assert.equal(status.events.at(-1).data.state, 'failed');
  result = await cli(args, { MULTIPLANE_HOME: configHome, MULTIPLANE_FFMPEG: 'env-ffmpeg', MULTIPLANE_JOBS_DIR: envJobs });
  assert.equal(result.events[0].options.ffmpeg, 'env-ffmpeg'); assert.equal(result.events[0].options['job-dir'], envJobs);
  result = await cli([...args, '--ffmpeg', 'cli-ffmpeg', '--job-dir', cliJobs, '--workers', '1', '--raster', 'gpu', '--encoder', 'x264'], { MULTIPLANE_HOME: configHome, MULTIPLANE_FFMPEG: 'env-ffmpeg', MULTIPLANE_JOBS_DIR: envJobs });
  assert.equal(result.events[0].options.ffmpeg, 'cli-ffmpeg'); assert.equal(result.events[0].options['job-dir'], cliJobs);
  assert.equal(result.events[0].options.workers, 1); assert.equal(result.events[0].options.raster, 'gpu'); assert.equal(result.events[0].options.encoder, 'x264');
  await writeFile(path.join(configHome, 'config.json'), '{}');
  result = await cli([...args, '--job-dir', cliJobs], { MULTIPLANE_HOME: configHome, MULTIPLANE_FFMPEG: undefined });
  assert.equal(result.events[0].options.ffmpeg, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'); assert.equal(result.events[0].options.raster, 'gpu'); assert.equal(result.events[0].options.encoder, 'x264');
});

test('concurrent processes append complete lines and serialize rotation', async () => {
  const indexHome = path.join(directory, 'concurrent');
  const module = new URL('../src/user-home.mjs', import.meta.url).href;
  const script = `import {appendJobIndex} from ${JSON.stringify(module)}; for(let i=0;i<40;i++) appendJobIndex(process.argv[1], {pid:process.pid,i,payload:'x'.repeat(500)});`;
  const results = await Promise.all(Array.from({ length: 5 }, () => run(process.execPath, ['--input-type=module', '-e', script, indexHome])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const rows = await readLines(path.join(indexHome, 'jobs.jsonl'));
  assert.equal(rows.length, 200); assert.equal(new Set(rows.map(r => `${r.pid}:${r.i}`)).size, 200);
  const rotation = path.join(directory, 'rotation');
  for (let i = 0; i < 3; i++) appendJobIndex(rotation, { i }, { limit: 1 });
  assert.deepEqual(await readLines(path.join(rotation, 'jobs.1.jsonl')), [{ i: 1 }]);
  assert.deepEqual(await readLines(path.join(rotation, 'jobs.jsonl')), [{ i: 2 }]);
  const rotatingScript = script.replace('appendJobIndex(process.argv[1], {pid:process.pid,i,payload:\'x\'.repeat(500)})', 'appendJobIndex(process.argv[1], {pid:process.pid,i,payload:\'x\'.repeat(500)}, {limit:2000})');
  for (const result of await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e', rotatingScript, rotation])))) assert.equal(result.code, 0, result.stderr);
  for (const name of ['jobs.jsonl', 'jobs.1.jsonl']) assert.ok((await readLines(path.join(rotation, name))).length);
});

test('preview throttles publication, preserves pixels, and handles failed side output', async () => {
  let now = 0; const frames = [];
  const previewDir = path.join(directory, 'preview'); await mkdir(previewDir);
  const pixels = Buffer.alloc(960 * 540 * 4, 127), original = Buffer.from(pixels);
  const preview = createPreview({ directory: previewDir, preview: f => frames.push(f) }, 960, 540, { now: () => now });
  await preview(pixels, 12); now = 1999; await preview(pixels, 13); now = 2000; await preview(pixels, 14);
  assert.deepEqual(frames, [12, 14]); assert.deepEqual(pixels, original);
  const png = decodePNG(await readFile(path.join(previewDir, 'preview.png')));
  assert.equal(png.width, 480); assert.equal(png.height, 270);
  const warnings = [];
  const failed = createPreview({ directory: path.join(directory, 'absent'), preview() { assert.fail(); }, warning: e => warnings.push(e) }, 960, 540);
  await failed(pixels, 0); await failed(pixels, 1);
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'preview_failed');
});

test('index reclaims dead and expired owners but preserves a live recent lock', async () => {
  const dir = path.join(directory, 'stale-lock'); await mkdir(dir);
  const lock = path.join(dir, 'jobs.lock');
  await writeFile(lock, JSON.stringify({ pid: 2147483647, ts: new Date().toISOString() }));
  appendJobIndex(dir, { i: 1 });
  await writeFile(lock, JSON.stringify({ pid: process.pid, ts: new Date(Date.now() - 11000).toISOString() }));
  const old = new Date(Date.now() - 11000); await utimes(lock, old, old);
  appendJobIndex(dir, { i: 2 });
  await writeFile(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  assert.throws(() => appendJobIndex(dir, { i: 3 }, { timeout: 20 }), { code: 'EEXIST' });
  assert.deepEqual(await readLines(path.join(dir, 'jobs.jsonl')), [{ i: 1 }, { i: 2 }]);
});

test('lint incomplete locates JS and CSS fragment starts and reports parser reasons', async () => {
  const file = path.join(directory, 'broken.html');
  await writeFile(file, '<style>bad {</style>\n<script>const = ;</script>');
  const { findings } = await scanShot(file);
  const incomplete = findings.filter(f => f.code === 'lint_incomplete');
  assert.equal(incomplete.length, 2);
  assert.deepEqual(incomplete.map(f => [f.location.line, f.location.column]), [[1, 8], [2, 9]]);
  for (const finding of incomplete) { assert.equal(finding.severity, 'warning'); assert.ok(finding.details.reason); assert.ok(!finding.details.reason.includes('\n')); }
  assert.match(incomplete[0].message, /CSS/); assert.match(incomplete[1].message, /JavaScript/);
});

test('render indexes, previews and identical encoded pixels with overhead evidence', { timeout: 120000 }, async () => {
  const runs = [], hashes = [];
  for (const enabled of [false, true, true, false]) {
    const events = [];
    const result = await renderShot('examples/animation.html', { workers: 1, 'job-dir': directory, _preview: enabled, onEvent: e => events.push(e) });
    const job = path.join(directory, result.jobId), snapshot = JSON.parse(await readFile(path.join(job, 'status.json')));
    assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'result');
    if (enabled) {
      const preview = decodePNG(await readFile(path.join(job, 'preview.png')));
      assert.equal(preview.width, 480); assert.equal(preview.height, 270);
      assert.ok(Number.isInteger(snapshot.previewFrame) && snapshot.previewFrame >= 0 && snapshot.previewFrame < result.data.frames);
    } else { assert.equal(snapshot.previewFrame, null); await assert.rejects(stat(path.join(job, 'preview.png')), { code: 'ENOENT' }); }
    const decode = await run(await resolveFFmpeg(), ['-v', 'error', '-i', result.data.output, '-f', 'framemd5', '-']);
    assert.equal(decode.code, 0, decode.stderr); hashes.push(decode.stdout);
    runs.push({ preview: enabled, elapsedMs: result.elapsedMs, frames: result.data.frames, previewFrame: snapshot.previewFrame });
    const rows = (await readLines(path.join(home, 'jobs.jsonl'))).filter(r => r.jobId === result.jobId);
    assert.deepEqual(rows.map(r => r.event), ['start', 'end']); assert.equal(rows[1].state, 'succeeded');
    assert.ok((await stat(rows[0].jobDir)).isDirectory());
  }
  for (const hash of hashes) assert.equal(hash, hashes[0]);
  const evidence = { runs, identicalDecodedFrames: true };
  await writeFile(path.join(directory, 'preview-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('Preview evidence:', JSON.stringify(evidence));
});

test('disabled and unavailable home do not prevent render; failed jobs have terminal index', { timeout: 60000 }, async () => {
  const noIndex = path.join(directory, 'no-index');
  let result = await cli(['render', 'examples/animation.html', '--to', '0.1', '--workers', '1', '--job-dir', directory], { MULTIPLANE_HOME: noIndex, MULTIPLANE_NO_INDEX: '1' });
  assert.equal(result.code, 0, result.stdout); await assert.rejects(stat(noIndex), { code: 'ENOENT' });
  const blocked = path.join(directory, 'not-a-directory'); await writeFile(blocked, 'blocked');
  result = await cli(['render', 'examples/animation.html', '--to', '0.1', '--workers', '1', '--job-dir', directory], { MULTIPLANE_HOME: blocked });
  assert.equal(result.code, 0, result.stdout); assert.equal(result.events.filter(e => e.code === 'home_unavailable').length, 1);
  result = await cli(['render', 'examples/absent.html', '--job-dir', directory]);
  assert.equal(result.events.at(-1).code, 'shot_not_found');
  const rows = (await readLines(path.join(home, 'jobs.jsonl'))).filter(r => r.jobId === result.events[0].jobId);
  assert.deepEqual(rows.map(r => r.event), ['start', 'end']); assert.equal(rows[1].state, 'failed');
});
