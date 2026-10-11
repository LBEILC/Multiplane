import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPackageFiles, missingReadmeLinks } from '../tools/release-check.mjs';

test('release package rejects private trees but permits public protocol documents', () => {
  const forbidden = ['app/main.js', 'tests/test.mjs', 'out/movie.mp4', '.github/workflows/ci.yml', 'docs/internal.md', 'docs/specs/task.md'];
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
