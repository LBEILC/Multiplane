import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { icns } from '../tools/brand.mjs';
import { findCommand, pathVersion, rendererRoot } from '../src/main/settings.mjs';
import { initPlatform, displayPath, revealLabel } from '../src/renderer/platform.ts';

test('platform display preserves path boundaries and uses the specified reveal label', async () => {
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.window = { multiplane: { platform: async () => ({ platform: 'darwin', home: '/Users/test' }) } };
  await initPlatform();
  assert.equal(displayPath('/Users/test/file'), '~/file');
  assert.equal(displayPath('/Users/test-other/file'), '/Users/test-other/file');
  assert.equal(revealLabel(), '在访达中显示');
  window.multiplane.platform = async () => ({ platform: 'win32', home: 'C:\\profile' });
  await initPlatform(); assert.equal(displayPath('C:/work/file'), 'C:\\work\\file');
  assert.equal(revealLabel(), '在文件夹中显示');
  delete globalThis.document; delete globalThis.window;
});
test('ICNS container retains each PNG representation and a valid total length', async () => {
  const images = await Promise.all([16, 32, 64, 128, 256, 512, 1024].map(async size => ({ size, png: await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } }).png().toBuffer() })));
  const bytes = icns(images); assert.equal(bytes.toString('ascii', 0, 4), 'icns'); assert.equal(bytes.readUInt32BE(4), bytes.length);
  let at = 8;
  for (const image of images) { const length = bytes.readUInt32BE(at + 4); assert.deepEqual(bytes.subarray(at + 8, at + length), image.png); at += length; }
  assert.equal(at, bytes.length);
});
test('packaging uses native targets, unsigned DMGs and standard renderer resource roots', () => {
  const config = createRequire(import.meta.url)('../electron-builder.config.cjs');
  assert.deepEqual(config.mac.target[0].arch, ['arm64', 'x64']);
  assert.equal(config.mac.identity, null); assert.equal(config.mac.notarize, false);
  assert.deepEqual(config.linux.target, ['AppImage']);
  assert.equal(rendererRoot(true, '/Applications/Multiplane.app/Contents/Resources', '/unused'), path.join('/Applications/Multiplane.app/Contents/Resources', 'renderer'));
});
test('POSIX PATH ignores nonexecutable files and runs a Node command without a shell', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-posix-path-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second'); await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, 'multiplane'), 'not executable');
  const command = path.join(second, 'multiplane'); await writeFile(command, '#!/usr/bin/env node\nconsole.log("1.2.3");\n'); await chmod(command, 0o755);
  assert.equal(await findCommand('multiplane', { PATH: first + path.delimiter + second }), command);
  assert.equal(await pathVersion(command), '1.2.3');
});
