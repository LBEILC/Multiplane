import { createTempDirectory } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureElectron } from '../tools/electron.mjs';

async function fixture(t, installed = '1.2.3') {
  const app = createTempDirectory('multiplane-electron-test-');
  t.after(() => rm(app, { recursive: true, force: true }));
  const directory = path.join(app, 'node_modules/electron');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(app, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version: '1.2.3' } } }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: installed }));
  return { app, directory };
}

test('Electron preparation invokes its installer before using files and repairs incomplete extraction', async t => {
  const { app, directory } = await fixture(t);
  const executable = { win32: 'electron.exe', linux: 'electron', darwin: 'Electron.app/Contents/MacOS/Electron' }[process.platform];
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'path.txt'), executable);
  await writeFile(path.join(directory, 'install.js'), `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    assert.equal(fs.existsSync(path.join(__dirname, 'path.txt')), false);
    assert.equal(process.env.ELECTRON_INSTALL_PLATFORM, process.platform);
    assert.equal(process.env.ELECTRON_INSTALL_ARCH, process.arch);
    const executable = ${JSON.stringify(executable)};
    fs.mkdirSync(path.dirname(path.join(__dirname, 'dist', executable)), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'dist', executable), 'binary');
    fs.writeFileSync(path.join(__dirname, 'dist/version'), '1.2.3');
    fs.writeFileSync(path.join(__dirname, 'dist/LICENSES.chromium.html'), 'licenses');
    fs.writeFileSync(path.join(__dirname, 'path.txt'), executable);
  `);
  assert.equal(await ensureElectron(app), path.join(directory, 'dist', executable));
  assert.equal(await readFile(path.join(directory, 'dist/version'), 'utf8'), '1.2.3');
});

test('Electron preparation rejects package/lock mismatch and reports installation failure clearly', async t => {
  const { app, directory } = await fixture(t, '9.9.9');
  await assert.rejects(ensureElectron(app), /Unable to prepare.*differs from lockfile/);
  await writeFile(path.join(directory, 'package.json'), '{"version":"1.2.3"}');
  await writeFile(path.join(directory, 'install.js'), 'process.exit(1)');
  await assert.rejects(ensureElectron(app), /Unable to prepare.*Command failed/);
});

test('Electron preparation rejects an installer that leaves the wrong binary version', async t => {
  const { app, directory } = await fixture(t);
  await writeFile(path.join(directory, 'install.js'), `const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(path.join(__dirname, 'dist'), {recursive:true}); fs.writeFileSync(path.join(__dirname, 'dist/version'), '9.9.9');`);
  await assert.rejects(ensureElectron(app), /Binary version 9.9.9 differs from lockfile 1.2.3/);
});
