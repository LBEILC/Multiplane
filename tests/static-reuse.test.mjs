import './test-home.mjs';
import test from 'node:test';
import { fullTest } from './suite.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { createRenderPool } from '../src/render-pool.mjs';
import { verifyShot } from '../src/verify.mjs';
import { reuseState, reuseReport, reuseEnabled, verifiedFrames } from '../src/static-reuse.mjs';
import { encodePNG, decodePNG } from '../src/png.mjs';
import { stillsShot } from '../src/stills.mjs';
import { createTempDirectory, run } from './helpers.mjs';

const directory = createTempDirectory(path.resolve('out/static-reuse-'));
const html = (body = '', render = '', extra = '') => `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body{margin:0}#stage{width:64px;height:48px;position:relative;background:var(--multiplane-page-background,#123)}
#box{position:absolute;width:24px;height:24px;background:#c45a}</style></head><body><div id="stage"><div id="box"></div>${body}</div>
<script>const box=document.querySelector('#box');${extra}
window.SHOT={duration:2,fps:12,ready:Promise.resolve(),cuts:[],render(t){${render}}};</script></body></html>`;
async function fixture(name, content) {
  const shot = path.join(directory, name + '.html'); await writeFile(shot, content); return shot;
}
async function pixels(shot, options, count = 24) {
  const capture = await openShot(shot, options['render-scale'] ?? options.scale ?? 1, options);
  try {
    const processed = createPostCapture(capture, { ...options, transport: 'raw' });
    const frames = [];
    for (let frame = 0; frame < count; frame++) frames.push(Buffer.from(await processed.frame(frame / capture.fps, frame)));
    return { frames, report: processed.staticReuse };
  } finally { await capture.close(); }
}
const change = `const x=t<1?0:24;box.style.left=x+'px';`;
const imageURL = value => 'data:image/png;base64,' + encodePNG({ width: 2, height: 2, data: Buffer.from([value, 0, 0, 255, value, 0, 0, 255, value, 0, 0, 255, value, 0, 0, 255]) }).toString('base64');
const gif = Buffer.from('47494638396101000100800000ff000000ff0021f90400ffff00002c000000000100010000020244010021f90400ffff00002c00000000010001000002024c01003b', 'hex');
test('SVG JPEG resources become observable static frames without weakening image checks', async () => {
  const jpeg = path.join(directory, 'neutral.jpg');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#456' } }).jpeg().toFile(jpeg);
  const shot = await fixture('svg-jpeg', html('<svg width="32" height="32"><image href="neutral.jpg" width="32" height="32"/></svg>', change));
  const options = { raster: 'software', 'motion-blur': 6 };
  const off = await pixels(shot, { ...options, 'no-static-reuse': true });
  const on = await pixels(shot, options);
  assert.ok(on.report.reusedFrames > 0, JSON.stringify(on.report));
  assert.equal(on.report.disabledReason, null);
  for (const [frame, bytes] of on.frames.entries()) assert.deepEqual(bytes, off.frames[frame]);
});
for (const [name, body, render, extra, options, reuse] of [
  ['long-static', '', '', '', {}, true],
  ['sudden-change', '', change, '', { grain: 3 }, true],
  ['blur', '', change, '', { 'motion-blur': 6, grain: 2 }, true],
  ['blur-exact', '', change, '', { 'motion-blur': 6, 'adaptive-blur': 0 }, true],
  ['alpha', '', change, '', { alpha: true, grain: 2, 'motion-blur': 6 }, true],
  ['upscale', '', change, '', { scale: 2, 'render-scale': 1, grain: 2 }, true],
  ['cssom', '', `document.styleSheets[0].cssRules[2].style.background=t<1?'#c45a':'#4c5a';`, '', {}, true],
  ['saved-cssom', '', `saved.background=t<1?'#c45a':'#4c5a';`, `const saved=document.styleSheets[0].cssRules[2].style;`, {}, true],
  ['forwarded-cssom', '<style>#box { opacity:.3 }</style>', `document.styleSheets[1].cssRules[0].style=t<1?'opacity:.3':'opacity:.8';`, '', {}, true],
  ['media-cssom', '<style>@media all {#box { opacity:.3 }}</style>', `document.styleSheets[1].cssRules[0].media.mediaText=t<1?'all':'not all';`, '', {}, true],
  ['grouped-cssom', '<style>@media all {#box { opacity:.3 }}</style>', `saved.opacity=t<1?'.3':'.8';`, `const saved=document.styleSheets[1].cssRules[0].cssRules[0].style;`, {}, true],
  ['selector-cssom', '<style>#box { opacity:.3 }</style>', `document.styleSheets[1].cssRules[0].selectorText=t<1?'#box':'#absent';`, '', {}, true],
  ['disabled-cssom', '<style>#box { opacity:.3 }</style>', `document.styleSheets[1].disabled=t>=1;`, '', {}, true],
  ['adopted-css', '', `document.adoptedStyleSheets=[t<1?before:after];`, `const before=new CSSStyleSheet(),after=new CSSStyleSheet();before.replaceSync('#box{opacity:.3}');after.replaceSync('#box{opacity:.8}');`, {}, true],
  ['adopted-array', '', `document.adoptedStyleSheets[0]=t<1?before:after;`, `const before=new CSSStyleSheet(),after=new CSSStyleSheet();before.replaceSync('#box{opacity:.3}');after.replaceSync('#box{opacity:.8}');document.adoptedStyleSheets.push(before);`, {}, true],
  ['attributes', '<style>#box[data-state="after"]{opacity:.2}</style>', `box.setAttribute('data-state',t<1?'before':'after');`, '', {}, true],
  ['text', '', `const text=t<1?'A':'B';if(box.textContent!==text)box.textContent=text;`, '', {}, true],
  ['canvas', '<canvas width="64" height="48"></canvas>', `ctx.fillStyle=t<1?'#abc':'#456';ctx.fillRect(0,0,64,48);`, `const ctx=document.querySelector('canvas').getContext('2d');`, {}, false],
  ['static-offscreen', '<canvas width="64" height="48"></canvas>', '', `const source=new OffscreenCanvas(64,48);source.getContext('2d').fillRect(0,0,64,48);document.querySelector('canvas').getContext('2d').drawImage(source,0,0);`, {}, true],
  ['webgl', '<canvas width="64" height="48"></canvas>', 'gl.clearColor(t<1?0.2:0.8,0.4,0.6,1);gl.clear(gl.COLOR_BUFFER_BIT);', `const gl=document.querySelector('canvas').getContext('webgl',{preserveDrawingBuffer:true});`, {}, false],
  ['video', '<video></video>', '', '', {}, false],
  ['iframe', '<iframe src="about:blank"></iframe>', '', '', {}, false],
  ['animation', '<style>@keyframes move{to{opacity:0.5}}#box{animation:move 100s infinite paused}</style>', '', '', {}, true],
  ['shadow', '', '', `box.attachShadow({mode:'closed'}).innerHTML='<i>shadow</i>';`, {}, false],
  ['declarative-shadow', '<div><template shadowrootmode="closed"><span>shadow</span></template></div>', '', '', {}, false],
  ['untracked-context', '', '', `CanvasRenderingContext2D.prototype.fillRect=()=>{};`, {}, false],
  ['unknown-context', '', '', `document.createElement('canvas').getContext(undefined);`, {}, false],
  ['image', '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">', '', '', {}, true],
  ['raster-image', `<img src="${imageURL(30)}">`, `const image=document.querySelector('img'),source=t<1?before:after;if(image.src!==source)image.src=source;`, `const before='${imageURL(30)}',after='${imageURL(180)}';`, {}, true],
  ['animated-image', `<img src="data:image/gif;base64,${gif.toString('base64')}">`, '', '', {}, false],
  ['svg', '<svg width="64" height="48"><rect id="rect" width="20" height="20" fill="red"/></svg>', `document.querySelector('#rect').setAttribute('x',t<1?'0':'24');`, '', {}, true],
  ['svg-base-value', '<svg width="64" height="48"><rect id="rect" width="20" height="20" fill="red"/></svg>', `document.querySelector('#rect').x.baseVal.value=t<1?0:24;`, '', {}, true],
  ['input', '<input value="A">', `document.querySelector('input').value=t<1?'A':'B';`, '', {}, true],
  ['checkbox', '<input type="checkbox">', `document.querySelector('input').checked=t>=1;`, '', {}, true],
  ['checkbox-click', '<input type="checkbox">', `const input=document.querySelector('input');if(input.checked!==(t>=1))input.click();`, '', {}, true],
  ['textarea', '<textarea>A</textarea>', `document.querySelector('textarea').value=t<1?'A':'B';`, '', {}, true],
  ['select', '<select><option>A</option><option>B</option></select>', `document.querySelector('select').selectedIndex=t<1?0:1;`, '', {}, true],
  ['editable', '<div contenteditable>A</div>', `const target=document.querySelector('[contenteditable]');const text=t<1?'A':'B';if(target.textContent!==text)target.textContent=text;`, '', {}, true],
  ['timer-registration', '', '', 'requestAnimationFrame(()=>{});setInterval(()=>{},10000);', {}, true],
]) (['long-static', 'sudden-change', 'canvas'].includes(name) ? test : fullTest)(`${name}: reuse on/off has identical pre-encode RGBA`, { timeout: 120000 }, async () => {
  const shot = await fixture(name, html(body, render, extra));
  const off = await pixels(shot, { ...options, 'no-static-reuse': true });
  const on = await pixels(shot, options);
  assert.equal(on.frames.length, off.frames.length);
  for (const [frame, bytes] of on.frames.entries()) assert.ok(bytes.equals(off.frames[frame]), `${name}: pixels differ at frame ${frame}`);
  assert.equal(on.report.disabledReason, null);
  assert.equal(on.report.reusedFrames > 0, reuse, JSON.stringify(on.report));
  if (reuse) assert.ok(on.report.verifiedFrames > 0);
});

fullTest('font loading and completion invalidate an otherwise static frame', async () => {
  const shot = await fixture('fonts', html());
  const capture = await openShot(shot);
  try {
    await capture.frame(0);
    await capture.observe(0);
    assert.equal(await capture.observe(0), false);
    for (const event of ['loading', 'loadingdone', 'loadingerror']) {
      await capture.page.evaluate(event => document.fonts.dispatchEvent(new Event(event)), event);
      assert.equal(await capture.observe(0), true);
      assert.equal(await capture.observe(0), false);
    }
  } finally { await capture.close(); }
});

fullTest('unreadable image probes fall back without hiding actual resource failures', async () => {
  const image = encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/missing.png' ? 404 : 200, { 'Content-Type': 'image/png' });
    response.end(image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const shot = await fixture('image-cors', html(`<img src="${origin}/image.png">`));
    const reference = await pixels(shot, { 'no-static-reuse': true }, 6);
    const actual = await pixels(shot, {}, 6);
    for (let frame = 0; frame < 6; frame++) assert.ok(actual.frames[frame].equals(reference.frames[frame]));
    assert.equal(actual.report.reusedFrames, 0);
    const blocked = await fixture('image-csp', html(`<img src="${imageURL(30)}">`).replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">'));
    const blockedReference = await pixels(blocked, { 'no-static-reuse': true }, 6);
    const blockedActual = await pixels(blocked, {}, 6);
    for (let frame = 0; frame < 6; frame++) assert.ok(blockedActual.frames[frame].equals(blockedReference.frames[frame]));
    assert.equal(blockedActual.report.reusedFrames, 0);
    const missing = await fixture('image-missing', html(`<img src="${origin}/missing.png">`));
    await assert.rejects(openShot(missing), error => error.code === 'resource_failed');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

fullTest('stylesheet snapshots are cached until a possible CSSOM or DOM edit', async () => {
  const shot = await fixture('style-snapshot-cache', html());
  const capture = await openShot(shot);
  try {
    await capture.page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(CSSRule.prototype, 'cssText');
      globalThis.snapshotReads = 0;
      Object.defineProperty(CSSRule.prototype, 'cssText', { ...descriptor, get() { globalThis.snapshotReads++; return descriptor.get.call(this); } });
    });
    for (let i = 0; i < 3; i++) await capture.observe(0);
    const before = await capture.page.evaluate(() => globalThis.snapshotReads);
    assert.ok(before > 0);
    for (let i = 0; i < 12; i++) assert.equal(await capture.observe(i / 12), false);
    assert.equal(await capture.page.evaluate(() => globalThis.snapshotReads), before);
    await capture.page.evaluate(() => document.styleSheets[0].insertRule('#box { opacity:.7 }', 0));
    assert.equal(await capture.observe(1), true);
    for (let i = 0; i < 3; i++) await capture.observe(1);
    assert.ok(await capture.page.evaluate(() => globalThis.snapshotReads) > before);
  } finally { await capture.close(); }
});

test('hard cuts disallow reuse on both sides, even with equal pixels', async () => {
  const shot = await fixture('cut', html().replace('cuts:[]', 'cuts:[1]'));
  const capture = await openShot(shot);
  try {
    const processed = createPostCapture(capture, { transport: 'raw', 'motion-blur': 6 });
    for (let frame = 0; frame < 16; frame++) {
      const before = processed.staticReuse.reusedFrames;
      await processed.frame(frame / 12, frame);
      if ([11, 12, 13].includes(frame)) assert.equal(processed.staticReuse.reusedFrames, before);
    }
    assert.ok(processed.staticReuse.reusedFrames > 0);
    assert.deepEqual((await pixels(shot, { 'motion-blur': 6 })).frames, (await pixels(shot, { 'motion-blur': 6, 'no-static-reuse': true })).frames);
  } finally { await capture.close(); }
});

fullTest('three layer rendering remains identical with reuse enabled', { timeout: 120000 }, async () => {
  const options = { 'motion-blur': 2, grain: 2 };
  const off = await pixels('examples/three-cards.html', { ...options, 'no-static-reuse': true }, 6);
  const on = await pixels('examples/three-cards.html', options, 6);
  assert.deepEqual(on.frames, off.frames);
  assert.equal(on.report.reusedFrames, 0);
});

test('late audit repairs all speculative frames and disables the shared job once', async () => {
  const options = {}, state = reuseState(options), warnings = [];
  const solid = value => encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, value) });
  const capture = { width: 2, height: 2, duration: 2, cuts: [], fps: 12, post: {},
    observe: async () => false, frame: async t => solid(t < 0.4 ? 20 : 100) };
  const processed = createPostCapture(capture, { ...options, transport: 'raw', onWarning: w => warnings.push(w) });
  const output = [];
  async function* source(first, end) {
    for (let frame = first; frame < end; frame++) yield { frame, png: await processed.frame(frame / 12, frame, frame === end - 1) };
  }
  for await (const item of verifiedFrames(source, options, 24)) output.push(item.png);
  for (let frame = 0; frame < 24; frame++) assert.deepEqual(output[frame], Buffer.alloc(16, frame / 12 < 0.4 ? 20 : 100));
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].details, { frame: 16, t: 16 / 12 });
  assert.equal(Atomics.load(state, 0), 1);
  assert.deepEqual(reuseReport(options), { enabled: false, reusedFrames: 0, verifiedFrames: 2, disabledReason: 'pixel_mismatch', observationReasons: {} });
});

test('lossless staging preserves repeated frames and independent output buffers', async () => {
  const buffer = Buffer.alloc(128);
  async function* source(first, end) {
    for (let frame = first; frame < end; frame++) {
      buffer.fill(Math.floor(frame / 4));
      yield { frame, png: buffer };
    }
  }
  for await (const item of verifiedFrames(source, { transport: 'raw' }, 12)) {
    assert.deepEqual(item.png, Buffer.alloc(128, Math.floor(item.frame / 4)));
    item.png.fill(255);
  }
});

test('audited intervals publish early and only the failing interval is recaptured', async () => {
  const options = { transport: 'raw' }, calls = [], warnings = [];
  reuseState(options);
  const capture = { width: 2, height: 2, duration: 8, cuts: [], fps: 12, post: {}, observe: async () => false,
    frame: async t => encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, t * 12 < 40 ? 20 : 100) }) };
  const processed = createPostCapture(capture, { ...options, onWarning: warning => warnings.push(warning) });
  async function* source(first, end) {
    calls.push([first, end]);
    for (let frame = first; frame < end; frame++) yield { frame, png: await processed.frame(frame / 12, frame, frame === end - 1) };
  }
  let delivered = 0;
  for await (const item of verifiedFrames(source, options, 73)) {
    if (!delivered) assert.deepEqual(calls, [[0, 17]], 'first interval must publish before rendering the rest');
    assert.deepEqual(item.png, Buffer.alloc(16, item.frame < 40 ? 20 : 100));
    delivered++;
  }
  assert.equal(delivered, 73);
  assert.deepEqual(calls, [[0, 17], [17, 33], [33, 49], [33, 49], [49, 65], [65, 73]]);
  assert.deepEqual(warnings.map(warning => warning.details.frame), [48]);
});

test('a final partial interval audits its last candidate before publishing', async () => {
  const options = { transport: 'raw' }, warnings = [];
  reuseState(options);
  const capture = { width: 2, height: 2, duration: 1, cuts: [], fps: 12, post: {}, observe: async () => false,
    frame: async t => encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, t * 12 < 6 ? 20 : 100) }) };
  const processed = createPostCapture(capture, { ...options, onWarning: warning => warnings.push(warning) });
  async function* source(first, end) {
    for (let frame = first; frame < end; frame++) yield { frame, png: await processed.frame(frame / 12, frame, frame === end - 1) };
  }
  for await (const item of verifiedFrames(source, options, 9)) assert.deepEqual(item.png, Buffer.alloc(16, item.frame < 6 ? 20 : 100));
  assert.deepEqual(warnings.map(warning => warning.details.frame), [8]);
});

fullTest('worker buffers stay intact and reports aggregate across workers', { timeout: 120000 }, async () => {
  const shot = await fixture('pool', html('', change));
  const off = await pixels(shot, { 'no-static-reuse': true, grain: 2, 'motion-blur': 6 });
  const pool = createRenderPool(shot, { transport: 'raw', grain: 2, 'motion-blur': 6 }, 12, 2, { width: 64, height: 48 });
  try {
    for await (const item of pool.frames(0, 24)) assert.deepEqual(Buffer.from(item.png), off.frames[item.frame]);
    assert.ok(pool.staticReuse.reusedFrames > 0);
  } finally { await pool.close(); }
});

let lateAuditPromise;
function lateAuditFixture() {
  return lateAuditPromise ??= (async () => {
    const shot = await fixture('late-audit', html('', change.replace('t<1', 't<0.4'),
      `if(globalThis.__multiplaneStatic)globalThis.__multiplaneStatic.read=()=>false;`));
    return { shot, reference: await pixels(shot, { 'no-static-reuse': true }) };
  })();
}

fullTest('real worker and stills audits repair earlier wrong frames before publishing', { timeout: 120000 }, async () => {
  const { shot, reference } = await lateAuditFixture();
  for (const workers of [1, 2]) {
    const warnings = [];
    const pool = createRenderPool(shot, { transport: 'raw' }, 12, workers, { width: 64, height: 48 }, w => warnings.push(w));
    try {
      for await (const item of pool.frames(0, 24)) assert.ok(Buffer.from(item.png).equals(reference.frames[item.frame]), `workers=${workers}, frame=${item.frame}`);
      assert.equal(pool.staticReuse.disabledReason, 'pixel_mismatch');
      assert.deepEqual(warnings.map(w => w.code), ['static_reuse_disabled']);
      assert.equal(warnings[0].details.frame, workers === 1 ? 16 : 11);
    } finally { await pool.close(); }
  }
  const result = await stillsShot(shot, { every: 1 / 12, out: path.join(directory, 'late-stills'),
    'no-lint': true, 'job-dir': path.join(directory, 'jobs'), onEvent: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.staticReuse.disabledReason, 'pixel_mismatch');
  for (const still of result.data.stills) assert.deepEqual(decodePNG(await readFile(still.path)).data, reference.frames[still.frame]);
});

fullTest('render CLI repairs a late audit before encoding and reports raw frame hashes', { timeout: 120000 }, async () => {
  const { shot, reference } = await lateAuditFixture();
  const hashes = path.join(directory, 'render-hashes.json');
  const result = await run(process.execPath, ['bin/multiplane', 'render', shot, '--static-reuse', '--workers', '1', '--no-lint',
    '--out', path.join(directory, 'late.mp4'), '--job-dir', path.join(directory, 'jobs'), '--json'],
  { env: { ...process.env, RENDER_FRAME_HASHES: hashes } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.code === 'static_reuse_disabled').length, 1);
  assert.equal(events.at(-1).data.staticReuse.disabledReason, 'pixel_mismatch');
  for (const item of JSON.parse(await readFile(hashes, 'utf8'))) assert.equal(item.sha256, createHash('sha256').update(reference.frames[item.frame]).digest('hex'));
});

fullTest('verify defaults to true captures; explicit reuse also compares on/off for one and two workers', { timeout: 120000 }, async () => {
  const shot = await fixture('verify', html('', change));
  for (const enable of [false, true]) {
    const result = await verifyShot(shot, { 'static-reuse': enable, workers: 2, at: '0,1.5',
      'motion-blur': 6, grain: 2, out: path.join(directory, 'verify-' + enable), 'job-dir': path.join(directory, 'jobs'), onEvent: () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.staticReuse.enabled, enable);
    for (const name of ['reorder', 'reload', 'workers:1', 'workers:2', 'range']) assert.ok(result.data.checks.some(check => check.name === name && check.passed));
    if (enable) {
      assert.ok(result.data.staticReuse.reusedFrames > 0);
      assert.ok(result.data.checks.some(check => check.name === 'static-reuse:workers:2' && check.passed));
    }
  }
});

test('CLI accepts reuse boolean switches and rejects conflicts', async () => {
  assert.throws(() => reuseEnabled({ 'static-reuse': true, 'no-static-reuse': true }), /mutually exclusive/);
  for (const command of ['render', 'stills', 'verify']) {
    const result = await run(process.execPath, ['bin/multiplane', command, '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--no-static-reuse(?: |\n|$)/);
    assert.doesNotMatch(result.stdout, /--(?:no-)?static-reuse <value>/);
  }
  const shot = await fixture('cli', html());
  const output = path.join(directory, 'cli-stills');
  const result = await run(process.execPath, ['bin/multiplane', 'stills', shot, '--no-static-reuse', '--at', '0,0.5', '--out', output, '--job-dir', path.join(directory, 'jobs'), '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).data.staticReuse.enabled, false);
  assert.ok((await readFile(path.join(output, 't-0.00.png'))).length > 0);
});
