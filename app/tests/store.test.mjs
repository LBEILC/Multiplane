import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, appendFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { JobStore, EventTail, Preferences, homeDirectory } from '../src/main/store.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const schema = 'multiplane/1';
test('discovery, rotated index, missing job, lost process, stop and terminal notification', async t => {
  const home = createTempDirectory('multiplane-app-'); t.after(() => rm(home, { recursive: true, force: true }));
  const jobDir = path.join(home, 'job'); await mkdir(jobDir);
  const status = { schema, jobId: 'one', shot: path.join(home, 'shot.html'), command: 'render', pid: 1, state: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: null };
  const file = path.join(jobDir, 'status.json'); await writeFile(file, JSON.stringify(status));
  await writeFile(path.join(home, 'jobs.1.jsonl'), JSON.stringify({ schema, jobId: 'one', jobDir }) + '\n');
  await writeFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: 'missing', jobDir: path.join(home, 'missing') }) + '\n');
  let alive = true; const store = new JobStore(home, { alive: () => alive }); t.after(() => store.close());
  const notifications = []; store.on('finished', j => notifications.push(j));
  await store.refresh(); assert.equal(store.jobs.length, 1); assert.equal(notifications.length, 0);
  await rm(file); await store.refresh(); assert.equal(store.jobs.length, 1);
  await writeFile(file, JSON.stringify(status));
  await store.stop('one'); assert.equal(await readFile(path.join(jobDir, 'stop'), 'utf8'), ''); assert.equal(store.jobs[0].state, 'running');
  alive = false; await store.refresh(); assert.equal(store.jobs[0].state, 'failed'); assert.equal(store.jobs[0].result.code, 'internal_error');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'running'); assert.equal(notifications.length, 1);
  await store.refresh(); assert.equal(notifications.length, 1);
  await rm(jobDir, { recursive: true }); await store.refresh(); assert.equal(store.jobs.length, 0);
});
test('event tail reads appended bytes, split UTF-8 and truncated/replaced files', async t => {
  const home = createTempDirectory('multiplane-tail-'); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'events.jsonl'), tail = new EventTail();
  const first = JSON.stringify({ schema, type: 'warning', message: '中文' }) + '\n', bytes = Buffer.from(first), split = bytes.indexOf(Buffer.from('中')) + 1;
  await writeFile(file, bytes.subarray(0, split)); assert.equal((await tail.read(file)).length, 0);
  await appendFile(file, bytes.subarray(split)); assert.equal((await tail.read(file))[0].message, '中文');
  const count = tail.bytesRead; await tail.read(file); assert.equal(tail.bytesRead, count);
  await appendFile(file, first); assert.equal((await tail.read(file)).length, 2); assert.equal(tail.bytesRead - count, bytes.length);
  await writeFile(file, first); assert.equal((await tail.read(file)).length, 1);
  await rename(file, file + '.old'); await writeFile(file, first); assert.equal((await tail.read(file)).length, 1);
});
test('preferences stay separate and platform paths follow protocol', async t => {
  const dir = createTempDirectory('multiplane-prefs-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const prefs = new Preferences(dir); await prefs.load(); await prefs.save({ hidden: ['one'], theme: 'dark' });
  const next = new Preferences(dir); await next.load(); assert.deepEqual(next.value.hidden, ['one']); assert.equal(next.value.theme, 'dark');
  await mkdir(path.join(dir, 'preferences.json.tmp'));
  await assert.rejects(next.save({ theme: 'light' })); assert.equal(next.value.theme, 'dark');
  assert.equal(homeDirectory({}, 'linux', '/test'), '/test/.config/multiplane');
  assert.equal(homeDirectory({}, 'darwin', '/test'), '/test/Library/Application Support/multiplane');
  assert.equal(homeDirectory({ APPDATA: 'C:\\data' }, 'win32', 'C:\\profile'), 'C:\\profile\\.multiplane');
});

test('polling discovers a newly created home and completion is notified once', async t => {
  const dir = createTempDirectory('multiplane-poll-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), store = new JobStore(home, { alive: () => true, pollMs: 80 }); t.after(() => store.close());
  const finished = []; store.on('finished', j => finished.push(j)); await store.start();
  const jobDir = path.join(home, 'job'); await mkdir(jobDir, { recursive: true });
  const s = { schema, jobId: 'late', command: 'render', shot: path.join(home, 'shot.html'), pid: 1, state: 'running', result: null };
  await writeFile(path.join(jobDir, 'status.json'), JSON.stringify(s));
  await writeFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: 'late', jobDir }) + '\n');
  for (let i = 0; !store.jobs.length && i < 30; i++) await delay(30);
  assert.equal(store.jobs[0]?.state, 'running');
  // Force the poll fallback by closing all active watchers.
  for (const watcher of store.watchers.values()) watcher.close();
  await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ ...s, state: 'cancelled' }));
  for (let i = 0; !finished.length && i < 30; i++) await delay(30);
  assert.equal(finished.length, 1); assert.equal(finished[0].state, 'cancelled');
  await store.refresh(); assert.equal(finished.length, 1);
});

test('startup history stays silent and a job finishing between polls still notifies', async t => {
  const home = createTempDirectory('multiplane-terminal-'); t.after(() => rm(home, { recursive: true, force: true }));
  const record = async (id, timestamp) => {
    const jobDir = path.join(home, id); await mkdir(jobDir);
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ schema, jobId: id, command: 'render', shot: path.join(home, 'shot.html'), state: 'succeeded', updatedAt: timestamp, result: { ts: timestamp } }));
    await appendFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: id, jobDir }) + '\n');
  };
  await record('old', new Date(Date.now() - 1000).toISOString());
  const store = new JobStore(home); t.after(() => store.close()); const finished = []; store.on('finished', j => finished.push(j.jobId));
  await store.refresh(); assert.deepEqual(finished, []);
  await record('quick', new Date().toISOString()); await store.refresh(); assert.deepEqual(finished, ['quick']);
  await store.refresh(); assert.deepEqual(finished, ['quick']);
});
