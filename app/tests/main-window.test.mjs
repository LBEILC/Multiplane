import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMainWindow, waitForMainWindow } from '../tools/main-window.mjs';

const page = url => ({ url: () => url });
const tray = page('file:///application/tray.html');
const main = page('file:///application/index.html?theme=dark&language=en');

test('main page selection ignores tray and devtools regardless of creation order', () => {
  for (const pages of [[tray, main], [main, tray], [page('about:blank'), tray, main, page('devtools://devtools/index.html')]]) {
    assert.equal(selectMainWindow(pages), main);
  }
  assert.equal(selectMainWindow([tray]), undefined);
  assert.throws(() => selectMainWindow([main, page(main.url())]), /Multiple main/);
});

test('main page selection waits for navigation instead of accepting the first tray page', async () => {
  let time = 0;
  assert.equal(await waitForMainWindow(() => time < 20 ? [tray, page('about:blank')] : [tray, main], {
    timeout: 30, interval: 10, now: () => time, sleep: async ms => { time += ms; }
  }), main);
  assert.equal(time, 20);
});

test('missing main page fails with a bounded timeout', async () => {
  let time = 0;
  await assert.rejects(waitForMainWindow(() => [tray], {
    timeout: 20, interval: 10, now: () => time, sleep: async ms => { time += ms; }
  }), /Main application page did not load/);
});
