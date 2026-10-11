import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { createTempDirectory } from './helpers.mjs';
import { createTempDirectory as createAppTempDirectory } from '../app/tests/helpers.mjs';

const forbidden = new Set(['tmpdir', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync']);

function bypassesHelper(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let found = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    // Include imports/destructuring to catch aliases, and computed member access.
    if (node.type === 'ImportSpecifier' && forbidden.has(node.imported.name ?? node.imported.value)
      || node.type === 'MemberExpression' && forbidden.has(node.computed ? node.property.value : node.property.name)
      || node.type === 'Property' && forbidden.has(node.key.name ?? node.key.value)
      || node.type === 'CallExpression' && forbidden.has(node.callee.name)) found = true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return found;
}

test('temporary-directory policy detects direct calls and aliases, not comments or fixture strings', () => {
  for (const source of [
    'os.tmpdir()', 'fs.mkdtempSync(prefix)', "fs['mkdtemp'](prefix)",
    "import { mkdtemp as create } from 'node:fs/promises'; create(prefix)",
    "import { tmpdir as directory } from 'node:os'; directory()",
    'const { mkdtemp: create } = fs; create(prefix)', 'mkdtemp(prefix)',
  ]) assert.equal(bypassesHelper(source), true, source);
  assert.equal(bypassesHelper('// os.tmpdir()\nconst fixture = "mkdtemp(prefix)"; createTempDirectory();'), false);
});

test('all test sources use their shared canonical temporary-directory helper', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const exempt = new Set(['tests/helpers.mjs', 'app/tests/helpers.mjs']);
  const violations = [];
  async function scan(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await scan(relative);
      else if (/\.(?:mjs|cjs|js)$/.test(entry.name) && !exempt.has(relative)
        && bypassesHelper(await readFile(path.join(root, relative), 'utf8'))) violations.push(relative);
    }
  }
  await scan('tests');
  await scan('app/tests');
  assert.deepEqual(violations.sort(), [], `Use createTempDirectory from the local helpers.mjs:\n${violations.join('\n')}`);
});

test('both temporary-directory helpers resolve a linked parent immediately', async t => {
  const root = createTempDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = path.join(root, 'alias');
  const target = createTempDirectory(path.join(root, 'target-'));
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const create of [createTempDirectory, createAppTempDirectory]) {
    const directory = create(path.join(link, 'child-'));
    assert.equal(directory, await realpath(directory));
    assert.equal(path.dirname(directory), target);
  }
});
