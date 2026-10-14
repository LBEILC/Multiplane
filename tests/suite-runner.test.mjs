import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrency, schedule, serialFiles } from '../tools/test-suite.mjs';
import { run, createTempDirectory } from './helpers.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// New files must join the daily run without a second allowlist.
test('suite scheduling discovers ordinary files, bounds parallel work and isolates serial files', async () => {
  const files = ['new-feature.test.mjs', 'unit.test.mjs', 'alpha.test.mjs', ...serialFiles];
  const seen = [], active = new Set(); let peak = 0;
  await schedule(files, 2, async file => {
    if (serialFiles.includes(file)) assert.equal(active.size, 0);
    assert.ok([...active].every(name => !serialFiles.includes(name)));
    active.add(file); seen.push(file); peak = Math.max(peak, active.size);
    await new Promise(resolve => setImmediate(resolve));
    active.delete(file);
  });
  assert.equal(peak, 2);
  assert.deepEqual([...seen].sort(), [...files].sort());
  assert.deepEqual(seen.slice(-serialFiles.length), serialFiles);
  for (const [cores, expected] of [[1, 1], [2, 1], [8, 2], [16, 4], [32, 8], [128, 8]]) assert.equal(concurrency(cores), expected);
});

test('full-only cases run by default and in full mode, while daily retains ordinary cases', async () => {
  const directory = createTempDirectory('multiplane-suite-');
  const fixture = path.join(directory, 'suite.mjs');
  await writeFile(fixture, `import test from 'node:test';
import { fullTest } from ${JSON.stringify(new URL('./suite.mjs', import.meta.url).href)};
test('ordinary', () => {}); fullTest('extended', () => {});`);
  for (const suite of ['daily', 'full', undefined]) {
    const env = { ...process.env };
    // This child starts its own reporter instead of inheriting Node's IPC context.
    delete env.NODE_TEST_CONTEXT;
    if (suite) env.MULTIPLANE_TEST_SUITE = suite; else delete env.MULTIPLANE_TEST_SUITE;
    const result = await run(process.execPath, ['--test', '--test-reporter=tap', fixture], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, suite === 'daily' ? /# pass 1/ : /# pass 2/);
    assert.match(result.stdout, suite === 'daily' ? /# skipped 1/ : /# skipped 0/);
  }
});
