import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDirectory, run } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrapper = path.join(root, 'tools/ci-run.mjs');
const baseEnv = { ...process.env };
delete baseEnv.MULTIPLANE_CI_STEP_TIMEOUT_MINUTES;

function running(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'win32') {
    // Killed orphans can briefly remain as zombies until the host reaps them.
    try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
    catch { return false; }
  }
  return true;
}

test('CI timeout waits for the child tree and reports step, elapsed time and limit', { timeout: 15000 }, async t => {
  const directory = createTempDirectory('multiplane-ci-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'pids.json');
  const result = await run(process.execPath, [wrapper, 'timeout-tree-test', root, 'node', path.join(root, 'tests/fixtures/ci-tree.cjs'), 'parent', record], {
    env: { ...baseEnv, MULTIPLANE_CI_STEP_TIMEOUT_MINUTES: '0.025' }, timeout: 10000,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /tree ready/);
  assert.match(result.stderr, /Step timeout-tree-test timed out after [\d.]+ min \(limit 0.025 min\)/);
  const pids = JSON.parse(await readFile(record, 'utf8'));
  pids.parent = Number(/parent=(\d+)/.exec(result.stdout)[1]);
  for (const [role, pid] of Object.entries(pids)) assert.equal(running(pid), false, `${role} ${pid} still running`);
  assert.match(await readFile(path.join(root, 'out/ci/timeout-tree-test.log'), 'utf8'), /limit 0.025 min/);
});

test('CI rejects invalid timeout values before starting the command', async () => {
  for (const value of ['', '0', '-1', 'NaN', 'Infinity', 'abc', '0x10', '1e3', '0.0000001', '35792']) {
    const result = await run(process.execPath, [wrapper, 'invalid-timeout-test', root, 'node', '-e', "console.log('started')"], {
      env: { ...baseEnv, MULTIPLANE_CI_STEP_TIMEOUT_MINUTES: value },
    });
    assert.notEqual(result.code, 0, value);
    assert.match(result.stderr, /Invalid MULTIPLANE_CI_STEP_TIMEOUT_MINUTES/);
    assert.doesNotMatch(result.stdout, /started/);
  }
});

test('CI default accepts successful commands and preserves ordinary failures', async () => {
  const success = await run(process.execPath, [wrapper, 'success-test', root, 'node', '-e', "console.log('ok')"], { env: baseEnv });
  assert.equal(success.code, 0); assert.match(success.stdout, /ok/);
  const failure = await run(process.execPath, [wrapper, 'failure-test', root, 'node', '-e', 'process.exit(7)'], { env: baseEnv });
  assert.notEqual(failure.code, 0); assert.match(failure.stderr, /Command failed \(7\)/); assert.doesNotMatch(failure.stderr, /timed out/);
});

test('CI resolves a relative child directory before entering the owned process scope', async () => {
  const result = await run(process.execPath, [wrapper, 'relative-cwd-test', 'app', 'node', '-e', 'console.log(JSON.stringify(process.cwd()))'], {
    cwd: root, env: baseEnv,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(path.resolve(JSON.parse(result.stdout.trim())), path.resolve(root, 'app'));
});
