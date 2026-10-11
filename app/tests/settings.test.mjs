import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { Configuration, Skills, parseDoctor, rendererRoot, pathVersion } from '../src/main/settings.mjs';
import { Preferences } from '../src/main/store.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-settings-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'SKILL.md'), 'v1');
  const user = path.join(root, 'user'); await mkdir(path.join(user, '.claude'), { recursive: true });
  return { root, source, user, env: { PATH: '' } };
}
test('configuration is atomic, validates values, retains unknown fields and reports environment overrides', async t => {
  const f = await fixture(t), config = new Configuration(f.root, { MULTIPLANE_FFMPEG: '/env/ffmpeg', MULTIPLANE_JOBS_DIR: '/env/jobs' });
  await writeFile(config.file, JSON.stringify({ unknown: 1 }));
  await Promise.all([config.save('raster', 'software'), config.save('workers', 2)]);
  assert.deepEqual((await config.read()).values, { unknown: 1, schema: 'multiplane/1', raster: 'software', workers: 2 });
  assert.equal((await config.read()).overrides.ffmpeg, '/env/ffmpeg');
  assert.equal((await config.read()).overrides.jobsDir, '/env/jobs');
  for (const [key, value] of [['workers', 0], ['workers', 1.5], ['encoder', 'bogus'], ['unknown', null]]) await assert.rejects(config.save(key, value));
  const original = await readFile(config.file, 'utf8');
  await mkdir(config.file + '.tmp'); await assert.rejects(config.save('workers', 3));
  assert.equal(await readFile(config.file, 'utf8'), original);
  await rm(config.file + '.tmp', { recursive: true });
  await config.save('workers', null); assert.equal((await config.read()).values.workers, null);
  for (const [key, value] of [['encoder', 'nvenc-h264'], ['encoder', 'nvenc-hevc'], ['jobsDir', '/custom/jobs'], ['jobsDir', null]]) {
    await config.save(key, value); assert.equal((await config.read()).values[key], value);
  }
});
test('software preferences roll back after failure and persist wizard separately', async t => {
  const f = await fixture(t), prefs = new Preferences(path.join(f.root, 'app'));
  await prefs.load(); assert.equal(prefs.value.wizardDone, false);
  await prefs.save({ wizardDone: true });
  await mkdir(prefs.file + '.tmp'); await assert.rejects(prefs.save({ theme: 'dark' }));
  assert.equal(prefs.value.theme, 'system');
  const reloaded = new Preferences(path.join(f.root, 'app')); await reloaded.load(); assert.equal(reloaded.value.wizardDone, true);
});
test('skills install, update across known releases, detect modifications, back up and remove', async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f);
  assert.equal(skills.target('codex'), path.join(f.user, '.agents', 'skills', 'multiplane'));
  assert.equal((await skills.status('claude')).state, 'missing');
  await skills.change('claude', 'install', null);
  assert.equal((await skills.status('claude')).state, 'latest');
  await writeFile(path.join(f.source, 'SKILL.md'), 'v2');
  const v2 = new Skills(f.source, '2.0.0', f), before = await v2.status('claude'); assert.equal(before.state, 'update');
  await v2.change('claude', 'install', before.signature);
  const record = JSON.parse(await readFile(path.join(v2.target('claude'), '.multiplane.json'), 'utf8')); assert.equal(record.releases.length, 2);
  await writeFile(path.join(v2.target('claude'), 'SKILL.md'), 'user changes');
  const modified = await v2.status('claude'); assert.equal(modified.state, 'modified');
  await assert.rejects(v2.change('claude', 'install', before.signature));
  const backupName = await v2.backupName('claude');
  await assert.rejects(v2.change('claude', 'install', modified.signature, '../unsafe'));
  const replaced = await v2.change('claude', 'install', modified.signature, backupName);
  assert.equal(path.basename(replaced.backup), backupName);
  assert.match(path.basename(replaced.backup), /^multiplane\.bak-/); assert.equal(await readFile(path.join(replaced.backup, 'SKILL.md'), 'utf8'), 'user changes');
  await writeFile(path.join(v2.target('claude'), 'extra.md'), 'extra');
  await writeFile(path.join(v2.target('claude'), '__proto__'), 'extra');
  const removed = await v2.change('claude', 'remove', (await v2.status('claude')).signature);
  assert.equal(await readFile(path.join(removed.backup, 'extra.md'), 'utf8'), 'extra');
  assert.equal((await v2.status('claude')).state, 'missing');
  await v2.change('codex', 'install', null);
  await v2.change('codex', 'remove', (await v2.status('codex')).signature);
  assert.equal((await readdir(path.dirname(v2.target('codex')))).length, 0);
});
test('corrupt installation records are treated conservatively without losing user files', async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f);
  await skills.change('claude', 'install', null);
  await writeFile(path.join(skills.target('claude'), 'SKILL.md'), 'custom');
  await writeFile(path.join(skills.target('claude'), '.multiplane.json'), JSON.stringify({ v: 1, host: 'claude', skill: 'multiplane', releases: {} }));
  const status = await skills.status('claude'); assert.equal(status.state, 'modified');
  const result = await skills.change('claude', 'install', status.signature);
  assert.equal(await readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), 'custom');
});
test('backup names use local calendar time and numbered collisions', async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f);
  const date = new Date(2026, 0, 2, 3, 4, 5);
  const base = 'multiplane.bak-20260102-030405';
  assert.equal(await skills.backupName('claude', date), base);
  const parent = path.dirname(skills.target('claude'));
  await mkdir(path.join(parent, base), { recursive: true });
  assert.equal(await skills.backupName('claude', date), base + '-2');
  await mkdir(path.join(parent, base + '-2'));
  assert.equal(await skills.backupName('claude', date), base + '-3');
});
test('doctor accepts unsuccessful results with checks and rejects incomplete output', () => {
  const result = { schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, data: { checks: [{ name: 'ffmpeg', ok: false, detail: 'missing' }] } };
  assert.deepEqual(parseDoctor(JSON.stringify(result)+'\n'), result);
  assert.throws(() => parseDoctor('{}\n'));
  assert.equal(rendererRoot(false, '/resources', '/project/app'), path.resolve('/project'));
  assert.equal(rendererRoot(true, '/resources', '/project/app'), path.join('/resources', 'renderer'));
});
test('npm command shim version is executed as an argument array without shell', async t => {
  const f = await fixture(t), script = path.join(f.root, 'version.cjs'), shim = path.join(f.root, 'multiplane.cmd');
  await writeFile(script, "console.log('1.2.3')"); await writeFile(shim, 'IF EXIST "%dp0%\\node.exe" (\nSET "_prog=%dp0%\\node.exe"\n)\n@"%_prog%" "%dp0%\\version.cjs" %*');
  assert.equal(await pathVersion(shim), '1.2.3');
});
