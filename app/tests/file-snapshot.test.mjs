import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileSnapshot } from '../tools/file-snapshot.mjs';

test('installation snapshots detect additions, deletions and same-size content changes', async t => {
  const root = createTempDirectory('multiplane-snapshot-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file'); await writeFile(file, 'before');
  const before = await fileSnapshot(root);
  assert.deepEqual(await fileSnapshot(root), before);
  await writeFile(file, 'after!');
  await utimes(file, new Date(), new Date(before[1].mtime));
  assert.notEqual((await fileSnapshot(root))[1].sha256, before[1].sha256);
  await writeFile(path.join(root, 'new'), 'added');
  assert.equal((await fileSnapshot(root)).length, before.length + 1);
  await rm(file);
  assert.notDeepEqual((await fileSnapshot(root)).map(e => e.path), before.map(e => e.path));
});
