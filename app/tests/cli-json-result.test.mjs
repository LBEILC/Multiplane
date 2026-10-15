import test from 'node:test';
import assert from 'node:assert/strict';
import { cliJsonResult } from '../tools/cli-json-result.mjs';

test('CLI NDJSON accepts warnings before the final result with LF or CRLF', () => {
  const result = { type: 'result', ok: true, data: { file: 'config.json' } };
  for (const newline of ['\n', '\r\n']) {
    const lines = [JSON.stringify({ type: 'warning', code: 'gpu_software_fallback' }), JSON.stringify(result)];
    for (const suffix of ['', newline]) assert.deepEqual(cliJsonResult(lines.join(newline) + suffix), result);
  }
  assert.deepEqual(cliJsonResult(JSON.stringify(result)), result);
});

test('CLI NDJSON rejects contamination, empty lines and missing final result', () => {
  const result = '{"type":"result","ok":true}';
  for (const stdout of ['', 'runtime diagnostic\n' + result, result + '\nruntime diagnostic', '\n' + result,
    result + '\n\n', '{"type":"warning"}', result + '\n{"type":"warning"}', 'null', '{}']) {
    assert.throws(() => cliJsonResult(stdout));
  }
});
