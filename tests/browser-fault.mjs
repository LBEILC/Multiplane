// Loaded only by crash-recovery subprocess tests, including their worker threads.
import { chromium } from 'playwright';
import { isMainThread } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.env.MULTIPLANE_TEST_FAULT_DIR;
if (root) {
  let injected = false;
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await launch(...args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args), evaluate = page.evaluate.bind(page);
      let samples = 0;
      page.evaluate = async (fn, arg) => {
        const scope = process.env.MULTIPLANE_TEST_FAULT_SCOPE;
        const selected = scope === 'all' || (scope === 'worker' ? !isMainThread : isMainThread);
        if (selected && !(injected && process.env.MULTIPLANE_TEST_FAULT_ONCE) && typeof arg?.motionBlur === 'number' && ++samples === 2) {
          for (let i = 0; i < Number(process.env.MULTIPLANE_TEST_FAULT_COUNT ?? 1); i++) {
            try { writeFileSync(path.join(root, `fault-${i}`), '', { flag: 'wx' }); }
            catch (error) { if (error.code === 'EEXIST') continue; throw error; }
            await page.close();
            injected = true;
            break;
          }
        }
        return evaluate(fn, arg);
      };
      return page;
    };
    return browser;
  };
}
