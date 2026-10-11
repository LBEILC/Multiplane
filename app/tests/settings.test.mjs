import { useShortTempDirectory } from '../../tests/short-path.mjs';
import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm, symlink, lstat, unlink } from 'node:fs/promises';
import { Configuration, Skills, parseDoctor, rendererRoot, pathVersion, readEnvironment } from '../src/main/settings.mjs';
import { userError } from '../src/shared/errors.mjs';
import { Preferences } from '../src/main/store.mjs';
async function fixture(t) {
  const root = createTempDirectory('multiplane-settings-');
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

const linkDirectory = (target, link) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
for (const shortTemp of [false, true]) for (const host of ['claude', 'codex']) for (const level of ['user', 'agent', 'skills']) test(`${host}: linked ${level} ancestor supports install, update, backup and removal in the real root${shortTemp ? ' with a real 8.3 system temp path' : ''}`, { skip: shortTemp && process.platform !== 'win32' }, async t => {
  if (shortTemp && !await useShortTempDirectory(t)) return;
  const f = await fixture(t), physical = path.join(f.root, 'physical'); await mkdir(physical);
  const agent = host === 'claude' ? '.claude' : '.agents';
  await mkdir(path.join(f.user, agent), { recursive: true });
  const link = level === 'user' ? f.user : level === 'agent' ? path.join(f.user, agent) : path.join(f.user, agent, 'skills');
  if (level !== 'skills') await rm(link, { recursive: true });
  await linkDirectory(physical, link);
  const skills = new Skills(f.source, '1.0.0', f), expectedRoot = level === 'user' ? path.join(physical, agent, 'skills') : level === 'agent' ? path.join(physical, 'skills') : physical;
  await skills.change(host, 'install', null);
  const installed = await skills.status(host);
  assert.equal(installed.target, path.join(expectedRoot, 'multiplane')); assert.equal(installed.state, 'latest');
  await writeFile(path.join(f.source, 'SKILL.md'), 'v2');
  const newer = new Skills(f.source, '2.0.0', f), previous = await newer.status(host); assert.equal(previous.state, 'update');
  await newer.change(host, 'install', previous.signature);
  await writeFile(path.join(installed.target, 'SKILL.md'), 'user edit');
  const updated = await newer.change(host, 'install', (await newer.status(host)).signature);
  assert.equal(path.dirname(updated.backup), expectedRoot); assert.equal(await readFile(path.join(updated.backup, 'SKILL.md'), 'utf8'), 'user edit');
  await writeFile(path.join(installed.target, 'custom'), 'keep');
  const removed = await newer.change(host, 'remove', (await newer.status(host)).signature);
  assert.equal(path.dirname(removed.backup), expectedRoot); assert.equal(await readFile(path.join(removed.backup, 'custom'), 'utf8'), 'keep');
  await newer.change(host, 'install', null);
  await newer.change(host, 'remove', (await newer.status(host)).signature);
  assert.equal((await newer.status(host)).state, 'missing');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

for (const inside of [false, true]) test(`a ${inside ? 'nested' : 'target'} skill link is blocked without touching the linked directory`, async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f), outside = path.join(f.root, 'external');
  await mkdir(outside); await writeFile(path.join(outside, 'keep'), 'untouched');
  const target = skills.target('claude'); await mkdir(path.dirname(target), { recursive: true });
  if (inside) await mkdir(target);
  const link = inside ? path.join(target, 'nested') : target;
  await linkDirectory(outside, link);
  const status = await skills.status('claude');
  assert.equal(status.state, 'modified'); assert.equal(status.blocked, true); assert.match(status.error, /符号链接/);
  for (const action of ['install', 'remove']) await assert.rejects(skills.change('claude', action, status.signature), /符号链接/);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await unlink(link);
});

test('agent and PATH failures remain local to their own environment cards', async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f);
  await writeFile(path.join(f.user, '.claude', 'skills'), 'not a directory');
  await skills.change('codex', 'install', null);
  const environment = await readEnvironment(skills, async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); });
  assert.match(environment.command.error, /没有权限/);
  assert.equal(environment.skills[0].state, 'error'); assert.match(environment.skills[0].error, /不是目录/);
  assert.equal(environment.skills[1].state, 'latest');
  const healthyCommand = await readEnvironment(skills, async () => '/multiplane', async () => '1.0.0');
  assert.equal(healthyCommand.command.version, '1.0.0'); assert.equal(healthyCommand.skills[1].state, 'latest');
});

test('IPC errors have a bounded Chinese explanation without Electron wrappers or stacks', () => {
  assert.equal(userError(Error("Error invoking remote method 'environment': Error: 不支持符号链接安装目录")), '不支持符号链接安装目录');
  assert.match(userError("Error: Error invoking remote method 'open': Error: EACCES: access denied"), /^没有权限.*EACCES/);
  assert.equal(userError(Error('Unknown failure\n    at private/path')), '操作失败，请重新检查');
  assert.equal(userError(Error('安装状态已变化，请重新检查\nprivate/path')), '安装状态已变化，请重新检查');
});
