import { chromium } from 'playwright';
import { isMainThread, parentPort } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (!isMainThread && process.env.MULTIPLANE_STALL_FIXTURE) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await launch(...args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      await page.addInitScript(value => { globalThis.__stall = value; }, Number(process.env.MULTIPLANE_STALL_COUNT) > 0);
      const marker = path.join(process.env.MULTIPLANE_STALL_FIXTURE, 'blocked');
      let failureTimer, rescue;
      page.on('console', message => {
        if (message.text() === 'stop-test-blocked') {
          writeFileSync(marker, '');
          // Bound regressions without killing unrelated processes or workers.
          rescue = setTimeout(() => browser.close(), 10000);
        }
        if (message.text() === 'stop-test-healthy' && process.env.STOP_STALL_MODE === 'failure' && !failureTimer) {
          failureTimer = setInterval(() => {
            if (!existsSync(marker) || !existsSync(path.join(process.env.MULTIPLANE_STALL_FIXTURE, 'fail-now'))) return;
            clearInterval(failureTimer);
            parentPort.postMessage({ type: 'failure', code: 'render_threw', error: 'Injected peer failure' });
          }, 10);
        }
      });
      browser.once('disconnected', () => { clearTimeout(rescue); clearInterval(failureTimer); });
      return page;
    };
    return browser;
  };
}
