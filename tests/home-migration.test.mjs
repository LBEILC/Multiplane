import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { userHome } from '../src/platform.mjs';
import { migrateUserHome } from '../src/home-migration.mjs';
import { loadUserConfig } from '../src/user-home.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const windows = { skip: process.platform !== 'win32' };
async function fixture() {
  const root = createTempDirectory();
  const env = { ...process.env, MULTIPLANE_HOME: '', USERPROFILE: path.join(root, 'user'), APPDATA: path.join(root, 'roaming') };
  const old = path.join(env.APPDATA, 'multiplane'), home = userHome(env);
  await mkdir(old, { recursive: true });
  return { env, old, home, root };
}
const names = ['config.json', 'jobs.jsonl', 'jobs.1.jsonl'];
const contents = ['{"workers":2,"custom":true}', '{"old":1}\n', '{"archived":1}\n'];
async function seed(directory) {
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < names.length; i++) await writeFile(path.join(directory, names[i]), contents[i]);
}
async function cli(f, args) {
  const result = await run(process.execPath, ['bin/multiplane', ...args, '--json'], { env: f.env });
  return { ...result, events: result.stdout.trim().split('\n').map(JSON.parse) };
}

test('USERPROFILE wins over homedir; other platforms and explicit overrides retain their paths', () => {
  assert.equal(userHome({ USERPROFILE: 'C:\\user', APPDATA: 'C:\\roaming' }, 'win32', 'C:\\fallback'), 'C:\\user\\.multiplane');
  assert.equal(userHome({}, 'win32', 'C:\\fallback'), 'C:\\fallback\\.multiplane');
  assert.equal(userHome({ MULTIPLANE_HOME: 'D:\\custom' }, 'win32', 'C:\\fallback'), 'D:\\custom');
  for (const platform of ['linux', 'darwin']) assert.deepEqual(migrateUserHome({}, platform, '/fake'), { migrated: [], warnings: [] });
});

test('old-only copies all files once without deleting sources; new-only and both preserve destinations', windows, async () => {
  const f = await fixture(); await seed(f.old);
  assert.equal(migrateUserHome(f.env).migrated.length, 3);
  for (let i = 0; i < names.length; i++) {
    assert.equal(await readFile(path.join(f.old, names[i]), 'utf8'), contents[i]);
    assert.equal(await readFile(path.join(f.home, names[i]), 'utf8'), contents[i]);
    await writeFile(path.join(f.old, names[i]), 'changed');
  }
  assert.deepEqual(migrateUserHome(f.env), { migrated: [], warnings: [] });
  for (let i = 0; i < names.length; i++) assert.equal(await readFile(path.join(f.home, names[i]), 'utf8'), contents[i]);
  const fresh = await fixture(); await seed(fresh.home);
  assert.deepEqual(migrateUserHome(fresh.env), { migrated: [], warnings: [] });
  assert.deepEqual((await readdir(f.home)).sort(), [...names].sort());
});

test('per-file migration and explicit MULTIPLANE_HOME skip', windows, async () => {
  const f = await fixture(); await seed(f.old); await mkdir(f.home, { recursive: true });
  await writeFile(path.join(f.home, 'config.json'), '{}');
  assert.deepEqual(migrateUserHome(f.env).migrated.map(item => item.name), names.slice(1));
  const other = await fixture(); await seed(other.old);
  assert.deepEqual(migrateUserHome({ ...other.env, MULTIPLANE_HOME: other.home }), { migrated: [], warnings: [] });
  await assert.rejects(readdir(other.home), { code: 'ENOENT' });
});

test('corrupt old bytes are retained and validated by existing readers; copy failure only warns', windows, async () => {
  const f = await fixture(); await seed(f.old);
  await writeFile(path.join(f.old, 'config.json'), '{');
  await writeFile(path.join(f.old, 'jobs.jsonl'), 'broken\n');
  assert.equal(loadUserConfig('render', {}, f.env).warnings[0].code, 'config_invalid');
  assert.equal(await readFile(path.join(f.home, 'jobs.jsonl'), 'utf8'), 'broken\n');
  const result = await cli(f, ['config', 'set', 'workers', '3']);
  assert.equal(result.code, 3); assert.equal(result.events.at(-1).code, 'config_invalid');
  assert.equal(await readFile(path.join(f.home, 'config.json'), 'utf8'), '{');
  const bad = await fixture(); await mkdir(path.join(bad.old, 'config.json'));
  const loaded = loadUserConfig('render', {}, bad.env);
  assert.equal(loaded.warnings[0].code, 'home_unavailable');
  assert.deepEqual(await readdir(bad.home), []);
});

test('two first CLI writers migrate once and merge under config.json.lock', windows, async () => {
  const f = await fixture(); await seed(f.old);
  const results = await Promise.all([cli(f, ['config', 'set', 'raster', 'software']), cli(f, ['config', 'set', 'workers', '7'])]);
  for (const result of results) assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.home, 'config.json'))), { schema: 'multiplane/1', workers: 7, custom: true, raster: 'software' });
  for (let i = 1; i < names.length; i++) assert.equal(await readFile(path.join(f.home, names[i]), 'utf8'), contents[i]);
  assert.deepEqual((await readdir(f.home)).sort(), [...names].sort());
  assert.equal(await readFile(path.join(f.old, 'config.json'), 'utf8'), contents[0]);
});

test('doctor reports migration once in home detail, and failed migration does not stop rendering', windows, async () => {
  const f = await fixture(); await seed(f.old);
  const first = await cli(f, ['doctor']);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.events.at(-1).data.checks.find(item => item.name === 'home').detail, /Copied from the previous location/);
  assert.ok(!first.events.some(item => item.code === 'home_unavailable'));
  const second = await cli(f, ['doctor']);
  assert.doesNotMatch(second.events.at(-1).data.checks.find(item => item.name === 'home').detail, /Copied/);
  const bad = await fixture(); await mkdir(path.join(bad.old, 'config.json'));
  const rendered = await cli(bad, ['render', 'examples/animation.html', '--to', '0.1', '--workers', '1', '--job-dir', path.join(bad.root, 'jobs')]);
  assert.equal(rendered.code, 0, rendered.stdout + rendered.stderr);
  assert.equal(rendered.events.filter(item => item.code === 'home_unavailable').length, 1);
});
