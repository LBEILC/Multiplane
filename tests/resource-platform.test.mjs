import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.mjs';

test('resource roots reject symlink escapes and obey the host filesystem case rules', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-resource-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = path.join(work, 'project'), outside = path.join(work, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'Asset.txt'), 'inside');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = await startServer(0, root); t.after(() => server.close());
  assert.equal(await (await fetch(server.url + '/Asset.txt')).text(), 'inside');
  assert.equal((await fetch(server.url + '/escape/secret.txt')).status, 403);
  const caseInsensitive = await stat(path.join(root, 'asset.txt')).then(() => true, () => false);
  assert.equal((await fetch(server.url + '/asset.txt')).status, caseInsensitive ? 200 : 404);
  if (!caseInsensitive) {
    const upper = path.join(work, 'PROJECT'); await mkdir(upper); await writeFile(path.join(upper, 'secret.txt'), 'outside');
    await symlink(upper, path.join(root, 'case-escape'), 'dir');
    assert.equal((await fetch(server.url + '/case-escape/secret.txt')).status, 403);
  }
});
