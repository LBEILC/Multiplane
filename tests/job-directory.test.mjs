import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/events.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const cli = fileURLToPath(new URL('../bin/multiplane', import.meta.url));
test('unwritable job directories fail before render work; status and cancel stay independent', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-job-dir-'));
  const blocked = path.join(work, 'blocked');
  t.after(async () => { if (process.platform !== 'win32') await chmod(blocked, 0o700); await rm(work, { recursive: true, force: true }); });
  if (process.platform === 'win32') await writeFile(blocked, 'file occupying directory');
  else { await mkdir(blocked); await chmod(blocked, 0o500); }
  // Root can bypass POSIX permissions; use a file obstruction for privileged runs.
  const jobs = process.platform !== 'win32' && process.getuid?.() === 0 ? path.join(work, 'file') : blocked;
  if (jobs !== blocked) await writeFile(jobs, 'file occupying directory');
  let invoked = false;
  await assert.rejects(runCommand('render', 'shot.html', { 'job-dir': jobs }, async () => { invoked = true; }), error => error.code === 'job_dir_unwritable');
  assert.equal(invoked, false);
  const env = { ...process.env, MULTIPLANE_HOME: path.join(work, 'home'), MULTIPLANE_NO_INDEX: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(work, 'missing-browser'), MULTIPLANE_JOBS_DIR: jobs };
  for (const command of ['render', 'stills', 'verify']) for (const explicit of [false, true]) {
    const result = spawnSync(process.execPath, [cli, command, 'shot.html', '--json', ...(explicit ? ['--job-dir', jobs] : [])], { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'job_dir_unwritable');
    assert.equal(events[0].details.path, jobs);
    assert.match(events[0].hint, /--job-dir.*MULTIPLANE_JOBS_DIR/);
  }
  const existing = path.join(work, 'existing'); await mkdir(existing);
  await writeFile(path.join(existing, 'status.json'), JSON.stringify({ schema: 'multiplane/1', pid: process.pid, state: 'succeeded' }));
  for (const command of ['status', 'cancel']) {
    const result = spawnSync(process.execPath, [cli, command, existing, '--json'], { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  await writeFile(path.join(work, 'out'), 'block default jobs parent');
  const defaultEnv = { ...env }; delete defaultEnv.MULTIPLANE_JOBS_DIR;
  const result = spawnSync(process.execPath, [cli, 'render', 'shot.html', '--json'], { cwd: work, env: defaultEnv, encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).details.path, path.join(work, 'out/jobs'));
});

test('file-write failure is reported even when job directories can be created', async t => {
  const jobs = await mkdtemp(path.join(os.tmpdir(), 'multiplane-job-write-'));
  t.after(() => rm(jobs, { recursive: true, force: true }));
  const original = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('.write-check')) throw Object.assign(Error('read-only filesystem'), { code: 'EROFS' });
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runCommand('render', 'shot.html', { 'job-dir': jobs }, () => assert.fail('must fail before browser work')), error => {
      assert.equal(error.code, 'job_dir_unwritable');
      assert.equal(error.exitCode, 3);
      assert.equal(error.details.path, jobs);
      return true;
    });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
