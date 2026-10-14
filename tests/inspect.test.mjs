import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readdir } from 'node:fs/promises';
import { inspectShot, openShot } from '../src/index.mjs';
import { decodePNG } from '../src/png.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const root = createTempDirectory();
async function shot(name, spec) {
  await writeFile(path.join(root, name), `<div id="stage" style="width:64px;height:64px;background:#369"></div>
<script src="/multiplane/runtime/shot.js"></script><script>${spec}</script>`);
  return name;
}

test('inspect waits for setup, preserves runtime metadata identity and does not capture or create jobs', async () => {
  const name = await shot('setup.html', `const meta={label:'Example',nested:[true,3,null]};
const spec={duration:1,fps:29.97,meta,cuts:[0.25],post:{grain:2},blurAt:()=>1,
async setup(){await Promise.resolve();spec.duration=1.1;},render(){}};
Shot.define(spec);window.originalMeta=meta;`);
  const events = [];
  const before = await readdir(root);
  const result = await inspectShot(name, { root, onEvent: event => events.push(event), onBrowser(browser) {
    browser.on('page', page => {
      page.screenshot = () => assert.fail('inspect must not screenshot');
      const context = page.context(), original = context.newCDPSession.bind(context);
      context.newCDPSession = async (...args) => {
        const session = await original(...args), send = session.send.bind(session);
        session.send = (method, ...params) => { assert.notEqual(method, 'Page.captureScreenshot'); return send(method, ...params); };
        return session;
      };
    });
  } });
  assert.deepEqual(result.data, { shot: path.join(root, name), duration: 1.1, fps: 29.97, frames: 33,
    stage: { width: 64, height: 64 }, cuts: [0.25], post: { grain: 2 }, hasBlurAt: true,
    meta: { label: 'Example', nested: [true, 3, null] } });
  assert.deepEqual(await readdir(root), before);
  assert.deepEqual(result.artifacts, []);
  assert.ok(events.every(event => !('jobId' in event)));
  assert.equal(events[0].type, 'start'); assert.equal(events.at(-1).type, 'result');
  const capture = await openShot(name, 1, { root });
  try { assert.equal(await capture.page.evaluate(() => SHOT.meta === originalMeta), true); }
  finally { await capture.close(); }
});

fullTest('inspect CLI supports root, fps, JSON and lint opt-out', async () => {
  await shot('cli.html', 'Shot.define({duration:1.01,render(){},meta:"note"});');
  const result = await run(process.execPath, ['bin/multiplane', 'inspect', 'cli.html', '--root', root, '--fps', '12', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1).data.frames, 13); assert.equal(events.at(-1).data.fps, 12);
  const bad = await shot('lint.html', 'Shot.define({duration:1,meta:Date.now(),render(){}});');
  await assert.rejects(inspectShot(bad, { root }), { code: 'lint_failed' });
  assert.equal((await inspectShot(bad, { root, 'no-lint': true })).ok, true);
  await assert.rejects(inspectShot('cli.html', { root, fps: '0' }), { code: 'invalid_option' });
});

fullTest('metadata accepts JSON values and enforces the UTF-8 1 MiB boundary', async () => {
  const name = await shot('meta.html', 'Shot.define({duration:1,meta:"x",render(){}});');
  for (const expression of ['null', 'false', '0', '"text"', '[1,"a",null]', '{a:1}', '{nested:undefined}', '"x".repeat(1024*1024-2)']) {
    await shot(name, `Shot.define({duration:1,meta:${expression},render(){}});`);
    assert.equal((await inspectShot(name, { root })).ok, true);
  }
  for (const expression of ['"x".repeat(1024*1024-1)', '"中".repeat(350000)', '1n', '()=>1', 'Symbol("x")',
    '(()=>{const x={};x.self=x;return x;})()', '{toJSON(){throw new Error("bad");}}']) {
    await shot(name, `Shot.define({duration:1,meta:${expression},render(){}});`);
    await assert.rejects(inspectShot(name, { root }), { code: 'shot_contract_invalid' });
  }
});

fullTest('metadata defaults to null, is validated after setup, and does not change pixels', async () => {
  const name = await shot('pixels.html', 'Shot.define({duration:1,render(){}});');
  const baseline = await openShot(name, 1, { root });
  let pixels;
  try { assert.equal(baseline.meta, null); pixels = decodePNG(await baseline.frame(0)).data; }
  finally { await baseline.close(); }
  await shot(name, 'Shot.define({duration:1,meta:{title:"Example"},render(){}});');
  const changed = await openShot(name, 1, { root });
  try { assert.deepEqual(decodePNG(await changed.frame(0)).data, pixels); }
  finally { await changed.close(); }
  await shot(name, 'Shot.define({duration:1,meta:{},setup(){SHOT.meta.self=SHOT.meta;},render(){}});');
  await assert.rejects(inspectShot(name, { root }), { code: 'shot_contract_invalid' });
});
