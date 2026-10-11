import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findInstaller } from '../tools/installer-file.mjs';

test('installer discovery uses actual platform filenames and rejects zero or multiple matches', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multiplane-installers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, name] of [['win32', 'Multiplane-Setup-0.0.0-x64.exe'], ['darwin', 'Multiplane-0.0.0-arm64.dmg'], ['linux', 'Multiplane-0.0.0-x86_64.AppImage']]) {
    const dir = path.join(root, platform); await mkdir(dir);
    await assert.rejects(findInstaller(dir, platform), /found 0: \[\]/);
    await mkdir(path.join(dir, 'directory' + path.extname(name)));
    await writeFile(path.join(dir, name + '.blockmap'), '');
    await writeFile(path.join(dir, name), '');
    assert.equal(await findInstaller(dir, platform), path.join(dir, name));
    await writeFile(path.join(dir, 'old-' + name), '');
    await assert.rejects(findInstaller(dir, platform), error => error.message.includes('found 2:') && error.message.includes(name) && error.message.includes('old-' + name));
  }
});
