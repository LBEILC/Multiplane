import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { JobStore } from '../src/main/store.mjs';
import { desktopDirectory, configureDesktopPaths, migratePreferences, singleInstance } from '../src/main/lifecycle.mjs';
import { existsSync } from 'node:fs';
import { createLogger } from '../src/main/log.mjs';
import { checkFfmpeg } from '../src/main/settings.mjs';
import { doctorCopy } from '../src/shared/doctor-copy.mjs';
import { setLanguage } from '../src/shared/i18n.mjs';
import { seedMixedJobs } from '../tools/mixed-jobs.mjs';
import { fileURLToPath } from 'node:url';

test('mixed historical jobs survive absent fields, deleted directories and invalid records without modifying input', async t => {
  const parent = fileURLToPath(new URL('../../out/037/tests/', import.meta.url)); await mkdir(parent, { recursive: true });
  const dir = createTempDirectory(path.join(parent, 'mixed-')), externalDirectory = createTempDirectory();
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(externalDirectory, { recursive: true, force: true }); });
  const home = path.join(dir, 'home'), expected = await seedMixedJobs(home, path.join(dir, 'jobs'), { externalDirectory });
  const index = await readFile(path.join(home, 'jobs.jsonl'));
  const faults = [], store = new JobStore(home); t.after(() => store.close()); store.on('fault', e => faults.push(e.message));
  await store.refresh();
  assert.deepEqual(store.jobs.map(j => j.jobId), expected);
  assert.equal(store.job('external').jobDir, externalDirectory);
  assert.equal(store.job('missing-fields').startedAt, '');
  assert.equal(store.job('missing-fields').result.artifacts.length, 1);
  assert.ok(faults.some(s => s.includes('startedAt')));
  assert.ok(faults.some(s => s.includes('Invalid job')));
  assert.deepEqual(await readFile(path.join(home, 'jobs.jsonl')), index);
  assert.doesNotThrow(() => store.jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
});

test('desktop paths ignore renderer home across all platforms', () => {
  assert.equal(desktopDirectory({ MULTIPLANE_HOME: '/render', XDG_CONFIG_HOME: '/config' }, 'linux', '/home/example'), '/config/multiplane/desktop');
  assert.equal(desktopDirectory({ MULTIPLANE_HOME: '/render' }, 'linux', '/home/example'), '/home/example/.config/multiplane/desktop');
  assert.equal(desktopDirectory({ MULTIPLANE_HOME: '/render' }, 'darwin', '/home/example'), '/home/example/Library/Application Support/multiplane/desktop');
  assert.equal(desktopDirectory({ MULTIPLANE_HOME: 'R:\\render', APPDATA: 'C:\\config' }, 'win32', 'C:\\profile'), 'C:\\profile\\.multiplane\\desktop');
});

test('an isolated desktop override creates both paths without consulting the real userData directory', async t => {
  const dir = createTempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = path.join(dir, 'new', 'desktop'), calls = [];
  const app = { getPath: () => { throw Error('Platform userData is unavailable'); }, setPath: (name, file) => { assert.equal(existsSync(file), true); calls.push([name, file]); } };
  assert.deepEqual(configureDesktopPaths(app, { MULTIPLANE_APP_DATA: directory }), { previous: null, directory });
  assert.deepEqual(calls, [['userData', directory], ['sessionData', directory]]);
});

test('Windows desktop selects the new profile directory and migrates 037 preferences before legacy fallback', { skip: process.platform !== 'win32' }, async t => {
  const dir = createTempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { USERPROFILE: path.join(dir, 'user'), APPDATA: path.join(dir, 'roaming') };
  const old = path.join(env.APPDATA, 'multiplane', 'desktop'), legacy = path.join(dir, 'legacy');
  await mkdir(old, { recursive: true }); await mkdir(legacy);
  await writeFile(path.join(old, 'preferences.json'), '{"wizardDone":true}');
  await writeFile(path.join(old, 'Cache'), 'keep');
  await writeFile(path.join(legacy, 'preferences.json'), '{"wizardDone":false}');
  const configured = configureDesktopPaths({ getPath: () => legacy, setPath() {} }, env);
  assert.equal(configured.directory, path.join(env.USERPROFILE, '.multiplane', 'desktop'));
  assert.equal(configured.previous, old);
  await migratePreferences(configured.previous, configured.directory);
  await migratePreferences(configured.legacy, configured.directory);
  assert.equal(await readFile(path.join(configured.directory, 'preferences.json'), 'utf8'), '{"wizardDone":true}');
  assert.equal(await readFile(path.join(old, 'Cache'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(legacy, 'preferences.json'), 'utf8'), '{"wizardDone":false}');
  const unavailable = configureDesktopPaths({ getPath() { throw Error('No legacy path'); }, setPath() {} }, env);
  assert.equal(unavailable.directory, configured.directory);
  assert.equal(unavailable.legacy, undefined);
});

test('migration moves only preferences and never replaces existing destination preferences', async t => {
  const dir = createTempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'desktop');
  await writeFile(path.join(dir, 'preferences.json'), '{"hidden":["old"]}');
  await writeFile(path.join(dir, 'Cache'), 'keep');
  await migratePreferences(dir, target);
  assert.equal(await readFile(path.join(target, 'preferences.json'), 'utf8'), '{"hidden":["old"]}');
  await assert.rejects(readFile(path.join(dir, 'preferences.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dir, 'Cache'), 'utf8'), 'keep');
  await writeFile(path.join(dir, 'preferences.json'), 'newer-source');
  await migratePreferences(dir, target);
  assert.equal(await readFile(path.join(target, 'preferences.json'), 'utf8'), '{"hidden":["old"]}');
  assert.equal(await readFile(path.join(dir, 'preferences.json'), 'utf8'), 'newer-source');
});

test('single instance exits the contender and restores the owner for second-instance and macOS activate', () => {
  const app = new EventEmitter(), actions = [];
  app.requestSingleInstanceLock = () => false; app.quit = () => actions.push('quit');
  assert.equal(singleInstance(app, () => { throw Error('No window in contender'); }), false);
  assert.deepEqual(actions, ['quit']); actions.length = 0;
  app.requestSingleInstanceLock = () => true;
  let window;
  assert.equal(singleInstance(app, () => window), true); app.emit('second-instance');
  window = { isDestroyed: () => false, isMinimized: () => true, restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') };
  app.emit('second-instance'); app.emit('activate');
  assert.deepEqual(actions, ['restore', 'show', 'focus', 'restore', 'show', 'focus']);
});

test('main and renderer faults persist in a bounded desktop log with duplicate suppression', async t => {
  const dir = createTempDirectory(); t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createLogger(dir); log('jobs', 'bad'); log('jobs', 'bad'); log('renderer', 'bad row');
  const file = path.join(dir, 'logs/desktop.log');
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1)); log('jobs', 'next');
  assert.match(await readFile(file, 'utf8'), /next/);
  assert.equal((await readFile(file + '.1')).length, 2 * 1024 * 1024 + 1);
});

test('FFmpeg validation checks the saved path rather than an environment override and reports precise failures', async () => {
  let command;
  const valid = await checkFfmpeg('selected-ffmpeg', { MULTIPLANE_FFMPEG: 'override' }, async (...args) => { command = args; return { code: 0, stdout: 'ffmpeg version 9.0\nmore' }; });
  assert.equal(command[0], 'selected-ffmpeg'); assert.deepEqual(command[1], ['-version']);
  assert.equal(valid.detail, 'ffmpeg version 9.0'); assert.equal(valid.ok, true);
  assert.equal((await checkFfmpeg('missing', {}, async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); })).reason, 'not-found');
  assert.equal((await checkFfmpeg('denied', {}, async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); })).diagnostic, 'EACCES');
  assert.equal((await checkFfmpeg('invalid', {}, async () => ({ code: 2, stdout: '' }))).reason, 'cannot-run');
  assert.equal((await checkFfmpeg('other', {}, async () => ({ code: 0, stdout: 'other program' }))).reason, 'not-ffmpeg');
});

test('doctor copy localizes every known check and retains unknown checks or states', () => {
  for (const locale of ['en', 'zh-CN']) {
    setLanguage(locale);
    for (const name of ['node', 'browser', 'gpu', 'ffmpeg', 'libx264', 'libvpx-vp9', 'prores_ks', 'three']) for (const ok of [true, false]) {
      const result = doctorCopy({ name, ok, detail: '' });
      assert.ok(result.status); assert.ok(result.explanation); assert.doesNotMatch(result.explanation, /--ffmpeg|PATH|MULTIPLANE/);
    }
    assert.equal(doctorCopy({ name: 'ffmpeg', ok: true, detail: 'ffmpeg version 9.0' }).data, 'ffmpeg version 9.0');
    assert.equal(doctorCopy({ name: 'gpu', ok: true, detail: 'GPU renderer: Example GPU.' }).data, 'Example GPU');
    for (const check of [{ name: 'future', ok: true }, { name: 'node', ok: 'unknown' }, { name: 'node', ok: true, status: 'future' }]) assert.deepEqual(doctorCopy({ ...check, detail: 'raw detail', hint: 'raw hint' }), { raw: 'raw detail', hint: 'raw hint' });
  }
  setLanguage('en');
});
