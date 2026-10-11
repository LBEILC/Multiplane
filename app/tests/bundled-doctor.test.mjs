import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundledCommand, execute, parseDoctor } from '../src/main/settings.mjs';

test('bundled doctor retains checks and config when run outside the renderer directory', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-doctor-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, MULTIPLANE_HOME: work, PLAYWRIGHT_BROWSERS_PATH: path.join(work, 'missing-browser') };
  const args = ['doctor', '--json'];
  const before = await execute(process.execPath, [path.join(root, 'bin/multiplane'), ...args], { cwd: root, env });
  const after = await bundledCommand(root, args, env);
  assert.equal(after.code, before.code);
  assert.deepEqual(parseDoctor(after.stdout).data, parseDoctor(before.stdout).data);
});
