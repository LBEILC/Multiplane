import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { openShot } from '../src/capture.mjs';
import { mkdir, writeFile, symlink, unlink, utimes } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { inputRecords, digest } from '../src/input-records.mjs';
import { checkInputs, manifestStore } from '../src/segments.mjs';
import { startServer } from '../src/server.mjs';
import { resumeRender } from '../src/resume.mjs';

const linkDirectory = (target, alias) => symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
const changed = file => error => error.code === 'resume_unavailable'
  && error.details.reason === 'inputs_changed' && error.details.changes.includes(file);

async function fixture() {
  const root = createTempDirectory('multiplane-input-alias-');
  for (const name of ['before', 'after', 'segments']) await mkdir(path.join(root, name));
  const manifest = { inputs: {}, segments: [] };
  return { root, manifest, store: manifestStore(path.join(root, 'segments'), manifest) };
}

for (const directoryIndex of [false, true]) test(`checkpoint tracks directory aliases${directoryIndex ? ' including index.html' : ''}`, async () => {
  const { root, manifest, store } = await fixture();
  const name = directoryIndex ? 'index.html' : 'asset.txt';
  const alias = path.join(root, 'current'), logical = path.join(alias, name);
  for (const [directory, text] of [['before', 'RED'], ['after', 'BLUE']]) await writeFile(path.join(root, directory, name), text);
  await linkDirectory(path.join(root, 'before'), alias);
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, root);
    try {
      const url = server.url + (directoryIndex ? '/current/' : '/current/asset.txt');
      for (let i = 0; i < 2; i++) assert.equal(await (await fetch(url)).text(), 'RED');
      await checkInputs(manifest);
      assert.equal(manifest.inputs[logical]?.sha256, digest(Buffer.from('RED')));
      assert.equal(manifest.inputs[path.join(root, 'before', name)]?.sha256, digest(Buffer.from('RED')));
      await unlink(alias); await linkDirectory(path.join(root, 'after'), alias);
      await assert.rejects(checkInputs(manifest), changed(logical));
      // The active render must reject a new target rather than collecting both versions.
      assert.equal((await fetch(url)).status, 400);
    } finally { await server.close(); }
  });
});

test('checkpoint tracks a symlinked project root even when the shot itself is unchanged', async () => {
  const { root, manifest, store } = await fixture();
  const alias = path.join(root, 'project'), logical = path.join(alias, 'asset.txt');
  for (const directory of ['before', 'after']) await writeFile(path.join(root, directory, 'shot.html'), 'identical shot');
  await writeFile(path.join(root, 'before/asset.txt'), 'RED');
  await writeFile(path.join(root, 'after/asset.txt'), 'BLUE');
  await linkDirectory(path.join(root, 'before'), alias);
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, alias);
    try {
      assert.equal(await (await fetch(server.url + '/shot.html')).text(), 'identical shot');
      assert.equal(await (await fetch(server.url + '/asset.txt')).text(), 'RED');
      await unlink(alias); await linkDirectory(path.join(root, 'after'), alias);
      await assert.rejects(checkInputs(manifest), changed(logical));
    } finally { await server.close(); }
  });
});

test('same-content alias retarget remains reusable and aliases do not affect runtime resources', async () => {
  const { root, manifest, store } = await fixture();
  const alias = path.join(root, 'current');
  for (const directory of ['before', 'after']) await writeFile(path.join(root, directory, 'asset.txt'), 'same');
  await linkDirectory(path.join(root, 'before'), alias);
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, root);
    try {
      assert.equal(await (await fetch(server.url + '/current/asset.txt')).text(), 'same');
      await unlink(alias); await linkDirectory(path.join(root, 'after'), alias);
      await checkInputs(manifest);
      assert.equal(await (await fetch(server.url + '/current/asset.txt')).text(), 'same');
      assert.equal((await fetch(server.url + '/multiplane/runtime/shot.js')).status, 200);
      assert.equal(Object.keys(manifest.inputs).some(file => file.startsWith(path.join(root, 'multiplane'))), false);
      await checkInputs(manifest);
    } finally { await server.close(); }
  });
});

test('large ranged media aliases record the served target hash even with identical size and mtime', async () => {
  const { root, manifest, store } = await fixture();
  const alias = path.join(root, 'current'), logical = path.join(alias, 'media.wav');
  const bytes = Buffer.alloc(1024 * 1024 + 1, 42), modified = Buffer.alloc(bytes.length, 43);
  const time = new Date('2026-01-01T00:00:00Z');
  for (const [directory, data] of [['before', bytes], ['after', modified]]) {
    const file = path.join(root, directory, 'media.wav');
    await writeFile(file, data); await utimes(file, time, time);
  }
  await linkDirectory(path.join(root, 'before'), alias);
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, root);
    try {
      const response = await fetch(server.url + '/current/media.wav', { headers: { Range: 'bytes=10-20' } });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(10, 21));
      assert.deepEqual(manifest.inputs[logical], { bytes: bytes.length, sha256: digest(bytes) });
      await unlink(alias); await linkDirectory(path.join(root, 'after'), alias);
      await assert.rejects(checkInputs(manifest), changed(logical));
      assert.equal((await fetch(server.url + '/current/media.wav', { headers: { Range: 'bytes=10-20' } })).status, 400);
    } finally { await server.close(); }
  });
});

test('checkpoint tracks file symlinks and rejects a removed alias', async t => {
  const { root, manifest, store } = await fixture();
  const target = path.join(root, 'before/asset.txt'), alias = path.join(root, 'asset.txt');
  await writeFile(target, 'RED');
  try { await symlink(target, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Creating file symlinks requires Windows Developer Mode or privilege.'); return; }
    throw error;
  }
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, root);
    try {
      assert.equal(await (await fetch(server.url + '/asset.txt')).text(), 'RED');
      assert.equal(manifest.inputs[alias]?.sha256, digest(Buffer.from('RED')));
      await unlink(alias);
      await assert.rejects(checkInputs(manifest), changed(alias));
    } finally { await server.close(); }
  });
});


test('resume API rejects a changed asset alias before inspecting FFmpeg', async () => {
  const { root, manifest, store } = await fixture();
  const alias = path.join(root, 'current'), logical = path.join(alias, 'asset.txt');
  const shot = path.join(root, 'shot.html');
  await writeFile(shot, 'unchanged');
  Object.assign(manifest, { schema: 'multiplane-segments/1', shot, first: 0, end: 1, total: 1, segmentFrames: 1,
    options: { root, out: path.join(root, 'video.mp4'), 'job-dir': path.join(root, 'jobs'), 'no-lint': true } });
  await writeFile(path.join(root, 'status.json'), JSON.stringify({ schema: 'multiplane/1', pid: process.pid,
    command: 'render', state: 'failed', jobId: path.basename(root) }));
  await writeFile(path.join(root, 'before/asset.txt'), 'RED');
  await writeFile(path.join(root, 'after/asset.txt'), 'BLUE');
  await linkDirectory(path.join(root, 'before'), alias);
  await inputRecords.run(store.input, async () => {
    const server = await startServer(0, root);
    try { assert.equal(await (await fetch(server.url + '/current/asset.txt')).text(), 'RED'); }
    finally { await server.close(); }
  });
  await unlink(alias); await linkDirectory(path.join(root, 'after'), alias);
  let inspected = false;
  await assert.rejects(resumeRender(root, { _inspectFFmpeg() { inspected = true; throw Error('Should not launch'); } }), changed(logical));
  assert.equal(inspected, false);
});


test('capture preserves the logical root when creating its resource server', async t => {
  const { root, manifest, store } = await fixture();
  const alias = path.join(root, 'project');
  await writeFile(path.join(root, 'before/shot.html'), '<div id="stage"></div>');
  await writeFile(path.join(root, 'before/asset.txt'), 'RED');
  await linkDirectory(path.join(root, 'before'), alias);
  let url, launches = 0;
  const listen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    this.once('listening', () => { url = `http://127.0.0.1:${this.address().port}`; });
    return listen.apply(this, args);
  });
  // Exercise the real capture/server handoff without requiring Chromium. Stop at
  // the launch boundary after requesting an asset through the running server.
  t.mock.method(chromium, 'launch', async () => {
    launches++;
    assert.equal(await (await fetch(url + '/asset.txt')).text(), 'RED');
    throw Error('intentional launch boundary');
  });
  await inputRecords.run(store.input, () => assert.rejects(openShot('shot.html', 1, { root: alias, raster: 'software' }), { code: 'browser_launch_failed' }));
  assert.equal(launches, 1);
  assert.equal(manifest.inputs[path.join(alias, 'asset.txt')]?.sha256, digest(Buffer.from('RED')));
});
