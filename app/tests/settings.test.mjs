import copy from '../src/shared/copy/en.mjs';
import { useShortTempDirectory } from '../../tests/short-path.mjs';
import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const renderer = fileURLToPath(new URL('../../', import.meta.url));
import { mkdir, readFile, writeFile, readdir, rm, symlink, lstat, unlink } from 'node:fs/promises';
import { Configuration, Skills, setupCommand, bundledCommand, parseDoctor, rendererRoot, pathVersion, readEnvironment } from '../src/main/settings.mjs';
import { userError } from '../src/shared/errors.mjs';
import { Preferences } from '../src/main/store.mjs';
import { JobStore, homeDirectory } from '../src/main/store.mjs';
async function fixture(t) {
  const root = createTempDirectory('multiplane-settings-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'SKILL.md'), 'v1');
  const user = path.join(root, 'user'); await mkdir(path.join(user, '.claude'), { recursive: true });
  return { root, source, user, env: { PATH: '' } };
}

test('default desktop adapter lets CLI migrate config and job index before the store reads', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const env = { ...process.env, MULTIPLANE_HOME: '', USERPROFILE: f.user, APPDATA: path.join(f.root, 'roaming') };
  const old = path.join(env.APPDATA, 'multiplane'); await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'config.json'), '{"workers":5}');
  const jobDir = path.join(f.root, 'job'); await mkdir(jobDir);
  const record = { schema: 'multiplane/1', event: 'start', jobId: 'migrated', jobDir, command: 'render', shot: 'example.html', ts: new Date().toISOString() };
  await writeFile(path.join(old, 'jobs.jsonl'), JSON.stringify(record) + '\n');
  await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ ...record, state: 'succeeded', startedAt: record.ts, result: { ok: true, artifacts: [] } }));
  const config = new Configuration(renderer, homeDirectory(env), env);
  assert.equal(config.env.MULTIPLANE_HOME, '');
  assert.equal((await config.read()).values.workers, 5);
  const store = new JobStore(homeDirectory(env)); t.after(() => store.close());
  await store.refresh(); assert.equal(store.jobs[0].jobId, 'migrated');
  await config.save('raster', 'software');
  assert.equal((await config.read()).values.workers, 5);
  assert.equal(await readFile(path.join(old, 'config.json'), 'utf8'), '{"workers":5}');
});
test('configuration adapter invokes the bundled CLI and retains concurrent settings', async t => {
  const f = await fixture(t), config = new Configuration(renderer, f.root, { ...process.env, MULTIPLANE_AGENT_HOME: f.user, MULTIPLANE_FFMPEG: '/env/ffmpeg', MULTIPLANE_JOBS_DIR: '/env/jobs' });
  await writeFile(config.file, JSON.stringify({ unknown: 1 }));
  await Promise.all([config.save('raster', 'software'), config.save('workers', 2)]);
  assert.equal((await config.read()).values.raster, 'software');
  assert.equal((await config.read()).values.workers, 2);
  assert.equal(JSON.parse(await readFile(config.file)).unknown, 1);
  assert.equal((await config.read()).overrides.ffmpeg, '/env/ffmpeg');
  for (const [key, value] of [['workers', 0], ['workers', 1.5], ['encoder', 'bogus'], ['unknown', null]]) await assert.rejects(config.save(key, value));
  await config.save('workers', null); assert.equal((await config.read()).values.workers, null);
});
test('software preferences roll back after failure and persist wizard separately', async t => {
  const f = await fixture(t), prefs = new Preferences(path.join(f.root, 'app'));
  await prefs.load(); assert.equal(prefs.value.wizardDone, false);
  await prefs.save({ wizardDone: true });
  await mkdir(prefs.file + '.tmp'); await assert.rejects(prefs.save({ theme: 'dark' }));
  assert.equal(prefs.value.theme, 'system');
  const reloaded = new Preferences(path.join(f.root, 'app')); await reloaded.load(); assert.equal(reloaded.value.wizardDone, true);
});
test('doctor accepts unsuccessful results with checks and rejects incomplete output', () => {
  const result = { schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, data: { checks: [{ name: 'ffmpeg', ok: false, detail: 'missing' }] } };
  assert.deepEqual(parseDoctor(JSON.stringify(result)+'\n'), result);
  const environment = { schema: 'multiplane/1', type: 'environment', ffmpeg: { path: '/tools/ffmpeg', version: 'ffmpeg version 9.0' } };
  assert.deepEqual(parseDoctor([environment, result].map(JSON.stringify).join('\n')).environment, environment);
  assert.throws(() => parseDoctor('{}\n'));
  assert.equal(rendererRoot(false, '/resources', '/project/app'), path.resolve('/project'));
  assert.equal(rendererRoot(true, '/resources', '/project/app'), path.join('/resources', 'renderer'));
});
test('npm command shim version is executed as an argument array without shell', async t => {
  const f = await fixture(t), script = path.join(f.root, 'version.cjs'), shim = path.join(f.root, 'multiplane.cmd');
  await writeFile(script, "console.log('1.2.3')"); await writeFile(shim, 'IF EXIST "%dp0%\\node.exe" (\nSET "_prog=%dp0%\\node.exe"\n)\n@"%_prog%" "%dp0%\\version.cjs" %*');
  assert.equal(await pathVersion(shim), '1.2.3');
});

test('agent and PATH failures remain local to their own environment cards', async t => {
  const f = await fixture(t), skills = new Skills(renderer, { ...process.env, MULTIPLANE_HOME: f.root, MULTIPLANE_AGENT_HOME: f.user });
  await writeFile(path.join(f.user, '.claude', 'skills'), 'not a directory');
  await skills.change('codex', 'install', null);
  const environment = await readEnvironment(skills, async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); });
  assert.match(environment.command.error, /Permission denied/);
  assert.equal(environment.skills[0].state, 'error'); assert.match(environment.skills[0].error, /not a directory/);
  assert.equal(environment.skills[1].state, 'latest');
  const healthyCommand = await readEnvironment(skills, async () => '/multiplane', async () => '1.0.0');
  assert.equal(healthyCommand.command.version, '1.0.0'); assert.equal(healthyCommand.skills[1].state, 'latest');
});

test('IPC errors have a bounded localized explanation without Electron wrappers or stacks', () => {
  assert.equal(userError(Error("Error invoking remote method 'environment': Error: 不支持符号链接安装目录")), '不支持符号链接安装目录');
  assert.match(userError("Error: Error invoking remote method 'open': Error: EACCES: access denied"), /^Permission denied.*EACCES/);
  assert.equal(userError(Error('Unknown failure\n    at private/path')), copy.checkError);
  assert.equal(userError(Error('安装状态已变化，请重新检查\nprivate/path')), copy.skillChanged);
});

test('skill adapter supplies expect and only passes force after caller confirmation', async t => {
  const f = await fixture(t), calls = [], env = { ...process.env, MULTIPLANE_HOME: f.root, MULTIPLANE_AGENT_HOME: f.user };
  const skills = new Skills(renderer, env, async (root, args, environment) => { calls.push(args); return bundledCommand(root, args, environment); });
  const missing = await skills.status('codex'); assert.equal(missing.state, 'missing');
  await skills.change('codex', 'install', missing.signature);
  const installed = await skills.status('codex'); assert.equal(installed.state, 'latest');
  await writeFile(path.join(installed.target, 'SKILL.md'), 'local changes');
  const modified = await skills.status('codex');
  await assert.rejects(skills.change('codex', 'install', modified.signature), { code: 'skill_modified' });
  const result = await skills.change('codex', 'install', modified.signature, true);
  assert.equal(await readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), 'local changes');
  await assert.rejects(skills.change('codex', 'remove', 'stale'), { code: 'skill_changed' });
  await skills.change('codex', 'remove', (await skills.status('codex')).signature);
  assert.equal((await skills.status('codex')).state, 'missing');
  assert.ok(calls.filter(args => ['install','remove'].includes(args[1])).every(args => args.includes('--expect')));
  assert.equal(calls.filter(args => args.includes('--force')).length, 1);
});
