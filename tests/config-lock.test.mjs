import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createTempDirectory } from './helpers.mjs';
import { Configuration } from '../src/config.mjs';
import { lockConfiguration } from '../src/config-lock.mjs';
import { processCreatedAt } from '../src/process-identity.mjs';

async function fixture(t) {
  const home = createTempDirectory('multiplane-config-lock-');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.json'), lock = file + '.lock';
  const original = JSON.stringify({ future: { nested: [1, 'keep'] }, hosted: false }) + '\n';
  await fs.writeFile(file, original);
  return { home, file, lock, original };
}

function writer(t, f, key, value, mode) {
  const child = fork(new URL('./fixtures/config-writer.mjs', import.meta.url),
    [f.home, key, JSON.stringify(value), mode ?? ''], {
      execArgv: [], env: { ...process.env, MULTIPLANE_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, closed, message: once(child, 'message').then(([message]) => message) };
}

async function marker(lock, changes = {}) {
  await fs.mkdir(lock);
  const name = randomUUID() + '.json';
  await fs.writeFile(path.join(lock, name), JSON.stringify({
    schema: 'multiplane-config-lock/1', host: hostname(), pid: process.pid,
    createdAt: await processCreatedAt(process.pid), ...changes,
  }));
  return name;
}

test('config recovers an interrupted writer and serializes concurrent separate-process saves', async t => {
  const f = await fixture(t), held = writer(t, f, 'workers', 9, 'hold');
  assert.equal((await held.message).type, 'locked');
  const [name] = await fs.readdir(f.lock);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.lock, name))).pid, held.child.pid);
  held.child.kill('SIGKILL'); await held.closed;
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  const writers = [['workers', 4], ['raster', 'software'], ['encoder', 'nvenc-h264']]
    .map(([key, value]) => writer(t, f, key, value));
  for (const current of writers) {
    assert.deepEqual(await current.message, { type: 'saved' });
    assert.equal((await current.closed)[0], 0);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(f.file)), {
    schema: 'multiplane/1', future: { nested: [1, 'keep'] }, hosted: false,
    workers: 4, raster: 'software', encoder: 'nvenc-h264',
  });
  assert.deepEqual(await fs.readdir(f.home), ['config.json']);
});

test('a live writer is not stolen even when its lock is old', async t => {
  const f = await fixture(t), held = writer(t, f, 'workers', 2, 'hold');
  assert.equal((await held.message).type, 'locked');
  const [name] = await fs.readdir(f.lock), owner = path.join(f.lock, name);
  const before = await fs.readFile(owner, 'utf8'), old = new Date(0);
  await fs.utimes(owner, old, old); await fs.utimes(f.lock, old, old);
  await assert.rejects(lockConfiguration(f.file, { timeout: 50 }), { code: 'config_locked', exitCode: 3 });
  assert.equal(await fs.readFile(owner, 'utf8'), before);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  held.child.send('continue');
  assert.equal((await held.closed)[0], 0);
  assert.equal(JSON.parse(await fs.readFile(f.file)).workers, 2);
});

test('legacy empty lock files stay untouched, with a manual recovery hint', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.lock, '');
  await fs.utimes(f.lock, new Date(0), new Date(0));
  await assert.rejects(lockConfiguration(f.file, { timeout: 50 }), error => {
    assert.equal(error.code, 'config_locked');
    assert.equal(error.details.path, f.lock);
    assert.match(error.hint, /only after confirming no process/);
    return true;
  });
  assert.equal(await fs.readFile(f.lock, 'utf8'), '');
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  assert.deepEqual((await fs.readdir(f.home)).sort(), ['config.json', 'config.json.lock']);
});

test('a reused PID is recovered only with a different known process creation time', async t => {
  const f = await fixture(t);
  const current = await processCreatedAt(process.pid);
  if (!current) { t.skip('Process creation time is unavailable on this host.'); return; }
  await marker(f.lock, { createdAt: '1970-01-01T00:00:00.000Z' });
  await new Configuration(f.home).save('workers', 3);
  assert.equal(JSON.parse(await fs.readFile(f.file)).workers, 3);
});

test('unknown identities and foreign hosts fail closed', async t => {
  const f = await fixture(t);
  for (const changes of [{ createdAt: null }, { createdAt: 'invalid' }, { host: hostname() + '-other' }, { pid: -1 }, { schema: 'unknown' }]) {
    const name = await marker(f.lock, changes), before = await fs.readFile(path.join(f.lock, name), 'utf8');
    await assert.rejects(lockConfiguration(f.file, { timeout: 25 }), { code: 'config_locked' });
    assert.equal(await fs.readFile(path.join(f.lock, name), 'utf8'), before);
    await fs.rm(f.lock, { recursive: true });
  }
});

test('a delayed unlock does not delete a replacement owner', async t => {
  const f = await fixture(t), unlock = await lockConfiguration(f.file);
  const previous = f.lock + '.previous';
  await fs.rename(f.lock, previous);
  const replacement = await lockConfiguration(f.file), [name] = await fs.readdir(f.lock);
  await unlock();
  assert.deepEqual(await fs.readdir(f.lock), [name]);
  await replacement();
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
});

test('recovery racing a new owner cannot remove the replacement lock', async t => {
  const f = await fixture(t), held = writer(t, f, 'workers', 9, 'hold');
  assert.equal((await held.message).type, 'locked');
  held.child.kill('SIGKILL'); await held.closed;
  const [stale] = await fs.readdir(f.lock);
  const unlink = fs.unlink;
  let replacement, replacementName;
  t.mock.method(fs, 'unlink', async file => {
    if (file === path.join(f.lock, stale) && !replacement) {
      // Another reaper removes the old owner and a new writer publishes.
      await unlink(file); await fs.rmdir(f.lock);
      replacement = await lockConfiguration(f.file);
      [replacementName] = await fs.readdir(f.lock);
    }
    return unlink(file);
  });
  await assert.rejects(lockConfiguration(f.file, { timeout: 100 }), { code: 'config_locked' });
  assert.deepEqual(await fs.readdir(f.lock), [replacementName]);
  await replacement();
});

test('a replacement published during release survives the old directory cleanup', async t => {
  const f = await fixture(t), unlock = await lockConfiguration(f.file), rmdir = fs.rmdir;
  let replacement, name;
  t.mock.method(fs, 'rmdir', async directory => {
    if (directory === f.lock && !replacement) {
      await rmdir(directory);
      replacement = await lockConfiguration(f.file);
      [name] = await fs.readdir(f.lock);
    }
    return rmdir(directory);
  });
  await unlock();
  assert.deepEqual(await fs.readdir(f.lock), [name]);
  await replacement();
});

test('acquisition retries when a Windows-style collision disappears before inspection', async t => {
  const f = await fixture(t), unlock = await lockConfiguration(f.file), rename = fs.rename;
  let collided = false;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === f.lock && !collided) {
      collided = true;
      await unlock();
      throw Object.assign(Error('occupied directory'), { code: 'EPERM' });
    }
    return rename(source, target);
  });
  const replacement = await lockConfiguration(f.file);
  assert.equal(collided, true);
  await replacement();
  assert.deepEqual(await fs.readdir(f.home), ['config.json']);
});

test('inaccessible owners and malformed lock metadata are not reclaimed', async t => {
  const f = await fixture(t), name = await marker(f.lock);
  t.mock.method(process, 'kill', () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); });
  await assert.rejects(lockConfiguration(f.file, { timeout: 25 }), { code: 'config_locked' });
  assert.deepEqual(await fs.readdir(f.lock), [name]);
  t.mock.restoreAll();
  await fs.writeFile(path.join(f.lock, name), '{broken');
  await assert.rejects(lockConfiguration(f.file, { timeout: 25 }), { code: 'config_locked' });
  assert.equal(await fs.readFile(path.join(f.lock, name), 'utf8'), '{broken');
});

test('an interrupted empty lock directory can be recovered', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.lock);
  await new Configuration(f.home).save('raster', 'software');
  assert.equal(JSON.parse(await fs.readFile(f.file)).raster, 'software');
});

test('save failure releases its lock and preserves the valid configuration', async t => {
  const f = await fixture(t);
  class FailingConfiguration extends Configuration {
    async document() { throw Error('injected read failure'); }
  }
  await assert.rejects(new FailingConfiguration(f.home).save('workers', 4), /injected read failure/);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.home), ['config.json']);
  await new Configuration(f.home).save('workers', 5);
  assert.equal(JSON.parse(await fs.readFile(f.file)).workers, 5);
});

test('failed config publication preserves the old document and removes temporary files', async t => {
  const f = await fixture(t), rename = fs.rename;
  t.mock.method(fs, 'rename', (source, target) => {
    if (target === f.file) throw Object.assign(Error('injected rename failure'), { code: 'EACCES' });
    return rename(source, target);
  });
  await assert.rejects(new Configuration(f.home).save('workers', 4), { code: 'EACCES' });
  assert.equal(await fs.readFile(f.file, 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.home), ['config.json']);
});
