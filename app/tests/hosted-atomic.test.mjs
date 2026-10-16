import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { atomic } from '../src/main/hosted.mjs';

async function fixture(t) {
  const directory = createTempDirectory('hosted-atomic-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'status.json');
  await writeFile(file, '{"old":true}\n');
  return file;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`Windows atomic replacement retries ${code} without removing the prior value`, async t => {
  const file = await fixture(t), pauses = []; let calls = 0;
  await atomic(file, { next: true }, { platform: 'win32', pause: async ms => pauses.push(ms), move: async (from, to) => {
    assert.deepEqual(JSON.parse(await readFile(to, 'utf8')), { old: true });
    assert.equal(await readFile(from, 'utf8'), '{"next":true}\n');
    if (++calls < 3) throw Object.assign(Error(code), { code });
    await rename(from, to);
  } });
  assert.equal(calls, 3); assert.deepEqual(pauses, [25, 50]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { next: true });
});

for (const [platform, code, attempts] of [['win32', 'EPERM', 6], ['win32', 'EIO', 1], ['linux', 'EPERM', 1]]) test(`${platform} atomic replacement bounds ${code} failure and preserves the prior value`, async t => {
  const file = await fixture(t), pauses = []; let calls = 0;
  const error = Object.assign(Error(code), { code });
  await assert.rejects(atomic(file, { next: true }, { platform, pause: async ms => pauses.push(ms), move: async () => { calls++; throw error; } }), value => value === error);
  assert.equal(calls, attempts); assert.equal(pauses.length, attempts - 1);
  assert.ok(pauses.every(ms => ms <= 200));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { old: true });
});
