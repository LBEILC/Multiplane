import assert from 'node:assert/strict';

// Parse every output line so runtime diagnostics cannot hide before the result.
export function cliJsonResult(stdout) {
  const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  const events = lines.map(line => JSON.parse(line));
  const result = events.at(-1);
  assert.equal(result?.type, 'result', 'CLI JSON output must end with a result event');
  return result;
}
