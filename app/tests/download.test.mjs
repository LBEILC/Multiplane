import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequester } from '../tools/download.mjs';
import { prepareFont, downloadPage } from '../tools/fonts.mjs';

test('response-body socket interruption retries and returns only the complete response', async t => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Length': 8 });
    if (calls === 1) { res.write('part'); setTimeout(() => res.destroy(), 15); }
    else res.end('complete');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const logs = [];
  const request = createRequester({ backoffMs: 1, log: line => logs.push(line) });
  const result = await request(`http://127.0.0.1:${server.address().port}`);
  assert.equal(result.bytes.toString(), 'complete');
  assert.equal(calls, 2); assert.equal(logs.length, 1);
});

test('network failures stop at the retry limit and report exponential backoff', async () => {
  let calls = 0; const logs = [];
  const request = createRequester({ fetchImpl: async () => { calls++; throw Error('socket closed'); }, backoffMs: 1, log: s => logs.push(s) });
  await assert.rejects(request(downloadPage), /retry\/time limit.*socket closed/);
  assert.equal(calls, 4);
  assert.deepEqual(logs.map(s => Number(s.match(/in (\d+) ms/)[1])), [1, 2, 4]);
});

test('response-body stalls respect the shared time budget', async t => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = createRequester({ attemptMs: 30, totalMs: 80, backoffMs: 1, log() {} });
  const start = performance.now();
  await assert.rejects(request(`http://127.0.0.1:${server.address().port}`), /retry\/time limit/);
  assert.ok(performance.now() - start < 2000);
});

test('permanent HTTP errors are not retried', async () => {
  let calls = 0;
  const request = createRequester({ fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } });
  await assert.rejects(request(downloadPage), /HTTP 404/); assert.equal(calls, 1);
});

test('wrong font hash never replaces the existing file; invalid cache hits never use the network', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multiplane-font-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'MiSansVF.ttf');
  await writeFile(file, 'old');
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    return new Response(String(url) === downloadPage ? '"/MiSans%20VF.ttf"' : 'wrong font');
  };
  await assert.rejects(prepareFont({ file, fetchImpl }), /SHA-256.*refusing/);
  assert.equal(calls, 2); assert.equal(await readFile(file, 'utf8'), 'old');
  assert.deepEqual(await readdir(directory), ['MiSansVF.ttf']);
  calls = 0;
  await assert.rejects(prepareFont({ file, fetchImpl, cacheOnly: true }), /Cached MiSans verification failed/);
  assert.equal(calls, 0);
});
