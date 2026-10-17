import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, access, link } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { publishVideo } from '../src/artifacts.mjs';

test('video publication is exclusive and atomic, including interruptions before and after linking', async () => {
  const root = createTempDirectory(), source = path.join(root, 'partial.mp4'), target = path.join(root, 'video.mp4');
  await writeFile(source, 'complete video');
  const interrupted = Object.assign(Error('interrupted'), { code: 'EIO' });
  await assert.rejects(publishVideo(source, target, false, { linkFile: async () => { throw interrupted; } }), interrupted);
  await assert.rejects(access(target), { code: 'ENOENT' });
  await assert.rejects(publishVideo(source, target, false, { remove: async () => { throw interrupted; } }), interrupted);
  assert.equal(await readFile(target, 'utf8'), 'complete video');
  await writeFile(source + '.other', 'other video');
  await assert.rejects(publishVideo(source + '.other', target), { code: 'output_exists' });
  assert.equal(await readFile(target, 'utf8'), 'complete video');
  await assert.rejects(publishVideo(source + '.other', target, true, { move: async () => { throw interrupted; } }), interrupted);
  assert.equal(await readFile(target, 'utf8'), 'complete video');
  await publishVideo(source + '.other', target, true);
  assert.equal(await readFile(target, 'utf8'), 'other video');
});
test('unsupported hard links fall back to rename without replacing an existing target', async () => {
  const root = createTempDirectory(), source = path.join(root, 'partial'), target = path.join(root, 'video');
  await writeFile(source, 'complete');
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']) {
    const linkFile = async () => { throw Object.assign(Error(code), { code }); };
    const destination = target + '.' + code;
    await writeFile(source, 'complete');
    await publishVideo(source, destination, false, { linkFile });
    assert.equal(await readFile(destination, 'utf8'), 'complete');
    await assert.rejects(access(source), { code: 'ENOENT' });
    await writeFile(source, 'replacement');
    await assert.rejects(publishVideo(source, destination, false, { linkFile }), { code: 'output_exists' });
    assert.equal(await readFile(destination, 'utf8'), 'complete');
    assert.equal(await readFile(source, 'utf8'), 'replacement');
  }
  await writeFile(source, 'complete');
  const unsupported = async () => { throw Object.assign(Error('unsupported'), { code: 'ENOTSUP' }); };
  for (const code of ['EIO', 'EXDEV', 'EACCES']) {
    const failure = Object.assign(Error(code), { code });
    await assert.rejects(publishVideo(source, target, false, { linkFile: async () => { throw failure; } }), failure);
    await assert.rejects(publishVideo(source, target, false, { linkFile: unsupported, move: async () => { throw failure; } }), failure);
    await assert.rejects(access(target), { code: 'ENOENT' });
    assert.equal(await readFile(source, 'utf8'), 'complete');
  }
  await assert.rejects(publishVideo(source, target, false, {
    linkFile: unsupported,
    move: async () => { throw Object.assign(Error('exists'), { code: 'EEXIST' }); },
  }), { code: 'output_exists' });
  await assert.rejects(publishVideo(source, target, false, { linkFile: async (from, to) => { await writeFile(to, 'winner'); await link(from, to); } }), { code: 'output_exists' });
  assert.equal(await readFile(target, 'utf8'), 'winner');
  await publishVideo(source, target + '.new');
  assert.equal(await readFile(target + '.new', 'utf8'), 'complete');
  await assert.rejects(access(source), { code: 'ENOENT' });
});
