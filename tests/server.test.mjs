import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { startServer } from '../src/server.mjs';
import { serve } from '../src/serve.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const root = createTempDirectory(), outside = createTempDirectory();
test('missing root favicon is empty while real icons and other missing resources retain their behavior', async () => {
  const directory = createTempDirectory();
  const server = await startServer(0, directory);
  try {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(server.url + '/favicon.ico?cache=1', { method });
      assert.equal(response.status, 204); assert.equal(await response.text(), '');
    }
    for (const resource of ['/missing.png', '/sub/favicon.ico']) assert.equal((await fetch(server.url + resource)).status, 404);
    await writeFile(path.join(directory, 'favicon.ico'), 'icon');
    const response = await fetch(server.url + '/favicon.ico');
    assert.equal(response.status, 200); assert.equal(await response.text(), 'icon');
  } finally { await server.close(); }
});
test('image MIME types allow animated/static decoder inspection', async () => {
  const server = await startServer(0, root);
  try {
    for (const [ext, type] of [['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['gif', 'gif'], ['webp', 'webp'], ['avif', 'avif']]) {
      await writeFile(path.join(root, 'image.' + ext), 'fixture');
      assert.equal((await fetch(server.url + '/image.' + ext)).headers.get('content-type'), 'image/' + type);
    }
  } finally { await server.close(); }
});
await writeFile(path.join(outside, 'private.html'), 'private');
for (const name of ['z.html', 'A.html', 'sub/a.html', 'sub/space name.html', '.hidden/no.html', 'node_modules/no.html', 'out/no.html']) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), name);
}
await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
await symlink(root, path.join(root, 'sub', 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');

test('shared server lists sorted HTML paths, guards boundaries, and binds only IPv4 loopback', async t => {
  const original = http.Server.prototype.listen;
  let address;
  t.mock.method(http.Server.prototype, 'listen', function (...args) {
    this.once('listening', () => { address = this.address(); });
    return original.apply(this, args);
  });
  const server = await startServer(0, root);
  try {
    assert.equal(address.address, '127.0.0.1'); assert.equal(address.family, 'IPv4');
    assert.equal(address.port, server.port); assert.ok(server.port > 0);
    assert.deepEqual(await (await fetch(server.url + '/multiplane/shots.json')).json(), ['A.html', 'sub/a.html', 'sub/space name.html', 'z.html']);
    assert.equal(await (await fetch(server.url + '/sub/space%20name.html')).text(), 'sub/space name.html');
    for (const resource of ['/escape/private.html', '/%2e%2e%2fprivate.html', '/.hidden/no.html', '/node_modules/no.html', '/multiplane/vendor/three/package.json']) {
      assert.equal((await fetch(server.url + resource)).status, 403, resource);
    }
    assert.equal((await fetch(server.url + '/multiplane/runtime/shot.js')).status, 200);
    assert.equal((await fetch(server.url + '/multiplane/three.js')).status, 200);
    await assert.rejects(startServer(server.port, root), { code: 'port_in_use', exitCode: 3 });
    const failure = await run(process.execPath, ['bin/multiplane', 'serve', '--root', root, '--port', String(server.port), '--json']);
    assert.equal(failure.code, 3);
    const events = failure.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).code, 'port_in_use');
  } finally { await server.close(); }
});

test('serve closes on interruption with a successful result and removes signal handlers', async () => {
  const count = process.listenerCount('SIGINT'), events = [];
  let url;
  const result = await serve({ root, onEvent(event) {
    events.push(event);
    if (event.type === 'listening') { url = event.url; process.emit('SIGINT'); }
  } });
  assert.equal(result.ok, true); assert.equal(process.listenerCount('SIGINT'), count);
  assert.deepEqual(events.map(event => event.type), ['start', 'listening', 'result']);
  await assert.rejects(fetch(url));
});

test('serve CLI streams start/listening/result and exits zero after interruption', async () => {
  // Windows does not deliver POSIX signals via child.kill. Inject the same
  // signal event over IPC there, while exercising the unmodified CLI parser.
  const script = `process.argv=[process.execPath,'bin/multiplane','serve','--root',${JSON.stringify(root)},'--json'];
process.on('message',()=>process.emit('SIGINT'));
await import('./bin/multiplane');process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  let output = '', errors = '', sent = false;
  child.stderr.on('data', data => { errors += data; });
  child.stdout.on('data', data => {
    output += data;
    if (!sent && output.includes('"type":"listening"')) {
      sent = true;
      if (process.platform === 'win32') child.send('interrupt'); else child.kill('SIGINT');
    }
  });
  const [code] = await closed;
  assert.equal(code, 0, output + errors);
  const events = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['start', 'listening', 'result']);
  assert.equal(events[1].root, root); assert.ok(events[1].port > 0); assert.equal(events[2].ok, true);
});

test('serve rejects invalid ports and roots', async () => {
  for (const port of [-1, 65536, 1.5, 'abc', '']) await assert.rejects(startServer(port, root), { code: 'invalid_option' });
  await assert.rejects(startServer(0, path.join(root, 'missing')), { code: 'invalid_option' });
});
