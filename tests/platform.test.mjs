import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOptions, browserHint, ffmpegHint, ffmpegName, stopSignals } from '../src/platform.mjs';
import { launchBrowser, environment, warnGpuFallback } from '../src/environment.mjs';
import { stopChild } from '../src/process.mjs';
import { spawn } from 'node:child_process';

test('platform options isolate native graphics backends and actionable installation hints', () => {
  for (const [platform, backend] of [['win32', 'd3d11'], ['darwin', 'metal'], ['linux', 'gl']]) {
    const opts = browserOptions('gpu', {}, platform);
    assert.ok(opts.args.includes('--use-angle=' + backend));
    assert.equal(opts.args.filter(arg => arg.startsWith('--use-angle=')).length, 1);
    assert.equal(stopSignals(platform).includes('SIGBREAK'), platform === 'win32');
    assert.equal(ffmpegName(platform), platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }
  assert.match(ffmpegHint('darwin'), /brew install ffmpeg/);
  assert.match(ffmpegHint('linux'), /apt-get install ffmpeg/);
  assert.match(ffmpegHint('win32'), /ffmpeg.org\/download/);
  assert.match(browserHint(false, 'linux'), /install-deps chromium/);
  assert.match(browserHint(true, 'linux'), /install chromium/);
});

const fakeBrowser = renderer => ({
  closed: false, version: () => 'test', async close() { this.closed = true; },
  async newBrowserCDPSession() { return { async send() { return { gpu: { auxAttributes: { glRenderer: renderer } } }; }, async detach() {} }; },
});
test('headless Linux relaunches unusable hardware as software and emits the existing warning', async () => {
  const first = fakeBrowser('unknown'), fallback = fakeBrowser('SwiftShader'), calls = [];
  const launcher = { async launch(options) { calls.push(options); return calls.length === 1 ? first : fallback; } };
  const browser = await launchBrowser({}, launcher, 'linux');
  assert.equal(browser, fallback); assert.equal(first.closed, true);
  assert.ok(calls[1].args.includes('--use-angle=swiftshader'));
  const events = []; warnGpuFallback({ emit: (...args) => events.push(args) }, await environment(browser));
  assert.equal(events[0][1].code, 'gpu_software_fallback');
});
test('Linux launch failure retries software; missing binaries and missing libraries stay actionable', async () => {
  let calls = 0;
  const browser = await launchBrowser({}, { async launch() { if (++calls === 1) throw Error('GPU process failed'); return fakeBrowser('SwiftShader'); } }, 'linux');
  assert.equal(calls, 2); await browser.close();
  calls = 0;
  await assert.rejects(launchBrowser({}, { async launch() { calls++; throw Error("Executable doesn't exist"); } }, 'linux'), { code: 'browser_not_installed' });
  assert.equal(calls, 1);
  await assert.rejects(launchBrowser({}, { async launch() { throw Error('Missing shared libraries'); } }, 'linux'), error => error.code === 'browser_launch_failed' && /install-deps/.test(error.hint));
});
test('healthy Linux GPU does not fall back or change its browser', async () => {
  const native = fakeBrowser('ANGLE Mesa Intel');
  assert.equal(await launchBrowser({}, { launch: async () => native }, 'linux'), native);
  assert.equal(native.closed, false);
});
test('child termination waits for exit, including an ignored POSIX SIGTERM', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  await stopChild(child, 100);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
