import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDirectory } from './helpers.mjs';
import { mediaResponse } from '../src/main/media.mjs';

async function fixture(ext = 'mp4', content = '0123456789') {
  const file = path.join(createTempDirectory(), `media.${ext}`);
  await writeFile(file, content);
  return (range, method = 'GET') => mediaResponse(file, new Request('https://media.test/', { method, headers: range === undefined ? {} : { Range: range } }));
}
test('media streams full files and preserves image MIME types without a range', async () => {
  for (const [ext, type] of [['mp4','video/mp4'], ['webm','video/webm'], ['png','image/png'], ['jpg','image/jpeg'], ['jpeg','image/jpeg'], ['webp','image/webp']]) {
    const response = await (await fixture(ext))();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(await response.text(), '0123456789');
  }
});
test('media streams exact closed, open-ended, suffix and clamped ranges', async () => {
  const respond = await fixture();
  for (const [range, content, span] of [['bytes=2-5','2345','2-5'], ['bytes=7-','789','7-9'], ['bytes=-3','789','7-9'], ['bytes=8-99','89','8-9'], ['bytes=-99','0123456789','0-9']]) {
    const response = await respond(range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${span}/10`);
    assert.equal(response.headers.get('content-length'), String(content.length));
    assert.equal(await response.text(), content);
  }
});
test('media rejects unsatisfiable, malformed and unsupported multiple ranges', async () => {
  const respond = await fixture();
  for (const range of ['bytes=10-', 'bytes=5-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-2', 'bytes=9007199254740992-']) {
    const response = await respond(range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
});
test('media handles HEAD, empty files and cancelled streams', async () => {
  const respond = await fixture();
  const head = await respond('bytes=2-5', 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '4');
  assert.equal(await head.text(), '');
  const empty = await fixture('mp4', '');
  assert.equal(await (await empty()).text(), '');
  assert.equal((await empty('bytes=0-')).status, 416);
  const response = await respond();
  await response.body.cancel();
});
