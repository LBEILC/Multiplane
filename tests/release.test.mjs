import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { release, steps, artifactNames, checkArtifacts, checkDesignFiles, validationPlan, dependencyChange } from '../tools/release.mjs';

async function fixture(t, completed = ['prepare', 'preflight']) {
  const root = createTempDirectory('release-pipeline-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'out/release-1.2.3'), worktree = path.join(output, 'worktree');
  await mkdir(path.join(worktree, 'app/node_modules'), { recursive: true });
  await writeFile(path.join(worktree, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const state = { root, version: '1.2.3', worktree, publicRepo: path.join(root, 'public'), notes: path.join(root, 'notes.md'), completed, commit: 'a'.repeat(40), publicCommit: 'c'.repeat(40), runs: {}, branch: 'release/1.2.3', installed: true, plan: { renderer: true, app: true, tests: [] } };
  const stateFile = path.join(output, 'state.json');
  await writeFile(stateFile, JSON.stringify(state));
  for (const file of ['package-lock.json', 'app/package.json', 'app/package-lock.json']) await writeFile(path.join(worktree, file), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  await mkdir(path.join(worktree, 'docs/release-notes'), { recursive: true });
  await writeFile(path.join(worktree, 'docs/release-notes/1.2.3.json'), JSON.stringify({ schema: 'multiplane-release-notes/1', version: '1.2.3', date: '2026-10-16', items: [] }));
  const calls = [], base = 'b'.repeat(40); let head = base, remote = base, temporary = '';
  const execute = async (file, args, config) => {
    calls.push({ file, args, cwd: config.cwd });
    let stdout = '';
    if (file === 'git') {
      const text = args.join(' ');
      if (text === 'rev-parse HEAD') stdout = config.cwd === state.publicRepo ? head : state.commit;
      else if (text === 'rev-parse HEAD^') stdout = base;
      else if (args[0] === 'rev-parse') stdout = state.commit;
      else if (args[0] === 'config') stdout = '1';
      else if (args[0] === 'remote') stdout = 'https://github.com/LBEILC/Multiplane';
      else if (args[0] === 'branch') stdout = config.cwd === state.publicRepo ? 'main' : '';
      else if (args[0] === 'ls-remote') stdout = (args.at(-1).endsWith('/main') ? remote : temporary) + '\t' + args.at(-1);
      else if (args[0] === 'push' && args.at(-1).endsWith(':refs/heads/main')) remote = head;
      else if (args[0] === 'push' && args.at(-1).startsWith('HEAD:')) temporary = head;
      else if (args[0] === 'tag') stdout = 'v1.2.2';
      else if (args[0] === 'show') stdout = JSON.stringify({ version: '1.2.2' });
      else if (args[0] === 'reset') head = base;
      else if (args[0] === 'worktree') stdout = `worktree ${worktree.replaceAll('\\', '/')}\nHEAD ${state.commit}\n`;
    }
    if (args.includes('--skip-tests')) head = state.publicCommit;
    if (args.includes('--scan-only')) stdout = JSON.stringify({ files: [] });
    if (file === 'gh' && args[1] === 'list') stdout = JSON.stringify([{ databaseId: args.includes('main') ? 13 : args.includes('ci.yml') ? 11 : 12, headSha: state.publicCommit, createdAt: '9999-01-01T00:00:00Z', status: 'in_progress' }]);
    if (file === 'gh' && args[1] === 'view') stdout = JSON.stringify({ headSha: state.publicCommit, headBranch: state.branch, status: 'completed', conclusion: 'success' });
    return { code: 0, stdout };
  };
  return { root, output, worktree, state, stateFile, calls, execute, head: () => head,
    options: { root, output, version: state.version }, read: async () => JSON.parse(await readFile(stateFile, 'utf8')) };
}

for (const failure of ['export', 'design']) test(`${failure} failure rolls back export and never pushes`, async t => {
  const f = await fixture(t);
  const execute = async (...args) => {
    const result = await f.execute(...args);
    if (failure === 'export' && args[1].includes('--skip-tests')) throw Error('Export test failed');
    if (failure === 'design' && args[1][0] === 'ls-tree') result.stdout = 'app/design/tokens.css\0app/design/icons/app.svg\0app/design/preview-new.js\0';
    return result;
  };
  await assert.rejects(release(f.options, { execute, log() {} }), failure === 'export' ? /Export test failed/ : /Forbidden design/);
  assert.equal(f.head(), 'b'.repeat(40));
  assert.ok(f.calls.some(call => call.args[0] === 'reset'));
  assert.ok(!f.calls.some(call => call.file === 'gh' || call.args[0] === 'push'));
  assert.equal((await f.read()).status, 'failed');
  assert.equal((await f.read()).current, 'export');
});

test('design boundary allows only icons and tokens', () => {
  checkDesignFiles(['app/design/tokens.css', 'app/design/icons/nested/a.svg']);
  for (const name of ['tokens.css.bak', 'icons-old/a.svg', 'arbitrary.js', '界面稿.js', 'new\nfile.js']) assert.throws(() => checkDesignFiles(['app/design/' + name]), /Forbidden/);
});

test('rollback refuses to discard an export that reached the remote', async t => {
  const f = await fixture(t); let exported = false;
  await assert.rejects(release(f.options, { log() {}, execute: async (...args) => {
    const result = await f.execute(...args);
    if (args[1].includes('--skip-tests')) { exported = true; throw Error('validation failed'); }
    if (exported && args[1][0] === 'ls-remote') result.stdout = f.state.publicCommit + '\trefs/heads/main';
    return result;
  } }), /Remote changed; refusing rollback/);
  assert.ok(!f.calls.some(call => call.args[0] === 'reset' || call.args[0] === 'push'));
  assert.equal((await f.read()).exportPending, true);
});

test('interrupted export rolls back its pending commit before retrying', async t => {
  const f = await fixture(t);
  await f.execute(process.execPath, ['--skip-tests'], { cwd: f.worktree });
  f.state.exportBase = 'b'.repeat(40); f.state.exportPending = true;
  await writeFile(f.stateFile, JSON.stringify(f.state)); f.calls.length = 0;
  await release({ ...f.options, step: 'export' }, { execute: f.execute, log() {} });
  const reset = f.calls.findIndex(call => call.args[0] === 'reset');
  const retry = f.calls.findIndex(call => call.args.includes('--skip-tests'));
  assert.ok(reset >= 0 && reset < retry);
  assert.equal((await f.read()).exportPending, false);
  assert.ok(!f.calls.some(call => call.args[0] === 'push'));
});

test('a concurrent release cannot enter the pipeline', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.output, 'running.lock'), String(process.pid));
  await assert.rejects(release(f.options, { execute: f.execute, log() {} }), /locked/);
  assert.equal(f.calls.length, 0);
});

for (const failedWorkflow of ['ci.yml', 'release.yml']) test(`${failedWorkflow} failure stops even while the other run is active`, async t => {
  const f = await fixture(t, ['prepare', 'preflight', 'export']);
  const execute = async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (file === 'git' && config.cwd === f.state.publicRepo && (args[0] === 'ls-remote' || args.join(' ') === 'rev-parse HEAD')) result.stdout = f.state.publicCommit + (args[0] === 'ls-remote' ? '\trefs/heads/main' : '');
    if (file === 'gh' && args[1] === 'list') result.stdout = JSON.stringify([{ databaseId: args.includes('ci.yml') ? 11 : 12, headSha: f.state.publicCommit, createdAt: '9999-01-01T00:00:00Z' }]);
    if (file === 'gh' && args[1] === 'view' && args.includes('--json')) {
      const failed = args[2] === (failedWorkflow === 'ci.yml' ? '11' : '12');
      result.stdout = JSON.stringify({ headSha: f.state.publicCommit, headBranch: f.state.branch, status: failed ? 'completed' : 'in_progress', conclusion: failed ? 'failure' : null, jobs: [{ name: 'Windows tests', conclusion: 'failure' }], url: 'https://example.invalid/run' });
    }
    return result;
  };
  await assert.rejects(release(f.options, { execute, log() {}, sleep() { assert.fail('A failed workflow must stop polling'); } }), /Windows tests/);
  assert.deepEqual((await f.read()).runs, { 'ci.yml': 11, 'release.yml': 12 });
  assert.ok(!f.calls.some(call => call.args.includes('download') || call.args.includes('create')));
  assert.ok(f.calls.some(call => call.args.includes('--log-failed')));
  assert.ok(!f.calls.some(call => call.args.some(arg => arg.endsWith(':refs/heads/main'))));
});

test('verification stops at the first failed command and resumes that step', async t => {
  const f = await fixture(t, ['prepare', 'preflight']); let fail = true;
  const execute = async (...args) => { const result = await f.execute(...args); if (fail && args[0] === 'npm' && args[1].includes('test:full')) throw Error('full failed'); return result; };
  await assert.rejects(release({ ...f.options, to: 'verify' }, { execute, log() {} }), /full failed/);
  assert.equal(f.calls.filter(call => call.file === 'npm').length, 1);
  fail = false; f.calls.length = 0;
  await release({ ...f.options, to: 'verify' }, { execute, log() {} });
  assert.deepEqual(f.calls.filter(call => call.file !== 'git').map(call => call.args), [
    ['run', 'test:full'], ['--prefix', 'app', 'test'], ['--prefix', 'app', 'run', 'dist'], ['app/tools/verify-hosted.mjs'], ['run', 'release:check'],
  ]);
  assert.deepEqual((await f.read()).completed, ['prepare', 'preflight', 'verify']);
});

test('verification resumes at a failed hosted check without repeating passed tests or packaging', async t => {
  const f = await fixture(t, ['prepare', 'preflight']); let fail = true;
  const execute = async (...args) => { const result = await f.execute(...args); if (fail && args[1].includes('app/tools/verify-hosted.mjs')) throw Error('hosted failed'); return result; };
  await assert.rejects(release({ ...f.options, to: 'verify' }, { execute, log() {} }), /hosted failed/);
  assert.deepEqual((await f.read()).verified, ['verify-full', 'verify-app', 'verify-package']);
  assert.equal((await f.read()).verifying, 'verify-hosted');
  assert.ok(!f.calls.some(call => call.args.includes('release:check')));
  fail = false; f.calls.length = 0;
  await release({ ...f.options, to: 'verify' }, { execute, log() {} });
  assert.deepEqual(f.calls.filter(call => call.file !== 'git').map(call => call.args), [['app/tools/verify-hosted.mjs'], ['run', 'release:check']]);
});

test('missing prerequisites and dirty source never execute verification', async t => {
  const f = await fixture(t, []);
  await assert.rejects(release({ ...f.options, step: 'verify' }, { execute: f.execute, log() {} }), /Prerequisite/);
  f.state.completed = ['prepare', 'preflight']; await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release({ ...f.options, step: 'verify' }, { execute: async (...args) => { const result = await f.execute(...args); if (args[1][0] === 'status') result.stdout = ' M source.mjs'; return result; }, log() {} }), /not clean/);
  assert.ok(!f.calls.some(call => call.file === 'npm'));
});

test('verification rejects linked app dependencies before running app installation', async t => {
  const f = await fixture(t, []);
  f.state.installed = true; await writeFile(f.stateFile, JSON.stringify(f.state));
  const target = path.join(f.root, 'shared'); await mkdir(target);
  await rm(path.join(f.worktree, 'app/node_modules'), { recursive: true });
  await symlink(target, path.join(f.worktree, 'app/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(release({ ...f.options, to: 'verify' }, { execute: f.execute, log() {} }), /locally installed/);
  assert.ok(!f.calls.some(call => call.cwd === path.join(f.worktree, 'app')));
});

test('artifact verification requires all six files and authentic metadata', async t => {
  const f = await fixture(t); const directory = path.join(f.output, 'final'); await mkdir(directory);
  const bytes = Buffer.from('installer'), sha = createHash('sha512').update(bytes).digest('base64');
  const names = artifactNames('1.2.3');
  for (const name of names) await writeFile(path.join(directory, name), bytes);
  const metadata = `version: 1.2.3\nfiles:\n  - url: ${names[0]}\n    sha512: ${sha}\n    size: ${bytes.length}\npath: ${names[0]}\nsha512: ${sha}\n`;
  await writeFile(path.join(directory, 'latest.yml'), metadata);
  assert.equal(Object.keys(await checkArtifacts(directory, '1.2.3')).length, 6);
  await writeFile(path.join(directory, names[0]), 'tampered');
  await assert.rejects(checkArtifacts(directory, '1.2.3'), /SHA-512/);
  await writeFile(path.join(directory, names[0]), bytes);
  await rm(path.join(directory, names[5]));
  await assert.rejects(checkArtifacts(directory, '1.2.3'), /ENOENT/);
});

test('a changed or mismatched CI commit cannot reach artifact download', async t => {
  const f = await fixture(t, steps.slice(0, 6)); f.state.runs = { 'ci.yml': 11, 'release.yml': 12 };
  await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release(f.options, { execute: async (...args) => { const result = await f.execute(...args); if (args[0] === 'gh') result.stdout = JSON.stringify({ headSha: 'wrong', status: 'completed', conclusion: 'success' }); return result; }, log() {} }), /Wrong commit/);
  assert.ok(!f.calls.some(call => call.args.includes('download')));
});

test('successful export through draft collects seven verified assets and resumes without re-creating', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.worktree, 'docs/release-notes'), { recursive: true });
  await writeFile(path.join(f.worktree, 'docs/release-notes/1.2.3.json'), '{}');
  await writeFile(f.state.notes, 'Release body\n');
  let draft;
  const execute = async (file, args, config) => {
    const result = await f.execute(file, args, config);

    if (file === 'gh' && args[1] === 'list') result.stdout = JSON.stringify([{ databaseId: args.includes('ci.yml') ? 11 : 12, headSha: f.state.publicCommit, createdAt: '9999-01-01T00:00:00Z' }]);
    if (file === 'gh' && args[1] === 'view') result.stdout = JSON.stringify({ headSha: f.state.publicCommit, headBranch: f.state.branch, status: 'completed', conclusion: 'success' });
    if (file === 'gh' && args[1] === 'download') {
      const dir = args[args.indexOf('--dir') + 1];
      const bytes = Buffer.from('installer');
      for (const name of artifactNames('1.2.3')) await writeFile(path.join(dir, name), bytes);
      const sha = createHash('sha512').update(bytes).digest('base64');
      await writeFile(path.join(dir, 'latest.yml'), `version: 1.2.3\nfiles:\n  - url: Multiplane-Setup-1.2.3-x64.exe\n    sha512: ${sha}\n    size: ${bytes.length}\npath: Multiplane-Setup-1.2.3-x64.exe\nsha512: ${sha}\n`);
    }
    if (file === 'gh' && args[1] === 'create') {
      assert.ok(args.includes('--draft'));
      assert.equal(args[args.indexOf('--target') + 1], f.state.publicCommit);
      const assets = [];
      for (const name of [...artifactNames('1.2.3'), 'release-notes.json']) {
        const artifact = path.join(f.output, 'final', name); assert.ok(args.includes(artifact));
        assets.push({ name, digest: 'sha256:' + createHash('sha256').update(await readFile(artifact)).digest('hex') });
      }
      draft = { tag_name: 'v1.2.3', draft: true, target_commitish: f.state.publicCommit, body: 'Release body\n', assets, html_url: 'https://example.invalid/draft' };
    }
    if (file === 'gh' && args[0] === 'api') { assert.ok(!args.includes('-R')); result.stdout = JSON.stringify([draft ? [draft] : []]); }
    return result;
  };
  const state = await release(f.options, { execute, log() {}, sleep() {} });
  assert.deepEqual(state.completed, steps);
  assert.equal(Object.keys(state.hashes).length, 7);
  assert.match(await readFile(path.join(f.output, 'SHA256.md'), 'utf8'), /release-notes.json/);
  f.calls.length = 0;
  await release(f.options, { execute, log() {} });
  assert.equal(f.calls.length, 0);
  // Simulate interruption after GitHub created the draft but before saving completion.
  state.completed.pop(); await writeFile(f.stateFile, JSON.stringify(state));
  await release(f.options, { execute, log() {} });
  assert.ok(!f.calls.some(call => call.args.includes('create')));
});

test('release subprocesses override inherited homes without mutating the parent', async t => {
  const f = await fixture(t, ['prepare', 'preflight']);
  const before = { home: process.env.MULTIPLANE_HOME, agents: process.env.MULTIPLANE_AGENT_HOME };
  let commands = 0;
  await release({ ...f.options, to: 'verify' }, { log() {}, execute: async (file, args, config) => {
    assert.equal(config.env.MULTIPLANE_HOME, path.join(f.output, 'home'));
    assert.equal(config.env.MULTIPLANE_AGENT_HOME, path.join(f.output, 'agent-home'));
    assert.notEqual(config.env, process.env);
    commands++;
    return f.execute(file, args, config);
  } });
  assert.ok(commands > 0);
  assert.deepEqual({ home: process.env.MULTIPLANE_HOME, agents: process.env.MULTIPLANE_AGENT_HOME }, before);
});

for (const changed of ['app/src/main/example.mjs', 'src/capture.mjs']) test(`scope selects local full suite for ${changed}`, async t => {
  const f = await fixture(t, ['prepare']);
  const tree = hash => `100644 blob ${hash.repeat(40)}\t${changed}\0`;
  const state = await release({ ...f.options, to: 'verify' }, { log() {}, execute: async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (args.includes('--scan-only')) result.stdout = JSON.stringify({ files: [changed] });
    if (args[0] === 'ls-tree') result.stdout = tree(config.cwd === f.state.publicRepo ? 'a' : 'b');
    return result;
  } });
  assert.equal(f.calls.some(call => call.args.includes('test:full')), changed.startsWith('src/'));
  assert.deepEqual(state.scope.files, [changed]);
  assert.ok(f.calls.some(call => call.args.includes('dist')));
});

test('test-only release baseline runs the changed file without the full suite', async t => {
  const f = await fixture(t, ['prepare']);
  const changed = 'tests/static-reuse.test.mjs';
  await mkdir(path.join(f.worktree, 'tests'));
  await writeFile(path.join(f.worktree, changed), '');
  const state = await release({ ...f.options, to: 'verify' }, { log() {}, execute: async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (args.includes('--scan-only')) result.stdout = JSON.stringify({ files: [changed] });
    if (args[0] === 'ls-tree') result.stdout = `100644 blob ${(config.cwd === f.state.publicRepo ? 'a' : 'b').repeat(40)}\t${changed}\0`;
    return result;
  } });
  assert.deepEqual(state.scope.files, [changed]);
  assert.equal(state.scope.retry, false);
  assert.equal(state.scope.renderer, false);
  assert.deepEqual(state.scope.tests, [changed]);
  assert.ok(!f.calls.some(call => call.args.includes('test:full')));
  assert.deepEqual(f.calls.filter(call => call.args.includes('--test')).map(call => call.args), [
    ['--import', './tests/test-home.mjs', '--test', changed],
  ]);
  assert.deepEqual(f.calls.filter(call => call.file === 'npm').map(call => call.args), [
    ['--prefix', 'app', 'test'], ['--prefix', 'app', 'run', 'dist'], ['run', 'release:check'],
  ]);
  assert.ok(f.calls.some(call => call.args.includes('app/tools/verify-hosted.mjs')));
});

test('public scan failure stops before installation, tests, export or push', async t => {
  const f = await fixture(t, []);
  await assert.rejects(release(f.options, { log() {}, execute: async (...args) => {
    const result = await f.execute(...args);
    if (args[1].includes('--scan-only')) throw Error('Public scan failed: forbidden sentinel');
    return result;
  } }), /Public scan failed/);
  assert.ok(!f.calls.some(call => call.file === 'npm' || call.file === 'gh' || call.args.includes('--skip-tests')));
});

test('remote workflows start before local tests and promotion uses their exact commit', async t => {
  const f = await fixture(t);
  await release({ ...f.options, to: 'promote' }, { execute: f.execute, log() {}, sleep() {} });
  const dispatch = f.calls.findIndex(call => call.args[0] === 'workflow');
  const local = f.calls.findIndex(call => call.args.includes('test:full'));
  const success = f.calls.findIndex(call => call.args[1] === 'view');
  const promote = f.calls.findIndex(call => call.args.includes(`${f.state.publicCommit}:refs/heads/main`));
  assert.ok(dispatch >= 0 && dispatch < local && local < success && success < promote);
  assert.ok(f.calls.some(call => call.args[0] === 'merge' && call.args[1] === '--ff-only' && call.args[2] === f.state.publicCommit));
  assert.ok(f.calls.some(call => call.args[1] === 'cancel' && call.args[2] === '13'));
  assert.ok(f.calls.some(call => call.args.includes('--delete') && call.args.includes(f.state.branch)));
});

test('local failure cancels remote work and never updates main', async t => {
  const f = await fixture(t);
  await assert.rejects(release(f.options, { log() {}, execute: async (...args) => {
    const result = await f.execute(...args);
    if (args[1].includes('test:full')) throw Error('local failed');
    if (args[0] === 'gh' && args[1][1] === 'view') result.stdout = JSON.stringify({ headSha: f.state.publicCommit, headBranch: f.state.branch, status: 'in_progress' });
    return result;
  } }), /local failed/);
  assert.equal(f.calls.filter(call => call.args[1] === 'cancel').length, 2);
  assert.ok(!f.calls.some(call => call.args.some(arg => arg.endsWith(':refs/heads/main'))));
});

test('test-only source revision reruns only the changed test and cheap checks', async t => {
  const f = await fixture(t, ['prepare', 'preflight', 'verify']);
  f.state.verified = ['verify-full', 'verify-app', 'verify-package', 'verify-hosted', 'verify-release'];
  await writeFile(f.stateFile, JSON.stringify(f.state));
  const changed = 'tests/example.test.mjs';
  await mkdir(path.join(f.worktree, 'tests'));
  await writeFile(path.join(f.worktree, changed), '');
  const next = 'd'.repeat(40);
  await release({ ...f.options, commit: next, to: 'verify' }, { log() {}, execute: async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (args[0] === 'rev-parse' && args.includes('--verify')) result.stdout = next;
    if (args[0] === 'diff') result.stdout = changed + '\0';
    if (args[0] === 'checkout' && args.includes('--detach')) f.state.commit = next;
    return result;
  } });
  const checks = f.calls.filter(call => call.file === 'npm' || call.args.includes('--test'));
  assert.deepEqual(checks.map(call => call.args), [['--import', './tests/test-home.mjs', '--test', changed], ['run', 'release:check']]);
  assert.equal((await f.read()).previousCommit, 'a'.repeat(40));
});

test('documentation fix preserves passed checks while retrying the failed hosted check', async t => {
  const f = await fixture(t, ['prepare', 'preflight']);
  f.state.verified = ['verify-full', 'verify-app', 'verify-package'];
  await writeFile(f.stateFile, JSON.stringify(f.state));
  const next = 'e'.repeat(40);
  await release({ ...f.options, commit: next, to: 'verify' }, { log() {}, execute: async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (args[0] === 'rev-parse' && args.includes('--verify')) result.stdout = next;
    if (args[0] === 'diff') result.stdout = 'README.md\0';
    if (args[0] === 'checkout' && args.includes('--detach')) f.state.commit = next;
    return result;
  } });
  assert.deepEqual(f.calls.filter(call => call.file === 'npm' || call.args.includes('app/tools/verify-hosted.mjs')).map(call => call.args), [['app/tools/verify-hosted.mjs'], ['run', 'release:check']]);
});

test('collect rejects a successful run from another branch', async t => {
  const f = await fixture(t, steps.slice(0, 6));
  f.state.runs = { 'ci.yml': 11, 'release.yml': 12 };
  await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release(f.options, { log() {}, execute: async (...args) => {
    const result = await f.execute(...args);
    if (args[0] === 'gh') result.stdout = JSON.stringify({ headSha: f.state.publicCommit, headBranch: 'main', status: 'completed', conclusion: 'success' });
    return result;
  } }), /Wrong branch/);
  assert.ok(!f.calls.some(call => call.args.includes('download')));
});

test('scope includes renderer dependencies and tests but ignores version-only changes', () => {
  assert.equal(dependencyChange({ version: '1.2.2', dependencies: { a: '1' } }, { version: '1.2.3', dependencies: { a: '1' } }), false);
  assert.equal(dependencyChange({ dependencies: { a: '1' } }, { dependencies: { a: '2' } }), true);
  for (const retry of [false, true]) {
    for (const file of ['src/capture.mjs', 'bin/multiplane', 'skills/multiplane/SKILL.md', 'tests/helpers.mjs', 'tools/test-suite.mjs', 'tools/install-browser.mjs', 'tools/process.mjs']) assert.equal(validationPlan([file], { retry }).renderer, true);
    const plan = validationPlan(['tests/render.test.mjs'], { retry });
    assert.equal(plan.renderer, false);
    assert.deepEqual(plan.tests, ['tests/render.test.mjs']);
  }
  assert.equal(validationPlan(['package.json'], { dependencies: true }).renderer, true);
  assert.equal(validationPlan(['README.md', 'app/src/main/index.ts']).renderer, false);
  assert.equal(validationPlan(['tests/render.test.mjs'], { retry: true }).renderer, false);
  assert.equal(validationPlan(['app/package.json'], { retry: true }).app, true);
});

test('promotion stops if public main changed while validation was running', async t => {
  const f = await fixture(t, steps.slice(0, 5));
  f.state.validatedCommit = f.state.commit; f.state.exportBase = 'b'.repeat(40);
  f.state.runs = { 'ci.yml': 11, 'release.yml': 12 };
  await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release({ ...f.options, step: 'promote' }, { log() {}, execute: async (...args) => {
    const result = await f.execute(...args);
    if (args[1][0] === 'ls-remote' && args[1].includes('refs/heads/main')) result.stdout = 'd'.repeat(40) + '\trefs/heads/main';
    return result;
  } }), /Remote main changed/);
  assert.ok(!f.calls.some(call => call.args[0] === 'push' || call.args[0] === 'merge'));
});

test('same-commit resume reruns cancelled workflows and preserves passed local checks', async t => {
  const f = await fixture(t);
  let failure = true;
  const execute = async (...args) => {
    const result = await f.execute(...args);
    if (failure && args[1].includes('app/tools/verify-hosted.mjs')) throw Error('hosted failed');
    if (args[0] === 'gh' && args[1][1] === 'view') result.stdout = JSON.stringify({ headSha: f.state.publicCommit, headBranch: f.state.branch, status: failure ? 'in_progress' : 'completed', conclusion: failure ? null : 'cancelled' });
    return result;
  };
  await assert.rejects(release({ ...f.options, to: 'promote' }, { execute, log() {} }), /hosted failed/);
  failure = false; f.calls.length = 0;
  await release({ ...f.options, step: 'push' }, { execute, log() {}, sleep() {} });
  assert.equal(f.calls.filter(call => call.args[1] === 'rerun').length, 2);
  await release({ ...f.options, step: 'verify' }, { execute, log() {} });
  assert.deepEqual(f.calls.filter(call => call.file === 'npm' || call.args.includes('app/tools/verify-hosted.mjs')).map(call => call.args), [['app/tools/verify-hosted.mjs'], ['run', 'release:check']]);
});
