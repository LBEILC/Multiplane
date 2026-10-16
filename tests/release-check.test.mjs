import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPackageFiles, missingReadmeLinks, validatePublishConfig } from '../tools/release-check.mjs';
import { checkReleaseNotes } from '../tools/release-check.mjs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import path from 'node:path';
import { note } from '../app/tests/release-notes-fake.mjs';

test('release notes preflight requires the current bilingual document', async ctx => {
  const root = createTempDirectory('multiplane-release-notes-');
  ctx.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs/release-notes'), { recursive: true });
  await assert.rejects(checkReleaseNotes(root, '0.3.8'), /ENOENT/);
  const file = path.join(root, 'docs/release-notes/0.3.8.json');
  await writeFile(file, JSON.stringify(note('0.3.8')));
  assert.equal(await checkReleaseNotes(root, '0.3.8'), '0.3.8');
  const value = note('0.3.8'); delete value.items[0].title.en;
  await writeFile(file, JSON.stringify(value)); await assert.rejects(checkReleaseNotes(root, '0.3.8'), /Invalid/);
  await writeFile(file, JSON.stringify(note('0.3.7'))); await assert.rejects(checkReleaseNotes(root, '0.3.8'), /Invalid/);
  await writeFile(file, '{'); await assert.rejects(checkReleaseNotes(root, '0.3.8'), SyntaxError);
});

test('publish configuration accepts the official public registry', () => {
  assert.doesNotThrow(() => validatePublishConfig({ publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' } }));
});

test('publish configuration rejects missing configuration and non-official registries', () => {
  for (const publishConfig of [undefined, null, {}, ...[
    'https://registry.npmmirror.com/', 'http://registry.npmjs.org/',
    'https://registry.npmjs.org.example.com/', 'https://registry.npmjs.org'
  ].map(registry => ({ registry, access: 'public' }))]) {
    assert.throws(() => validatePublishConfig({ publishConfig }), /publishConfig\.registry/);
  }
});

test('publish configuration requires explicit public access', () => {
  for (const access of [undefined, null, '', 'restricted', 'Public']) {
    assert.throws(() => validatePublishConfig({ publishConfig: { registry: 'https://registry.npmjs.org/', access } }), /publishConfig\.access/);
  }
});

test('release package rejects private trees but permits public protocol documents', () => {
  const forbidden = ['app/main.js', 'tests/test.mjs', 'out/movie.mp4', '.github/workflows/ci.yml', 'AGENTS.md', 'docs/requirements.md', 'docs/internal.md', 'docs/specs/task.md', 'docs/roles/engineering.md', 'docs/design.md', 'tools/reports/task.md'];
  assert.deepEqual(forbiddenPackageFiles(['src/index.mjs', 'docs/protocol.md', 'docs/protocol.zh-CN.md', ...forbidden]), forbidden);
});

test('README validation covers Markdown, reference and HTML links without flagging packaged targets', () => {
  const source = '[source](src/index.mjs#api) [directory](src/) [中文](README.zh-CN.md) [anchor](#usage) [remote](https://github.com/LBEILC/Multiplane/blob/main/docs/protocol.md)\n'
    + '[protocol](docs/protocol.md) ![image](app/image.svg)\n[reference]: docs/private.md\n<img src="app/other.svg">\n'
    + '```md\n[example](missing.md)\n```\n`[inline](missing.md)`';
  assert.deepEqual(missingReadmeLinks('README.md', source, ['src/index.mjs', 'README.zh-CN.md']), [
    'README.md: docs/protocol.md', 'README.md: app/image.svg', 'README.md: docs/private.md', 'README.md: app/other.svg'
  ]);
});

test('README validation resolves nested paths, encoded names and malformed escapes', () => {
  assert.deepEqual(missingReadmeLinks('examples/README.md', '[ok](../LICENSE) [encoded](my%20file.html) [escape](../../private) [bad](%ZZ)', ['LICENSE', 'examples/my file.html']), [
    'examples/README.md: ../../private', 'examples/README.md: %ZZ'
  ]);
});
