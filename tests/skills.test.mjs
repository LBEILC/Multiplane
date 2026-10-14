import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm, symlink, lstat, unlink } from 'node:fs/promises';
import { Skills } from '../src/skills.mjs';
import { createTempDirectory } from './helpers.mjs';
import { useShortTempDirectory } from './short-path.mjs';
async function fixture(t) {
  const root = createTempDirectory('multiplane-settings-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'SKILL.md'), 'v1');
  const user = path.join(root, 'user'); await mkdir(path.join(user, '.claude'), { recursive: true });
  return { root, source, user, env: { PATH: '' } };
}
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
  const replaced = await v2.change('claude', 'install', modified.signature, backupName, true);
  assert.equal(path.basename(replaced.backup), backupName);
  assert.match(path.basename(replaced.backup), /^multiplane\.bak-/); assert.equal(await readFile(path.join(replaced.backup, 'SKILL.md'), 'utf8'), 'user changes');
  await writeFile(path.join(v2.target('claude'), 'extra.md'), 'extra');
  await writeFile(path.join(v2.target('claude'), '__proto__'), 'extra');
  const removed = await v2.change('claude', 'remove', (await v2.status('claude')).signature, undefined, true);
  assert.equal(await readFile(path.join(removed.backup, 'extra.md'), 'utf8'), 'extra');
  assert.equal((await v2.status('claude')).state, 'missing');
  await v2.change('codex', 'install', null);
  await v2.change('codex', 'remove', (await v2.status('codex')).signature);
  assert.equal((await readdir(path.dirname(v2.target('codex')))).length, 0);
});
test('bundled release version supports existing and updated skill content in isolated homes', async t => {
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const desktop = JSON.parse(await readFile(new URL('../app/package.json', import.meta.url), 'utf8')).version;
  assert.equal(desktop, version);
  for (const host of ['claude', 'codex']) {
    const f = await fixture(t);
    // This is the previous release, intentionally distinct from the bundled version.
    await new Skills(f.source, '0.1.0', f).change(host, 'install', null);
    const current = new Skills(f.source, version, f);
    const unchanged = await current.status(host);
    assert.equal(unchanged.state, 'latest');
    assert.equal(unchanged.version, version);
    assert.equal(unchanged.availableVersion, version);
    await writeFile(path.join(f.source, 'SKILL.md'), 'updated release content');
    const before = await current.status(host);
    assert.equal(before.state, 'update'); assert.equal(before.version, '0.1.0');
    await current.change(host, 'install', before.signature);
    const after = await current.status(host);
    assert.equal(after.state, 'latest'); assert.equal(after.version, version);
    const record = JSON.parse(await readFile(path.join(current.target(host), '.multiplane.json'), 'utf8'));
    assert.equal(record.version, version);
  }
});

test('corrupt installation records are treated conservatively without losing user files', async t => {
  const f = await fixture(t), skills = new Skills(f.source, '1.0.0', f);
  await skills.change('claude', 'install', null);
  await writeFile(path.join(skills.target('claude'), 'SKILL.md'), 'custom');
  await writeFile(path.join(skills.target('claude'), '.multiplane.json'), JSON.stringify({ v: 1, host: 'claude', skill: 'multiplane', releases: {} }));
  const status = await skills.status('claude'); assert.equal(status.state, 'modified');
  const result = await skills.change('claude', 'install', status.signature, undefined, true);
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
  const updated = await newer.change(host, 'install', (await newer.status(host)).signature, undefined, true);
  assert.equal(path.dirname(updated.backup), expectedRoot); assert.equal(await readFile(path.join(updated.backup, 'SKILL.md'), 'utf8'), 'user edit');
  await writeFile(path.join(installed.target, 'custom'), 'keep');
  const removed = await newer.change(host, 'remove', (await newer.status(host)).signature, undefined, true);
  assert.equal(path.dirname(removed.backup), expectedRoot); assert.equal(await readFile(path.join(removed.backup, 'custom'), 'utf8'), 'keep');
  await newer.change(host, 'install', null);
  await newer.change(host, 'remove', (await newer.status(host)).signature, undefined, true);
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
  assert.equal(status.state, 'modified'); assert.equal(status.blocked, true); assert.match(status.error, /symbolic links/);
  for (const action of ['install', 'remove']) await assert.rejects(skills.change('claude', action, status.signature), /symbolic links/);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await unlink(link);
});

