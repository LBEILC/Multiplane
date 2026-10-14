import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { desktopLicenseSources, desktopLicenseLocation } from '../tools/notices.mjs';

test('desktop notice paths survive packager dependency-directory exclusion', () => {
  for (const [relative, expected] of [
    ['node_modules/builder-util-runtime', 'builder-util-runtime'],
    ['node_modules/lazy-val', 'lazy-val'],
    ['node_modules/@scope/package/node_modules/dependency', '@scope/package/nested/dependency'],
  ]) {
    const location = desktopLicenseLocation(relative);
    assert.equal(location, expected);
    assert.ok(!location.split('/').includes('node_modules'));
  }
});

test('all packages included in the updater bundle have preserved attribution sources', async () => {
  const app = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ absWorkingDir: app, entryPoints: ['src/main/index.ts'], bundle: true, metafile: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] });
  const roots = new Set();
  for (const input of Object.keys(bundle.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(input);
    while (directory !== '.') {
      try { await readFile(path.join(app, directory, 'package.json')); roots.add(directory); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; directory = path.dirname(directory); }
    }
  }
  assert.ok([...roots].some(root => root.endsWith('electron-updater')));
  for (const root of roots) {
    const { pkg, selected } = await desktopLicenseSources(app, path.join(app, root));
    for (const { source } of selected) assert.ok((await readFile(source)).length, `${pkg.name}: ${source}`);
    if (pkg.name === 'lazy-val') assert.deepEqual(selected.map(item => item.file), ['package.json', 'NOTICE.txt']);
  }
});
