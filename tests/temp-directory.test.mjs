import { nativeRealpath } from '../tools/native-realpath.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizeResourcePath } from '../src/resource-path.mjs';
import { useShortTempDirectory } from './short-path.mjs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { createTempDirectory } from './helpers.mjs';
import { createTempDirectory as createAppTempDirectory } from '../app/tests/helpers.mjs';
import { isolateDevelopmentHome } from '../tools/development-home.mjs';
import { assertSkillIsolation, guardSkillProcesses } from './skill-isolation.mjs';
import { spawnSync as spawnSkillProcess } from 'node:child_process';

const forbidden = new Set(['tmpdir', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync']);

test('test commands always preload the isolated renderer home', async () => {
  for (const [manifest, preload] of [['../package.json', './tests/test-home.mjs'], ['../app/package.json', '../tests/test-home.mjs']]) {
    const pkg = JSON.parse(await readFile(new URL(manifest, import.meta.url), 'utf8'));
    assert.ok(pkg.scripts.test.includes(`--import ${preload}`));
  }
  const preload = await readFile(new URL('./test-home.mjs', import.meta.url), 'utf8');
  assert.match(preload, /process\.env\.MULTIPLANE_AGENT_HOME\s*=\s*createTempDirectory/);
  assert.match(preload, /guardSkillProcesses\(\)/);
});

test('skill subprocess isolation rejects explicit environments that bypass the preload', () => {
  guardSkillProcesses();
  for (const env of [{}, { MULTIPLANE_HOME: '/isolated' }, { MULTIPLANE_AGENT_HOME: '/isolated' }]) {
    assert.throws(() => assertSkillIsolation(['bin/multiplane', 'skill', 'install'], { env }), /require MULTIPLANE_HOME and MULTIPLANE_AGENT_HOME/);
  }
  assert.doesNotThrow(() => assertSkillIsolation(['bin/multiplane', 'skill', 'status'], { env: { MULTIPLANE_HOME: '/isolated', MULTIPLANE_AGENT_HOME: '/agents' } }));
  assert.throws(() => spawnSkillProcess(process.execPath, ['bin/multiplane', 'skill', 'install'], { env: { MULTIPLANE_HOME: '/isolated' } }), /require MULTIPLANE_HOME and MULTIPLANE_AGENT_HOME/);
});

test('development tools replace inherited homes unless explicitly opted in', async t => {
  const directory = createTempDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { MULTIPLANE_HOME: '/real-home' };
  const home = isolateDevelopmentHome('measurement', { directory, env, args: [] });
  assert.equal(home, path.join(directory, 'out/measurement/home'));
  assert.equal(env.MULTIPLANE_HOME, home);
  env.MULTIPLANE_HOME = '/explicit-home';
  assert.equal(isolateDevelopmentHome('measurement', { directory, env, args: ['--use-user-home'] }), '/explicit-home');
});

test('rendering tools have an isolated home in their local import graph', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const seen = new Map();
  async function isolated(file, ancestors = new Set()) {
    if (ancestors.has(file)) return false;
    if (seen.has(file)) return seen.get(file);
    const source = await readFile(file, 'utf8');
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    let direct = false;
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.name === 'isolateDevelopmentHome') direct = true;
      if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'MULTIPLANE_HOME' && node.value.type !== 'Identifier' || node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.property.name === 'MULTIPLANE_HOME') direct = true;
      // Object shorthand such as { MULTIPLANE_HOME: home } is an explicit override.
      if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'MULTIPLANE_HOME' && node.value.name !== 'undefined') direct = true;
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    }
    walk(tree);
    const chain = new Set([...ancestors, file]);
    for (const node of tree.body) if (!direct && node.type === 'ImportDeclaration' && node.source.value.startsWith('.') && node.source.value.endsWith('.mjs')) {
      const imported = path.resolve(path.dirname(file), node.source.value);
      if (imported.startsWith(path.join(root, 'tools') + path.sep) || imported.startsWith(path.join(root, 'app/tools') + path.sep)) direct = await isolated(imported, chain);
    }
    seen.set(file, direct); return direct;
  }
  const violations = [];
  for (const directory of ['tools', 'app/tools']) for (const name of await readdir(path.join(root, directory), { recursive: true })) {
    if (!name.endsWith('.mjs')) continue;
    const file = path.join(root, directory, name), source = await readFile(file, 'utf8');
    const renders = /(?:renderShot|verifyShot|stillsShot)\s*\(/.test(source)
      || /\b(?:spawn|run|bundledCommand)\s*\(/.test(source) && /['"](?:render|stills|verify)['"]/.test(source);
    if (renders && !await isolated(file)) violations.push(path.relative(root, file));
  }
  assert.deepEqual(violations, []);
});

for (const [name, create] of [['renderer', createTempDirectory], ['desktop', createAppTempDirectory]]) {
  test(`${name} temporary-directory helper expands the real Windows short system temp path`, { skip: process.platform !== 'win32' }, async t => {
    const fixture = await useShortTempDirectory(t);
    if (!fixture) return;
    const directory = create('child-');
    assert.equal(path.dirname(directory), fixture.long);
    assert.equal(directory, await normalizeResourcePath(directory));
    const target = create('target-'), link = path.join(fixture.short, 'alias');
    await symlink(target, link, 'junction');
    const linked = create(path.join(link, 'child-'));
    assert.equal(linked, await nativeRealpath(linked));
    assert.equal(path.dirname(linked), target);
  });
}

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
    assert.equal(directory, await nativeRealpath(directory));
    assert.equal(path.dirname(directory), target);
  }
});
