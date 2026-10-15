import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { windowsShortPath } from './short-path.mjs';
import path from 'node:path';
import { normalizeResourcePath, isInsideResourceRoot, relativeResourcePath } from '../src/resource-path.mjs';
import { scanShot } from '../src/lint.mjs';
import { openShot } from '../src/capture.mjs';
import { startServer } from '../src/server.mjs';
import { run, createTempDirectory } from './helpers.mjs';

const html = '<div id="stage" style="width:32px;height:32px;background:red"></div><script>window.SHOT={duration:1,fps:4,render(){}}</script>';
test('node_modules shots fail before launching and work with the package as root', async t => {
  const { root } = await fixture(t);
  const pkg = path.join(root, 'node_modules/example');
  await mkdir(pkg, { recursive: true });
  const shot = path.join(pkg, 'shot.html');
  await writeFile(shot, html);
  let launched = false;
  await assert.rejects(openShot(shot, 1, { root, onBrowser: () => { launched = true; } }), error => {
    assert.equal(error.code, 'shot_outside_root');
    assert.match(error.hint, /--root.*package directory/);
    assert.equal(error.details.path, path.relative(root, shot));
    return true;
  });
  assert.equal(launched, false);
  const capture = await openShot(shot, 1, { root: pkg });
  await capture.close();
});

test('HTTP shot failures retain status and resource path', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, '.blocked.html'), html);
  await assert.rejects(openShot('.blocked.html', 1, { root }), error => {
    assert.equal(error.code, 'shot_load_failed');
    assert.equal(error.details.status, 403);
    assert.equal(error.details.path, '.blocked.html');
    assert.match(error.details.url, /\/\.blocked.html\?mode=render$/);
    return true;
  });
});
async function fixture(t) {
  const work = createTempDirectory('multiplane-path-test-');
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = path.join(work, 'Long resource directory'), outside = path.join(work, 'outside');
  await mkdir(root); await mkdir(outside);
  for (const dir of [root, outside]) await writeFile(path.join(dir, 'shot.html'), html);
  return { work, root, outside };
}

test('canonical boundaries cover missing descendants, sibling prefixes and links inside/outside', async t => {
  const { root, outside } = await fixture(t);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets/ok.txt'), 'ok');
  await symlink(path.join(root, 'assets'), path.join(root, 'inside'), type);
  await symlink(outside, path.join(root, 'escape'), type);
  assert.equal(await isInsideResourceRoot(root, root), true);
  assert.equal(await isInsideResourceRoot(root, root + '-sibling/missing'), false);
  assert.equal(await isInsideResourceRoot(root, path.join(root, 'inside/missing/leaf')), true);
  assert.equal(await isInsideResourceRoot(root, path.join(root, 'escape/missing/leaf')), false);
  assert.equal(await normalizeResourcePath(path.join(root, 'inside/missing/leaf')), path.join(await normalizeResourcePath(root), 'assets/missing/leaf'));
  await assert.rejects(scanShot(path.join(root, 'escape/shot.html'), { root }), { code: 'shot_outside_root' });
  await assert.rejects(openShot(path.join(root, 'escape/shot.html'), 1, { root }), { code: 'shot_outside_root' });
  await assert.rejects(scanShot(path.join(root, 'missing/shot.html'), { root }), { code: 'shot_not_found' });
  await writeFile(path.join(root, 'resources.html'), html + '<img src="inside/ok.txt"><img src="escape/shot.html"><img src="escape/missing"><img src="inside/missing">');
  const lint = await scanShot('resources.html', { root });
  assert.equal(lint.findings.filter(f => f.code === 'resource_missing').length, 3);
  const server = await startServer(0, root); t.after(() => server.close());
  assert.equal(await (await fetch(server.url + '/inside/ok.txt')).text(), 'ok');
  assert.equal((await fetch(server.url + '/escape/missing')).status, 403);
  assert.equal((await fetch(server.url + '/inside/missing')).status, 404);
});

test('Windows comparison folds case and preserves cross-drive and UNC boundaries', () => {
  assert.equal(relativeResourcePath('C:\\Project', 'c:\\PROJECT\\shot.html', 'win32'), 'shot.html');
  assert.equal(path.win32.isAbsolute(relativeResourcePath('C:\\Project', 'D:\\Project\\shot.html', 'win32')), true);
  assert.equal(path.win32.isAbsolute(relativeResourcePath('\\\\server\\share\\root', '\\\\other\\share\\root\\shot.html', 'win32')), true);
  assert.equal(relativeResourcePath('/root', '/ROOT/shot.html', 'linux'), '../ROOT/shot.html');
});

test('real Windows short names work in lint, server and CLI rendering with identical pixels', { skip: process.platform !== 'win32' }, async t => {
  const { root, work } = await fixture(t);
  const short = windowsShortPath(root);
  if (!path.basename(short).includes('~')) { t.skip('The test volume has no 8.3 aliases'); return; }
  // This is the old lint comparison that rejected a valid shot before reading it.
  assert.ok(path.relative(await normalizeResourcePath(root), path.join(short, 'shot.html')).startsWith('..'));
  assert.equal(await normalizeResourcePath(short), await normalizeResourcePath(root));
  for (const [base, file] of [[short, path.join(short, 'shot.html')], [root, path.join(short, 'shot.html')], [short, path.join(root, 'shot.html')], [root.toUpperCase(), path.join(root.toLowerCase(), 'SHOT.HTML')]]) {
    assert.equal(await isInsideResourceRoot(base, file), true);
    assert.equal((await scanShot(file, { root: base })).data.errors, 0);
  }
  assert.equal(await isInsideResourceRoot(root, path.join(root, 'Missing/Leaf').toUpperCase()), true);
  const otherDrive = path.parse(root).root[0].toUpperCase() === 'Z' ? 'Y' : 'Z';
  assert.equal(await isInsideResourceRoot(root, `${otherDrive}:\\missing\\shot.html`), false);
  const server = await startServer(0, short); t.after(() => server.close());
  assert.equal((await fetch(server.url + '/shot.html')).status, 200);
  let expected;
  for (const base of [root, short, root.toUpperCase()]) {
    const capture = await openShot(path.join(short, 'shot.html'), 1, { root: base, raster: 'software' });
    try { const png = await capture.frame(0.5); if (expected) assert.deepEqual(png, expected); else expected = png; }
    finally { await capture.close(); }
  }
  const result = await run(process.execPath, ['bin/multiplane', 'render', path.join(short, 'shot.html'), '--root', short, '--out', path.join(work, 'short.mp4'), '--job-dir', path.join(work, 'job'), '--raster', 'software', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
