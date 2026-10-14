import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { verifyUpdateArtifacts, referencedArtifactNames } from '../tools/verify-update-artifacts.mjs';

test('release verification requires metadata, every referenced file, and installer blockmaps', async t => {
  const dir = createTempDirectory('update-artifacts-'); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => verifyUpdateArtifacts(dir));
  await writeFile(path.join(dir, 'latest.yml'), 'version: 0.3.1\nfiles:\n  - url: "Multiplane%20Setup.exe"\n    sha512: abc\npath: Multiplane%20Setup.exe\n');
  assert.throws(() => verifyUpdateArtifacts(dir));
  await writeFile(path.join(dir, 'Multiplane Setup.exe'), 'installer');
  assert.throws(() => verifyUpdateArtifacts(dir));
  await writeFile(path.join(dir, 'Multiplane Setup.exe.blockmap'), 'blockmap');
  assert.equal(verifyUpdateArtifacts(dir).artifacts.length, 2);
  await writeFile(path.join(dir, 'latest.yml'), 'files:\n  - url: missing.exe\npath: Multiplane%20Setup.exe');
  assert.throws(() => verifyUpdateArtifacts(dir));
  assert.throws(() => referencedArtifactNames('version: 0.3.1'));
  for (const name of ['../outside.exe', '%2e%2e%2foutside.exe', 'https://example.com/app.exe']) assert.throws(() => referencedArtifactNames(`path: ${name}`));
});
