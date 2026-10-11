import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openShot } from '../src/capture.mjs';
import { createPostCapture } from '../src/post.mjs';
import { decodePNG } from '../src/png.mjs';
import { crashDetails, MAX_BROWSER_RESTARTS } from '../src/browser-recovery.mjs';
import { run, createTempDirectory } from './helpers.mjs';

const html = `<style>body{margin:0}#stage{width:64px;height:48px;background:#123}i{display:block;width:9px;height:11px;background:#fea}</style><div id="stage"><i></i></div><script>
window.SHOT={duration:1,fps:4,ready:Promise.resolve(),blurAt:()=>4,render(t){document.querySelector('i').style.transform='translateX('+Math.round(t*40)+'px)'}};
</script>`;
const options = { raster: 'software', 'motion-blur': 4, grain: 2, 'adaptive-blur': 0, 'no-lint': true };
async function fixture() {
  await mkdir('out/tests', { recursive: true });
  const root = createTempDirectory(path.resolve('out/tests/recovery-'));
  const shot = path.join(root, 'shot.html'); await writeFile(shot, html);
  return { root, shot };
}

test('recovery restarts every blur sample and preserves pixels, grain and statistics', async t => {
  const f = await fixture(), warnings = [];
  const capture = await openShot(f.shot, 1, { ...options, onWarning: warning => warnings.push(warning) });
  t.after(() => capture.close());
  const expected = decodePNG(await createPostCapture(capture, options).frame(0.5)).data;
  const begin = capture.beginFrame, times = [];
  capture.beginFrame = async (time, context) => {
    times.push(time);
    if (times.length === 2) await capture.page.close();
    return begin(time, context);
  };
  const processed = createPostCapture(capture, options);
  assert.deepEqual(decodePNG(await processed.frame(0.5)).data, expected);
  assert.deepEqual(times.slice(2), [times[0], times[1], 0.515625, 0.546875]);
  assert.equal(processed.stats.samples, 4); assert.equal(processed.stats.frames, 1);
  assert.deepEqual(warnings.map(w => [w.code, w.details.attempt, w.details.t]), [['browser_restarted', 1, 0.5]]);
});

for (const phase of ['blurAt', 'screenshot']) test(`${phase} closure is recovered without changing pixels`, async t => {
  const f = await fixture(), warnings = [], capture = await openShot(f.shot, 1, { ...options, capture: 'playwright', onWarning: w => warnings.push(w) });
  t.after(() => capture.close());
  const expected = decodePNG(await createPostCapture(capture, options).frame(0.5)).data;
  if (phase === 'blurAt') await capture.page.close();
  else { const page = capture.page, screenshot = page.screenshot.bind(page); page.screenshot = async (...args) => { await page.close(); return screenshot(...args); }; }
  assert.deepEqual(decodePNG(await createPostCapture(capture, options).frame(0.5)).data, expected);
  assert.equal(warnings.length, 1);
});

test('browser disconnect recovers an unhooked adaptive frame with sequential sampling and scaling', async t => {
  const f = await fixture(), warnings = [], settings = { ...options, scale: 2, 'render-scale': 1, 'adaptive-blur': 0.5, pipeline: false };
  await writeFile(f.shot, html.replace('blurAt:()=>4,', ''));
  const capture = await openShot(f.shot, 1, { ...settings, onWarning: w => warnings.push(w) });
  t.after(() => capture.close());
  const expected = decodePNG(await createPostCapture(capture, settings).frame(0.5));
  const frame = capture.frame; let samples = 0;
  capture.frame = async (...args) => { if (++samples === 2) await capture.browser.close(); return frame(...args); };
  const actual = decodePNG(await createPostCapture(capture, settings).frame(0.5));
  assert.deepEqual(actual, expected); assert.equal(actual.width, 128); assert.equal(warnings.length, 1);
});

for (const hook of ['render', 'blurAt']) test(`shot ${hook} throwing a transport-like message remains render_threw`, async t => {
  const f = await fixture(), warnings = [], capture = await openShot(f.shot, 1, { ...options, onWarning: w => warnings.push(w) });
  t.after(() => capture.close());
  await capture.page.evaluate(hook => { SHOT[hook] = () => { throw Error('Target page, context or browser has been closed'); }; }, hook);
  await assert.rejects(createPostCapture(capture, options).frame(0.5), error => error.code === 'render_threw' && error.exitCode === 1 && error.details.t !== undefined);
  assert.equal(warnings.length, 0);
});

test('two recoveries are allowed; the next crash is browser_crashed with exit code 4', async t => {
  const f = await fixture(), warnings = [], capture = await openShot(f.shot, 1, { ...options, onWarning: w => warnings.push(w) });
  t.after(() => capture.close());
  const begin = capture.beginFrame;
  capture.beginFrame = async (...args) => { await capture.page.close(); return begin(...args); };
  await assert.rejects(createPostCapture(capture, options).frame(0.5), error => error.code === 'browser_crashed' && error.exitCode === 4 && error.details.t === 0.5);
  assert.deepEqual(warnings.map(w => w.details.attempt), [1, MAX_BROWSER_RESTARTS]);
});

test('restart load failure is browser_crashed; cancellation never restarts', async t => {
  const f = await fixture(), warnings = []; let cancelled = false;
  const capture = await openShot(f.shot, 1, { ...options, onWarning: w => warnings.push(w), check: () => { if (cancelled) throw Object.assign(Error('cancelled'), { code: 'cancelled' }); } });
  t.after(() => capture.close());
  await writeFile(f.shot, '<div>invalid shot</div>');
  await capture.page.close();
  await assert.rejects(createPostCapture(capture, options).frame(0.5), { code: 'browser_crashed', exitCode: 4 });
  cancelled = true;
  await assert.rejects(createPostCapture(capture, options).frame(0.5), { code: 'cancelled' });
  assert.equal(warnings.length, 0);
});

test('crash diagnostics retain exit and bounded stderr but omit launch arguments', () => {
  const error = Error('page.evaluate: Target closed\n<launching> chromium --secret-profile=ignored\n' + Array.from({ length: 40 }, (_, i) => `[pid=7][err] ${i} ${'x'.repeat(300)}`).join('\n') + '\n[pid=7] <process did exit: exitCode=9, signal=SIGKILL>');
  const details = crashDetails(error, 0.5);
  assert.equal(details.exitCode, 9); assert.equal(details.signal, 'SIGKILL');
  assert.ok(details.stderr.length <= 4000); assert.ok(details.stderr.split('\n').length <= 20);
  assert.doesNotMatch(JSON.stringify(details), /secret-profile|launching/);
});

for (const [command, scope] of [['stills', 'main'], ['verify', 'main'], ['verify', 'worker'], ['render', 'worker']]) {
  test(`${command} ${scope} crash recovers in the job, including worker transport`, { timeout: 90000 }, async () => {
    const f = await fixture();
    if (command === 'render') await writeFile(f.shot, html.replace('fps:4', 'fps:8'));
    const common = [command, f.shot, '--raster', 'software', '--no-lint', '--motion-blur', '4', '--grain', '2', '--json', '--job-dir', path.join(f.root, 'jobs')];
    const args = command === 'render' ? [...common, '--workers', '2'] : command === 'verify' ? [...common, '--at', '0,0.5', '--workers', '2'] : [...common, '--at', '0.5'];
    const result = await run(process.execPath, ['--import', './tests/browser-fault.mjs', 'bin/multiplane', ...args], { env: { ...process.env, MULTIPLANE_TEST_FAULT_DIR: f.root, MULTIPLANE_TEST_FAULT_SCOPE: scope, ...(command === 'render' ? { MULTIPLANE_TEST_FAULT_COUNT: '2', MULTIPLANE_TEST_FAULT_ONCE: '1' } : {}) } });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const events = result.stdout.trim().split('\n').map(JSON.parse), warnings = events.filter(e => e.code === 'browser_restarted');
    assert.deepEqual(warnings.map(w => w.details.attempt).sort(), command === 'render' ? [1, 2] : [1]);
    assert.equal(events.at(-1).ok, true);
    if (command === 'verify') { assert.equal(events.at(-1).data.passed, true); assert.equal(events.at(-1).data.findings, 0); }
    if (command === 'stills') {
      const capture = await openShot(f.shot, 1, options);
      try { assert.deepEqual(decodePNG(await readFile(events.at(-1).data.stills[0].path)).data, decodePNG(await createPostCapture(capture, options).frame(0.5)).data); }
      finally { await capture.close(); }
    }
  });
}

test('main capture and successive worker pools share a single job recovery limit', { timeout: 90000 }, async () => {
  const f = await fixture();
  const result = await run(process.execPath, ['--import', './tests/browser-fault.mjs', 'bin/multiplane', 'verify', f.shot, '--raster', 'software', '--no-lint', '--motion-blur', '4', '--at', '0,0.5', '--workers', '2', '--json', '--job-dir', path.join(f.root, 'jobs')], { env: { ...process.env, MULTIPLANE_TEST_FAULT_DIR: f.root, MULTIPLANE_TEST_FAULT_SCOPE: 'all', MULTIPLANE_TEST_FAULT_COUNT: '3', MULTIPLANE_TEST_FAULT_ONCE: '1' } });
  assert.equal(result.code, 4, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.code === 'browser_restarted').map(e => e.details.attempt).sort(), [1, 2]);
  assert.equal(events.at(-1).code, 'browser_crashed');
});

test('verify still detects a stateful shot after recovering a browser', { timeout: 90000 }, async () => {
  const f = await fixture();
  await writeFile(f.shot, html.replace('Math.round(t*40)', '(window.counter=(window.counter||0)+1)'));
  const result = await run(process.execPath, ['--import', './tests/browser-fault.mjs', 'bin/multiplane', 'verify', f.shot, '--raster', 'software', '--no-lint', '--motion-blur', '4', '--at', '0,0.5', '--json', '--job-dir', path.join(f.root, 'jobs')], { env: { ...process.env, MULTIPLANE_TEST_FAULT_DIR: f.root, MULTIPLANE_TEST_FAULT_SCOPE: 'main' } });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.code === 'browser_restarted').length, 1);
  assert.equal(events.at(-1).code, 'nondeterministic_output');
  assert.equal(events.at(-1).data.passed, false);
});
