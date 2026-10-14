import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { createTempDirectory, run } from './helpers.mjs';
import { Configuration, probeFfmpeg } from '../src/config.mjs';
import { userHome } from '../src/platform.mjs';
import { Skills } from '../src/skills.mjs';

const cli = fileURLToPath(new URL('../bin/multiplane', import.meta.url));
async function fixture(t) {
  const root = createTempDirectory('multiplane-setup-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, MULTIPLANE_HOME: path.join(root, 'home'), MULTIPLANE_AGENT_HOME: path.join(root, 'agents') };
  delete env.MULTIPLANE_FFMPEG; delete env.MULTIPLANE_JOBS_DIR;
  async function command(...args) {
    assert.ok(env.MULTIPLANE_HOME && env.MULTIPLANE_AGENT_HOME);
    const output = await run(process.execPath, [cli, ...args, '--json'], { cwd: root, env });
    const events = output.stdout.trim().split('\n').map(JSON.parse), result = events.at(-1);
    assert.equal(events[0].type, 'start'); assert.equal(result.type, 'result');
    assert.equal(events.filter(e => e.type === 'result').length, 1);
    assert.equal(result.command, args[0]); assert.equal(result.jobId, undefined);
    assert.equal(result.ok, output.code === 0);
    return { ...output, events, result, data: result.data };
  }
  return { root, env, command, file: path.join(env.MULTIPLANE_HOME, 'config.json') };
}

test('config CLI validates every key, resolves paths, reports overrides and creates no jobs', async t => {
  const f = await fixture(t);
  const initial = await f.command('config', 'get');
  assert.equal(initial.data.exists, false);
  assert.deepEqual(initial.data.values, { ffmpeg: null, raster: null, encoder: null, workers: null, jobsDir: null, hosted: null });
  const values = [['raster', 'gpu'], ['raster', 'software'], ['encoder', 'x264'], ['encoder', 'nvenc-h264'], ['encoder', 'nvenc-hevc'], ['workers', '3'], ['jobsDir', 'space directory'], ['ffmpeg', 'missing ffmpeg']];
  for (const [key, value] of values) {
    const saved = await f.command('config', 'set', key, value);
    assert.equal(saved.code, 0); assert.equal(saved.data.changed, key);
    assert.equal(saved.data.values[key], ['ffmpeg', 'jobsDir'].includes(key) ? path.resolve(f.root, value) : key === 'workers' ? Number(value) : value);
    assert.deepEqual(Object.keys((await f.command('config', 'get', key)).data.values), [key]);
  }
  const original = await readFile(f.file, 'utf8');
  for (const [key, value] of [['ffmpeg', ''], ['jobsDir', ' '], ['raster', 'auto'], ['encoder', 'vp9'], ['workers', '0'], ['workers', '-1'], ['workers', '1.5'], ['workers', '9007199254740992'], ['unknown', 'anything']]) {
    const invalid = await f.command('config', 'set', key, value);
    assert.equal(invalid.code, 2); assert.equal(invalid.result.code, 'invalid_option');
    assert.equal(await readFile(f.file, 'utf8'), original);
  }
  for (const args of [['get','unknown'],['unset','unknown'],['set','workers'],['get','workers','extra'],['get','--force'],['get','--json']]) assert.equal((await f.command('config', ...args)).code, 2);
  await f.command('config', 'set', 'workers', 'auto');
  assert.equal((await f.command('config', 'get', 'workers')).data.values.workers, null);
  for (const key of ['ffmpeg', 'jobsDir', 'workers', 'raster', 'encoder']) assert.equal((await f.command('config', 'unset', key)).data.values[key], null);
  f.env.MULTIPLANE_FFMPEG = '/override'; f.env.MULTIPLANE_JOBS_DIR = '/jobs';
  assert.deepEqual((await f.command('config','get')).data.overrides, { ffmpeg: '/override', jobsDir: '/jobs' });
  assert.deepEqual(await readdir(f.env.MULTIPLANE_HOME), ['config.json']);
});

test('config refuses corrupt documents, preserves unknown fields and serializes separate CLI processes', async t => {
  const f = await fixture(t); await mkdir(f.env.MULTIPLANE_HOME);
  for (const text of ['{broken', 'null', '[]', '"text"', '3']) {
    await writeFile(f.file, text);
    for (const args of [['get'], ['set', 'workers', '2'], ['unset', 'workers']]) {
      const result = await f.command('config', ...args);
      assert.equal(result.result.code, 'config_invalid'); assert.equal(result.code, 3);
      assert.equal(result.result.details.path, f.file); assert.match(result.result.hint, /Repair or delete/);
      assert.equal(await readFile(f.file, 'utf8'), text);
    }
  }
  await writeFile(f.file, JSON.stringify({ future: { nested: [1, 'keep'] } }));
  const results = await Promise.all([f.command('config','set','workers','4'), f.command('config','set','raster','software'), f.command('config','set','encoder','nvenc-h264')]);
  assert.ok(results.every(r => r.code === 0));
  assert.deepEqual(JSON.parse(await readFile(f.file)), { schema: 'multiplane/1', future: { nested: [1,'keep'] }, workers: 4, raster: 'software', encoder: 'nvenc-h264' });
});

test('saved FFmpeg is inspected even when the environment overrides it', async t => {
  const f = await fixture(t); f.env.MULTIPLANE_FFMPEG = process.execPath;
  const missing = await f.command('config','set','ffmpeg','absent');
  assert.equal(missing.code, 0); assert.equal(missing.data.check.reason, 'not-found');
  assert.deepEqual(missing.data.check.encoders, { libx264: false, 'libvpx-vp9': false, prores_ks: false });
  assert.equal(missing.events[1].code, 'ffmpeg_unusable');
  const other = await f.command('config','set','ffmpeg',process.execPath);
  assert.equal(other.data.check.usable, false);
  if (process.env.MULTIPLANE_FFMPEG) {
    const valid = await f.command('config','set','ffmpeg',process.env.MULTIPLANE_FFMPEG);
    assert.equal(valid.code, 0); assert.equal(valid.data.check.usable, true); assert.match(valid.data.check.version, /^ffmpeg version/);
    assert.equal(valid.events.length, 2);
  }
});

test('skill CLI protects edits and expected signatures, backs up forced install/remove, isolates all hosts', async t => {
  const f = await fixture(t);
  const initial = await f.command('skill','status');
  assert.deepEqual(initial.data.hosts.map(h => h.state), ['missing','missing']);
  const target = initial.data.hosts[0].target;
  for (const args of [['install'],['remove'],['status','--host','bad'],['status','--force']]) assert.equal((await f.command('skill',...args)).code, 2);
  assert.equal((await f.command('skill','install','--host','claude','--expect','null')).code, 0);
  const latest = (await f.command('skill','status','--host','claude')).data.hosts[0]; assert.equal(latest.state, 'latest');
  await writeFile(path.join(target,'SKILL.md'), 'local edit');
  const modified = (await f.command('skill','status','--host','claude')).data.hosts[0]; assert.equal(modified.state,'modified');
  for (const action of ['install','remove']) {
    const denied = await f.command('skill',action,'--host','claude');
    assert.equal(denied.code,3); assert.equal(denied.result.code,'skill_modified'); assert.match(denied.result.hint,/--force/);
  }
  const changed = await f.command('skill','install','--host','claude','--force','--expect',latest.signature);
  assert.equal(changed.result.code, 'skill_changed');
  const partial = await f.command('skill','install','--host','all');
  assert.equal(partial.result.ok,false); assert.deepEqual(partial.data.hosts.map(h=>h.ok),[false,true]);
  assert.equal(partial.result.code,'skill_modified');
  const forced = await f.command('skill','install','--host','claude','--force','--expect',modified.signature);
  assert.equal(forced.code,0); assert.equal(await readFile(path.join(forced.data.hosts[0].backup,'SKILL.md'),'utf8'),'local edit');
  await writeFile(path.join(target,'custom'),'preserve');
  const removed = await f.command('skill','remove','--host','claude','--force');
  assert.equal(await readFile(path.join(removed.data.hosts[0].backup,'custom'),'utf8'),'preserve');
  assert.equal((await f.command('skill','remove','--host','all')).code,0);
  assert.ok((await f.command('skill','status')).data.hosts.every(h=>h.state === 'missing'));
  await assert.rejects(readFile(path.join(f.env.MULTIPLANE_HOME,'jobs.jsonl')), { code: 'ENOENT' });
});

test('skill links are blocked even with force and do not prevent the other host', async t => {
  const f = await fixture(t), external = path.join(f.root,'external'); await mkdir(external);
  await writeFile(path.join(external,'keep'),'safe');
  const target = (await f.command('skill','status','--host','claude')).data.hosts[0].target;
  await mkdir(path.dirname(target),{recursive:true});
  await symlink(external,target,process.platform === 'win32' ? 'junction' : 'dir');
  try {
    for (const action of ['install','remove']) {
      const result = await f.command('skill',action,'--host','all','--force');
      assert.equal(result.code,3); assert.equal(result.result.code,'skill_blocked');
      assert.deepEqual(result.data.hosts.map(h=>h.ok),[false,true]);
    }
    assert.equal(await readFile(path.join(external,'keep'),'utf8'),'safe');
  } finally { await unlink(target); }
});

test('CLI recognizes and updates a recorded previous skill release', async t => {
  const f = await fixture(t), source = path.join(f.root, 'old-release');
  await mkdir(source); await writeFile(path.join(source, 'SKILL.md'), 'previous release');
  await new Skills(source, '0.1.0', { user: f.env.MULTIPLANE_AGENT_HOME, env: f.env }).change('codex', 'install', null);
  const before = (await f.command('skill', 'status', '--host', 'codex')).data.hosts[0];
  assert.equal(before.state, 'update'); assert.equal(before.version, '0.1.0');
  assert.equal((await f.command('skill', 'install', '--host', 'codex', '--expect', before.signature)).code, 0);
  assert.equal((await f.command('skill', 'status', '--host', 'codex')).data.hosts[0].state, 'latest');
});

test('config and agent roots use the platform path conventions', () => {
  assert.equal(userHome({ APPDATA: 'C:\\Data' }, 'win32', 'C:\\Home'), path.win32.join('C:\\Home','.multiplane'));
  assert.equal(userHome({}, 'darwin', '/home/person'), '/home/person/Library/Application Support/multiplane');
  assert.equal(userHome({ XDG_CONFIG_HOME: '/config' }, 'linux', '/home/person'), '/config/multiplane');
});
