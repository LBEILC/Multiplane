import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { exportPublic, resolveExportPaths } from '../tools/export-public.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-export-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source'), output = path.join(base, 'public'); await mkdir(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  git(['init', '--initial-branch=main']); git(['config', 'core.autocrlf', 'false']); git(['config', 'user.name', 'Test Author']); git(['config', 'user.email', 'test@example.invalid']);
  async function file(name, content) { const p = path.join(root, name); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, content); git(['add', '-f', '--', name]); }
  await file('docs/internal.md', '```forbidden\nprivate-sentinel\n秘密标记\n```\n');
  await file('README.md', '[Guide](docs/protocol.md)\n'); await file('docs/protocol.md', '# Public protocol\n');
  return { base, root, output, git, file };
}
test('exports only tracked, nonignored public files with one new commit and inherited author', async t => {
  const f = await fixture(t);
  for (const name of ['AGENTS.md', 'docs/requirements.md', 'docs/roles/a.md', 'docs/specs/a.md', 'docs/design.md', 'tools/reports/a.md', '.claude/settings.json']) await f.file(name, 'private-sentinel');
  await f.file('.gitignore', 'ignored.bin\n'); await f.file('ignored.bin', 'private-sentinel');
  await f.file('bin/command', '#!/usr/bin/env node\n'); f.git(['update-index', '--chmod=+x', '--', 'bin/command']);
  await writeFile(path.join(f.root, 'untracked.txt'), 'private-sentinel');
  const result = await exportPublic(f.root, f.output, () => {});
  assert.equal(result.count, 4);
  const git = args => execFileSync('git', args, { cwd: f.output, encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git(['rev-list', '--count', 'HEAD']), '1');
  assert.equal(git(['log', '-1', '--format=%s|%an|%ae']), 'Initial public release|Test Author|test@example.invalid');
  assert.equal(git(['remote']), '');
  assert.deepEqual(git(['ls-files']).split('\n'), ['.gitignore', 'README.md', 'bin/command', 'docs/protocol.md']);
  assert.match(git(['ls-files', '--stage', 'bin/command']), /^100755 /);
});
test('scans text and binary Unicode before creating output', async t => {
  for (const payload of ['PRIVATE-SENTINEL', Buffer.from('\0private-sentinel\0'), Buffer.from('\0秘密标记', 'utf8'), Buffer.from('秘密标记', 'utf16le')]) {
    const f = await fixture(t); await f.file('payload.bin', payload);
    await assert.rejects(exportPublic(f.root, f.output, () => {}), /payload.bin: rule [12]/);
    assert.ok(!(await readdir(f.base)).includes('public'));
  }
});
test('rejects inline, reference and HTML links outside the export set', async t => {
  for (const link of ['[private](docs/design.md)', '[private][id]\n[id]: docs/roles/a.md', '<a href="docs/specs/a.md">private</a>', '[missing](absent.md)']) {
    const f = await fixture(t); await f.file('README.md', link);
    await assert.rejects(exportPublic(f.root, f.output, () => {}), /Links outside/);
    assert.ok(!(await readdir(f.base)).includes('public'));
  }
});
test('rejects nonempty destinations without changing their contents', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(path.join(f.output, 'keep'), 'original');
  await assert.rejects(exportPublic(f.root, f.output, () => {}), /must be empty/);
  assert.equal(await readFile(path.join(f.output, 'keep'), 'utf8'), 'original');
  await assert.rejects(exportPublic(f.root, f.root), /ancestor/);
  await assert.rejects(exportPublic(f.root, f.base), /ancestor/);
});
test('resolves aliases above source and output, including nonexistent output descendants', async t => {
  const f = await fixture(t), link = path.join(f.base, 'alias');
  await symlink(f.base, link, process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(link, 'source');
  await assert.rejects(exportPublic(source, f.root), /ancestor/);
  await assert.rejects(exportPublic(f.root, source), /ancestor/);
  await assert.rejects(exportPublic(source, link), /ancestor/);
  const output = path.join(link, 'new', 'public');
  await exportPublic(source, output, () => {});
  assert.equal(await readFile(path.join(f.base, 'new/public/README.md'), 'utf8'), '[Guide](docs/protocol.md)\n');
  await exportPublic(source, output, () => {}, { message: 'Export via alias' });
  const outputLink = path.join(f.base, 'output-alias');
  await symlink(path.join(f.base, 'new/public'), outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  await exportPublic(source, outputLink, () => {}, { message: 'Export via output root alias' });
});

test('canonical path comparison handles Windows drive aliases, short names and casing on every host', async () => {
  const aliases = new Map([
    ['C:\\TEMP\\SOURCE', 'D:\\Temp\\source'],
    ['D:\\TEMP\\SOURCE', 'D:\\Temp\\source'],
    ['D:\\TEM~1\\SOURCE', 'D:\\Temp\\source'],
    ['C:\\TEMP', 'D:\\Temp'],
    ['D:\\TEM~1', 'D:\\Temp'],
    ['C:\\OTHER', 'C:\\Other']
  ]);
  const options = { paths: path.win32, canonical: async file => {
    const result = aliases.get(file.toUpperCase());
    if (!result) throw Object.assign(Error('Missing fixture path'), { code: 'ENOENT' });
    return result;
  } };
  for (const output of ['C:\\Temp\\source', 'D:\\Temp\\source', 'd:\\temp\\SOURCE', 'D:\\TEM~1\\source', 'C:\\Temp', 'D:\\TEM~1']) {
    await assert.rejects(resolveExportPaths('C:\\Temp\\source', output, options), /ancestor/);
  }
  assert.deepEqual(await resolveExportPaths('C:\\Temp\\source', 'C:\\Other\\new\\public', options), {
    root: 'D:\\Temp\\source', output: 'C:\\Other\\new\\public'
  });
  assert.deepEqual(await resolveExportPaths('C:\\Temp\\source', 'D:\\TEM~1\\source-other', options), {
    root: 'D:\\Temp\\source', output: 'D:\\Temp\\source-other'
  });
});

test('rejects tracked source directory junctions beneath the canonical root', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside'); await mkdir(outside);
  await f.file('nested/item.txt', 'safe');
  await rm(path.join(f.root, 'nested'), { recursive: true });
  await writeFile(path.join(outside, 'item.txt'), 'safe');
  await symlink(outside, path.join(f.root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportPublic(f.root, f.output), /Symbolic links/);
});
test('rejects junctions inside the public repository without changing their targets', async t => {
  for (const name of ['docs', '.git']) {
    const f = await fixture(t);
    await exportPublic(f.root, f.output, () => {});
    const original = path.join(f.output, name), outside = path.join(f.base, 'outside');
    await rename(original, outside);
    await symlink(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
    const file = path.join(outside, name === '.git' ? 'index' : 'protocol.md');
    const before = await readFile(file);
    // POSIX Git reports the directory-to-symlink change before file validation.
    await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'Update' }), /Symbolic links|clean working tree/);
    assert.deepEqual(await readFile(file), before);
  }
});

test('rejects indexed symlinks even when Windows checks them out as plain text', async t => {
  const f = await fixture(t); await f.file('link', 'README.md');
  const hash = f.git(['hash-object', 'link']).trim();
  f.git(['update-index', '--cacheinfo', `120000,${hash},link`]);
  await assert.rejects(exportPublic(f.root, f.output), /Symbolic links/);
});

test('incremental export preserves history and remote, synchronizes additions, changes and removals', async t => {
  const f = await fixture(t);
  await f.file('obsolete.txt', 'old'); await f.file('.github/workflows/ci.yml', 'name: test\n');
  const first = await exportPublic(f.root, f.output, () => {});
  const git = args => execFileSync('git', args, { cwd: f.output, encoding: 'utf8', windowsHide: true }).trim();
  git(['remote', 'add', 'origin', 'https://example.invalid/public.git']);
  f.git(['rm', '-f', '--', 'obsolete.txt']);
  await f.file('added.txt', 'new'); await f.file('docs/protocol.md', '# Revised\n');
  await exportPublic(f.root, f.output, () => {}, { message: 'Update public files' });
  assert.equal(git(['rev-parse', 'HEAD^']), first.commit);
  assert.equal(git(['log', '-1', '--format=%s']), 'Update public files');
  assert.equal(git(['remote', 'get-url', 'origin']), 'https://example.invalid/public.git');
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(f.output, 'added.txt'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(f.output, 'docs/protocol.md'), 'utf8'), '# Revised\n');
  assert.ok(!(await readdir(f.output)).includes('obsolete.txt'));
  assert.equal(await readFile(path.join(f.output, '.github/workflows/ci.yml'), 'utf8'), 'name: test\n');
});

test('incremental validation failures leave target files and history untouched', async t => {
  const f = await fixture(t); const first = await exportPublic(f.root, f.output, () => {});
  const git = args => execFileSync('git', args, { cwd: f.output, encoding: 'utf8', windowsHide: true }).trim();
  for (const message of [undefined, '', '   ']) await assert.rejects(exportPublic(f.root, f.output, () => {}, { message }), /nonempty --message/);
  await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'private-sentinel' }), /Public scan failed: commit message/);
  await f.file('.github/workflows/ci.yml', 'private-sentinel');
  await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'Update' }), /Public scan failed/);
  await f.file('.github/workflows/ci.yml', 'name: safe');
  await f.file('README.md', '[missing](missing.md)');
  await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'Update' }), /Links outside/);
  assert.equal(git(['rev-parse', 'HEAD']), first.commit);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(f.output, 'README.md'), 'utf8'), '[Guide](docs/protocol.md)\n');
  await writeFile(path.join(f.output, 'local.txt'), 'keep');
  await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'Update' }), /clean working tree/);
});

test('incremental export supports file/directory transitions and preserves ignored build products', async t => {
  const f = await fixture(t); await f.file('shape', 'file'); await f.file('.gitignore', 'build/\n');
  await exportPublic(f.root, f.output, () => {});
  await mkdir(path.join(f.output, 'build')); await writeFile(path.join(f.output, 'build/local'), 'keep');
  f.git(['rm', '-f', '--', 'shape']); await f.file('shape/item', 'nested');
  await exportPublic(f.root, f.output, () => {}, { message: 'File to directory' });
  assert.equal(await readFile(path.join(f.output, 'shape/item'), 'utf8'), 'nested');
  f.git(['rm', '-f', '--', 'shape/item']); await rm(path.join(f.root, 'shape'), { recursive: true, force: true }); await f.file('shape', 'flat');
  await exportPublic(f.root, f.output, () => {}, { message: 'Directory to file' });
  assert.equal(await readFile(path.join(f.output, 'shape'), 'utf8'), 'flat');
  assert.equal(await readFile(path.join(f.output, 'build/local'), 'utf8'), 'keep');
  await f.file('build/local', 'replace');
  // The source .gitignore intentionally excludes build, so make it public first.
  await f.file('.gitignore', '');
  const before = await readFile(path.join(f.output, '.git/index'));
  await assert.rejects(exportPublic(f.root, f.output, () => {}, { message: 'Conflict' }), /untracked file/);
  assert.deepEqual(await readFile(path.join(f.output, '.git/index')), before);
  assert.equal(await readFile(path.join(f.output, 'build/local'), 'utf8'), 'keep');
});
