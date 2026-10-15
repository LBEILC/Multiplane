import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDirectory } from './helpers.mjs';

async function fixture() {
  const root = createTempDirectory('multiplane-three-resolve-');
  await mkdir(path.join(root, 'src'));
  await cp('src/three-package.mjs', path.join(root, 'src/three-package.mjs'));
  return { root, api: await import(pathToFileURL(path.join(root, 'src/three-package.mjs'))) };
}
async function install(root, relative, version) {
  const target = path.join(root, relative);
  await mkdir(path.join(target, 'build'), { recursive: true });
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: 'three', version, exports: './build/three.module.js' }));
  await writeFile(path.join(target, 'build/three.module.js'), 'export const REVISION = "test";');
}
test('npm optional peer stays optional and reports its version when installed', async () => {
  const { root, api } = await fixture();
  assert.equal((await api.threeCheck()).ok, false);
  await install(root, 'node_modules/three', '0.180.0');
  assert.equal((await api.resolveThree()).source, 'project');
  assert.deepEqual(await api.threeCheck(), { name: 'three', ok: true, detail: 'three.js 0.180.0 is available (installed by project).' });
});
test('desktop subset wins over an independently installed npm peer', async () => {
  const { root, api } = await fixture();
  await install(root, 'vendor/three', '0.180.0');
  await install(root, 'node_modules/three', '0.179.0');
  const resolved = await api.resolveThree();
  assert.equal(resolved.source, 'bundled'); assert.equal(resolved.version, '0.180.0');
  assert.match((await api.threeCheck()).detail, /bundled with software/);
});
