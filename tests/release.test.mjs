import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { release, steps, artifactNames, checkArtifacts, checkDesignFiles } from '../tools/release.mjs';

async function fixture(t, completed = ['prepare', 'verify']) {
  const root = createTempDirectory('release-pipeline-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'out/release-1.2.3'), worktree = path.join(output, 'worktree');
  await mkdir(path.join(worktree, 'app/node_modules'), { recursive: true });
  await writeFile(path.join(worktree, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const state = { root, version: '1.2.3', worktree, publicRepo: path.join(root, 'public'), notes: path.join(root, 'notes.md'), completed, commit: 'a'.repeat(40), publicCommit: 'c'.repeat(40), runs: {} };
  const stateFile = path.join(output, 'state.json');
  await writeFile(stateFile, JSON.stringify(state));
  const calls = [], base = 'b'.repeat(40); let head = base;
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
      else if (args[0] === 'ls-remote') stdout = base + '\trefs/heads/main';
      else if (args[0] === 'reset') head = base;
      else if (args[0] === 'worktree') stdout = `worktree ${worktree.replaceAll('\\', '/')}\nHEAD ${state.commit}\n`;
    }
    if (file === 'npm' && args.includes('export:public')) head = state.publicCommit;
    return { code: 0, stdout };
  };
  return { root, output, worktree, state, stateFile, calls, execute, head: () => head,
    options: { root, output, version: state.version }, read: async () => JSON.parse(await readFile(stateFile, 'utf8')) };
}

for (const failure of ['export', 'design']) test(`${failure} failure rolls back export and never pushes`, async t => {
  const f = await fixture(t);
  const execute = async (...args) => {
    const result = await f.execute(...args);
    if (failure === 'export' && args[0] === 'npm') throw Error('Export test failed');
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
    if (args[0] === 'npm') { exported = true; throw Error('validation failed'); }
    if (exported && args[1][0] === 'ls-remote') result.stdout = f.state.publicCommit + '\trefs/heads/main';
    return result;
  } }), /Remote changed; refusing rollback/);
  assert.ok(!f.calls.some(call => call.args[0] === 'reset' || call.args[0] === 'push'));
  assert.equal((await f.read()).exportPending, true);
});

test('interrupted export rolls back its pending commit before retrying', async t => {
  const f = await fixture(t);
  await f.execute('npm', ['run', 'export:public'], { cwd: f.worktree });
  f.state.exportBase = 'b'.repeat(40); f.state.exportPending = true;
  await writeFile(f.stateFile, JSON.stringify(f.state)); f.calls.length = 0;
  await release({ ...f.options, step: 'export' }, { execute: f.execute, log() {} });
  const reset = f.calls.findIndex(call => call.args[0] === 'reset');
  const retry = f.calls.findIndex(call => call.file === 'npm');
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
  const f = await fixture(t, ['prepare', 'verify', 'export']);
  const execute = async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (file === 'git' && (args[0] === 'ls-remote' || args.join(' ') === 'rev-parse HEAD')) result.stdout = f.state.publicCommit + (args[0] === 'ls-remote' ? '\trefs/heads/main' : '');
    if (file === 'gh' && args[1] === 'list') result.stdout = JSON.stringify([{ databaseId: args.includes('ci.yml') ? 11 : 12, headSha: f.state.publicCommit, createdAt: '9999-01-01T00:00:00Z' }]);
    if (file === 'gh' && args[1] === 'view' && args.includes('--json')) {
      const failed = args[2] === (failedWorkflow === 'ci.yml' ? '11' : '12');
      result.stdout = JSON.stringify({ headSha: f.state.publicCommit, status: failed ? 'completed' : 'in_progress', conclusion: failed ? 'failure' : null, jobs: [{ name: 'Windows tests', conclusion: 'failure' }], url: 'https://example.invalid/run' });
    }
    return result;
  };
  await assert.rejects(release(f.options, { execute, log() {}, sleep() { assert.fail('A failed workflow must stop polling'); } }), /Windows tests/);
  assert.deepEqual((await f.read()).runs, { 'ci.yml': 11, 'release.yml': 12 });
  assert.ok(!f.calls.some(call => call.args.includes('download') || call.args.includes('create')));
  assert.ok(f.calls.some(call => call.args.includes('--log-failed')));
});

test('verification stops at the first failed command and resumes that step', async t => {
  const f = await fixture(t, ['prepare']); let fail = true;
  const execute = async (...args) => { const result = await f.execute(...args); if (fail && args[0] === 'npm' && args[1].includes('test:full')) throw Error('full failed'); return result; };
  await assert.rejects(release({ ...f.options, to: 'verify' }, { execute, log() {} }), /full failed/);
  assert.equal(f.calls.filter(call => call.file === 'npm').length, 1);
  fail = false; f.calls.length = 0;
  await release({ ...f.options, to: 'verify' }, { execute, log() {} });
  assert.deepEqual(f.calls.filter(call => call.file !== 'git').map(call => call.args), [
    ['run', 'test:full'], ['--prefix', 'app', 'test'], ['--prefix', 'app', 'run', 'dist'], ['app/tools/verify-hosted.mjs'], ['run', 'release:check'],
  ]);
  assert.deepEqual((await f.read()).completed, ['prepare', 'verify']);
});

test('verification resumes at a failed hosted check without repeating passed tests or packaging', async t => {
  const f = await fixture(t, ['prepare']); let fail = true;
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
  f.state.completed = ['prepare']; await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release({ ...f.options, step: 'verify' }, { execute: async (...args) => { const result = await f.execute(...args); if (args[1][0] === 'status') result.stdout = ' M source.mjs'; return result; }, log() {} }), /not clean/);
  assert.ok(!f.calls.some(call => call.file === 'npm'));
});

test('prepare rejects linked app dependencies before running app installation', async t => {
  const f = await fixture(t, []);
  const target = path.join(f.root, 'shared'); await mkdir(target);
  await rm(path.join(f.worktree, 'app/node_modules'), { recursive: true });
  await symlink(target, path.join(f.worktree, 'app/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(release({ ...f.options, step: 'prepare' }, { execute: f.execute, log() {} }), /locally installed/);
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
  const f = await fixture(t, steps.slice(0, 4)); f.state.runs = { 'ci.yml': 11, 'release.yml': 12 };
  await writeFile(f.stateFile, JSON.stringify(f.state));
  await assert.rejects(release(f.options, { execute: async (...args) => { const result = await f.execute(...args); if (args[0] === 'gh') result.stdout = JSON.stringify({ headSha: 'wrong', status: 'completed', conclusion: 'success' }); return result; }, log() {} }), /Wrong commit/);
  assert.ok(!f.calls.some(call => call.args.includes('download')));
});

test('successful export through draft collects seven verified assets and resumes without re-creating', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.worktree, 'docs/release-notes'), { recursive: true });
  await writeFile(path.join(f.worktree, 'docs/release-notes/1.2.3.json'), '{}');
  await writeFile(f.state.notes, 'Release body\n');
  let pushed = false, draft;
  const execute = async (file, args, config) => {
    const result = await f.execute(file, args, config);
    if (file === 'git' && args[0] === 'push') pushed = true;
    if (file === 'git' && args[0] === 'ls-remote' && pushed) result.stdout = f.state.publicCommit + '\trefs/heads/main';
    if (file === 'gh' && args[1] === 'list') result.stdout = JSON.stringify([{ databaseId: args.includes('ci.yml') ? 11 : 12, headSha: f.state.publicCommit, createdAt: '9999-01-01T00:00:00Z' }]);
    if (file === 'gh' && args[1] === 'view') result.stdout = JSON.stringify({ headSha: f.state.publicCommit, status: 'completed', conclusion: 'success' });
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
  const f = await fixture(t, ['prepare']);
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
