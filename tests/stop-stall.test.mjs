import './test-home.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fullTest } from './suite.mjs';
import { createTempDirectory, run } from './helpers.mjs';

await mkdir('out/tests', { recursive: true });
for (const mode of ['hook', 'cli', 'app', 'failure']) fullTest(`stalled peer: ${mode} ends, preserves segments and resumes identical frames`, { timeout: 60000 }, async () => {
  const root = createTempDirectory(path.resolve('out/tests/stop-stall-'));
  const result = await run(process.execPath, ['--import', './tests/stop-stall-fault.mjs', 'tests/stop-stall-runner.mjs', root, mode]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  console.log(result.stdout.trim());
});
