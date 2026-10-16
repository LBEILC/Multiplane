import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { segmentEncoder } from '../src/segment-encoder.mjs';
import { videoEncoding } from '../src/format.mjs';
import { resolveFFmpeg } from '../src/ffmpeg.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const events = { check() {}, onCancel() { return () => {}; } };
const rate = { argument: '24' };

test('packet counting streams all lines, ignores headers and distinguishes missing counts from mismatches', async t => {
  const directory = createTempDirectory();
  const packet = '0, -2, 0, 1, 100, 0x12345678\r\n';
  let output, calls;
  t.mock.method(childProcess, 'spawn', (executable, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('framecrc')) {
        // Split inside CRLF and packet fields, including a final unterminated line.
        for (let i = 0; i < output.length; i += 17) child.stdout.write(output.slice(i, i + 17));
      }
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    for (const [text, expected, message, actual] of [
      ['#tb 0: 1/24\r\n\r\n' + packet.repeat(400) + packet.trimEnd(), 401, null, 401],
      [packet, 2, 'Segment frame count differs.', 1],
      ['#tb 0: 1/24\n\n', 1, 'Segment frame count could not be read.', null],
      ['', 1, 'Segment frame count could not be read.', null],
    ]) {
      output = text; calls = [];
      const store = { manifest: { segments: [] }, save() {} };
      const encoder = segmentEncoder({ ffmpeg: 'fixture', directory, index: 0, first: 0, end: expected,
        width: 2, height: 2, rate, encoding: videoEncoding({ format: 'mp4' }), format: 'mp4', events, store });
      await writeFile(path.join(directory, 'segment-000000.mp4.partial.mp4'), 'fixture');
      if (message) {
        await assert.rejects(encoder.seal(), error => error.code === 'output_invalid' && error.message === message
          && error.details.frames === actual && error.details.expected === expected);
        assert.deepEqual(store.manifest.segments, []);
      } else assert.equal((await encoder.seal()).end, expected);
      assert.ok(calls[1].includes('copy')); assert.ok(calls[1].includes('framecrc'));
      assert.ok(!calls[1].includes('-progress'));
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const format of ['mp4', 'webm', 'mov']) {
  test(`${format}: real packets seal correctly and probing preserves encoded bytes`, async () => {
    const directory = createTempDirectory(), ffmpeg = await resolveFFmpeg();
    const store = { manifest: { segments: [] }, save() {} };
    let original;
    const encoder = segmentEncoder({ ffmpeg, directory, index: 0, first: 0, end: 4, width: 16, height: 16,
      rate, encoding: videoEncoding({ format, alpha: format !== 'mp4' }), format, events, store,
      hook: async phase => {
        if (phase === 'beforeSeal') assert.deepEqual(await readFile(path.join(directory, `segment-000000.${format}.partial.${format}`)), original);
      } });
    for (let i = 0; i < 4; i++) await encoder.write(Buffer.from(Array(256).fill([i * 50, 40, 90, 128]).flat()));
    encoder.child.stdin.end(); await encoder.finished;
    original = await readFile(path.join(directory, `segment-000000.${format}.partial.${format}`));
    const segment = await encoder.seal();
    assert.equal(segment.end, 4); assert.equal(store.manifest.segments.length, 1);
    assert.deepEqual(await readFile(path.join(directory, segment.file)), original);
    const decoded = await run(ffmpeg, ['-v', 'error', '-i', path.join(directory, segment.file), '-f', 'framemd5', '-']);
    assert.equal(decoded.code, 0, decoded.stderr);
    assert.equal(decoded.stdout.split('\n').filter(line => line.trim() && !line.startsWith('#')).length, 4);
  });
}
