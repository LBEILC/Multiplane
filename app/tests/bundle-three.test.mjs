import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleThree } from '../tools/bundle-three.mjs';
import { createTempDirectory } from '../../tests/helpers.mjs';
import { doctorCopy } from '../src/shared/doctor-copy.mjs';
import { setLanguage, t } from '../src/shared/i18n.mjs';

test('desktop ships only the locked three build, addons and package/license metadata', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const stage = createTempDirectory('multiplane-three-bundle-');
  const version = await bundleThree(root, stage);
  assert.equal(version, JSON.parse(await readFile(path.join(root, 'package.json'))).devDependencies.three);
  const target = path.join(stage, 'vendor/three');
  assert.deepEqual((await readdir(target)).sort(), ['LICENSE', 'build', 'examples', 'package.json']);
  assert.deepEqual(await readdir(path.join(target, 'examples')), ['jsm']);
  async function compare(relative) {
    for (const entry of await readdir(path.join(target, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await compare(file);
      else {
        assert.ok(['LICENSE', 'package.json'].includes(file) || file.endsWith('.js'), file);
        assert.deepEqual(await readFile(path.join(target, file)), await readFile(path.join(root, 'node_modules/three', file)), file);
      }
    }
  }
  await compare('');
});
test('packaging rejects a three version that differs from the lock', async () => {
  const root = createTempDirectory('multiplane-three-version-');
  await mkdir(path.join(root, 'node_modules/three'), { recursive: true });
  for (const [file, data] of Object.entries({ 'package.json': { devDependencies: { three: '0.180.0' } }, 'package-lock.json': { packages: { 'node_modules/three': { version: '0.179.0' } } }, 'node_modules/three/package.json': { version: '0.180.0' } })) await writeFile(path.join(root, file), JSON.stringify(data));
  await assert.rejects(bundleThree(root, path.join(root, 'stage')), /tested, locked version/);
});
test('environment row uses actual availability, version and source in both languages', () => {
  for (const locale of ['en', 'zh-CN']) {
    setLanguage(locale);
    for (const [source, key] of [['bundled with software', 'threeBundled'], ['installed by project', 'projectInstalled']]) {
      const content = doctorCopy({ name: 'three', ok: true, detail: `three.js 0.180.0 is available (${source}).` }, { packaged: true });
      assert.equal(content.status, 'availableVersion'); assert.equal(content.values.version, '0.180.0'); assert.equal(content.data, t(key));
    }
    assert.equal(doctorCopy({ name: 'three', ok: false }, { packaged: true }).status, 'threeMissing');
  }
  setLanguage('en');
});
