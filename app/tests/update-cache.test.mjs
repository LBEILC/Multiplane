import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { prepareUpdateCache, recordUpdateCache } from '../src/main/update-cache.mjs';

const logger = { info() {}, warn() {} };
async function fixture(t) {
  const dir = createTempDirectory('update-cache-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = (file, data) => writeFile(path.join(dir, file), data);
  await put('installer.exe', 'installed version');
  await put('downloaded.exe', 'new version');
  await put('current.blockmap', 'new version map');
  return { dir, put, map: path.join(dir, 'current.blockmap') };
}

test('postponed install cannot use a new blockmap with the previous installer', async t => {
  const { dir, map } = await fixture(t);
  await recordUpdateCache(dir, path.join(dir, 'downloaded.exe'), logger);
  await prepareUpdateCache(dir, logger);
  await assert.rejects(access(map), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dir, 'installer.exe'), 'utf8'), 'installed version');
});

test('a completed install can reuse the verified map, while later corruption invalidates it', async t => {
  const { dir, put, map } = await fixture(t);
  await recordUpdateCache(dir, path.join(dir, 'downloaded.exe'), logger);
  await put('installer.exe', 'new version');
  await prepareUpdateCache(dir, logger);
  assert.equal(await readFile(map, 'utf8'), 'new version map');
  // Same length changes must be caught as well as truncation.
  await put('installer.exe', 'bad version');
  await prepareUpdateCache(dir, logger);
  await assert.rejects(access(map), { code: 'ENOENT' });
});

test('legacy, missing and malformed pairing records fall back to the provider map', async t => {
  const { dir, put, map } = await fixture(t);
  await prepareUpdateCache(dir, logger);
  await assert.rejects(access(map), { code: 'ENOENT' });
  await put('current.blockmap', 'old map'); await put('blockmap-pair.json', '{invalid');
  await prepareUpdateCache(dir, logger);
  await assert.rejects(access(map), { code: 'ENOENT' });
  await prepareUpdateCache(dir, logger);
  await recordUpdateCache(dir, path.join(dir, 'downloaded.exe'), logger);
});

test('a modified map is not reused even when the installer still matches', async t => {
  const { dir, put, map } = await fixture(t);
  await recordUpdateCache(dir, path.join(dir, 'installer.exe'), logger);
  await put('current.blockmap', 'tampered map');
  await prepareUpdateCache(dir, logger);
  await assert.rejects(access(map), { code: 'ENOENT' });
});
