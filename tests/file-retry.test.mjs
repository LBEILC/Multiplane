import test from 'node:test';
import assert from 'node:assert/strict';
import { retryFileOperation } from '../src/user-home.mjs';
import { appendJobIndex } from '../src/user-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createEvents } from '../src/events.mjs';

test('Windows transient sharing failures recover within one shared second', () => {
  let elapsed = 0;
  const options = { platform: 'win32', now: () => elapsed, sleep: ms => { elapsed += ms; } };
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let attempts = 0;
    assert.equal(retryFileOperation(() => { if (++attempts < 3) throw Object.assign(Error(), { code }); return 'written'; }, 1000, options), 'written');
    assert.equal(attempts, 3);
  }
  assert.throws(() => retryFileOperation(() => { throw Object.assign(Error(), { code: 'EBUSY' }); }, 1000, options), { code: 'EBUSY' });
  assert.equal(elapsed, 1000);
  assert.throws(() => retryFileOperation(() => { throw Object.assign(Error(), { code: 'EINVAL' }); }, 2000, options), { code: 'EINVAL' });
  assert.equal(elapsed, 1000);
});

test('lock, append and unlock recover simulated sharing violations without duplicate rows', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multiplane-lock-'));
  const open = fs.openSync, write = fs.writeSync, unlink = fs.unlinkSync;
  const counts = { lock: 0, append: 0, write: 0, unlock: 0 };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    const kind = flags === 'wx' ? 'lock' : 'append';
    if (++counts[kind] === 1) throw Object.assign(Error('sharing violation'), { code: kind === 'lock' ? 'EPERM' : 'EACCES' });
    return open(file, flags, ...rest);
  });
  t.mock.method(fs, 'writeSync', (...args) => { if (++counts.write === 1) throw Object.assign(Error('sharing violation'), { code: 'EBUSY' }); return write(...args); });
  t.mock.method(fs, 'unlinkSync', (...args) => { if (++counts.unlock === 1) throw Object.assign(Error('sharing violation'), { code: 'EPERM' }); return unlink(...args); });
  syncBuiltinESMExports();
  appendJobIndex(directory, { event: 'start', jobId: 'test' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'jobs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [{ event: 'start', jobId: 'test' }]);
  assert.equal(fs.existsSync(path.join(directory, 'jobs.lock')), false);
  assert.deepEqual(counts, { lock: 2, append: 2, write: 3, unlock: 2 });
});
test('status snapshot replacement tolerates a transient Windows reader', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multiplane-status-'));
  const rename = fs.renameSync; let calls = 0;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(fs, 'renameSync', (...args) => { if (++calls === 1) throw Object.assign(Error('sharing violation'), { code: 'EPERM' }); return rename(...args); });
  syncBuiltinESMExports();
  const events = createEvents('render', 'example.html', { 'job-dir': directory }, true);
  try {
    events.progress('capture', 1, 10);
    assert.equal(JSON.parse(fs.readFileSync(path.join(events.directory, 'status.json'), 'utf8')).done, 1);
    assert.ok(calls >= 2);
  } finally { events.dispose(); }
});
