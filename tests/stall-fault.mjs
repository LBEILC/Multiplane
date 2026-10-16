// Test-only browser faults. The renderer never reads these environment variables.
import { chromium } from 'playwright';
import { isMainThread } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

if (!isMainThread && process.env.MULTIPLANE_STALL_FIXTURE) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await launch(...args);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      let stall = false;
      for (let i = 0; i < Number(process.env.MULTIPLANE_STALL_COUNT); i++) {
        try { writeFileSync(path.join(process.env.MULTIPLANE_STALL_FIXTURE, `stall-${i}`), '', { flag: 'wx' }); stall = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      await page.addInitScript(value => { globalThis.__stall = value; }, stall);
      if (stall && process.env.MULTIPLANE_STALL_PHASE === 'screenshot') {
        const session = page.context().newCDPSession.bind(page.context());
        page.context().newCDPSession = async (...args) => {
          const cdp = await session(...args), send = cdp.send.bind(cdp);
          cdp.send = async (method, params) => {
            if (method === 'Page.captureScreenshot') {
              // Remains pending until the actual browser is closed by recovery.
              await new Promise((resolve, reject) => browser.once('disconnected', () => reject(Error('Connection closed'))));
            }
            return send(method, params);
          };
          return cdp;
        };
      }
      return page;
    };
    return browser;
  };
}
