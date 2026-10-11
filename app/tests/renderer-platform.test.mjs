import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const source = name => new URL(`../src/renderer/${name}`, import.meta.url);

test('renderer uses Darwin labels, home paths and brand spacing after delayed platform initialization', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  // Only this isolated browser page gets a mock bridge; production has no injection switch.
  const html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '');
  await page.setContent(html);
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  await page.evaluate(() => {
    const snapshot = { jobs: [{ jobId: 'test-job', shot: '/Users/test/shot.html', state: 'succeeded', command: 'render', startedAt: '2026-01-01T00:00:00Z', events: [], result: { artifacts: [{ path: '/Users/test/output.png', kind: 'still', bytes: 1 }] } }], runningCount: 0, theme: 'dark' };
    window.multiplane = {
      platform: () => new Promise(resolve => { window.resolvePlatform = () => resolve({ platform: 'darwin', home: '/Users/test' }); }),
      subscribe: fn => { fn(snapshot); return () => {}; },
      snapshot: async () => snapshot,
      settings: async () => ({ file: '/Users/test/config.json', values: {}, overrides: {}, own: { wizardDone: true, theme: 'system', notifications: false }, version: '0.0.0' }),
      browserInstallState: async () => ({ running: false, text: '' }),
      onBrowserInstallState: () => () => {}, onSkillConfirmation: () => () => {},
      doctor: async () => ({ data: { checks: [], config: { path: '/Users/test/config.json', exists: true } } }),
      environment: async () => ({ command: { path: '/Users/test/bin/multiplane', version: '0.0.0' }, skills: [] })
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-page="设置"]').click();
  assert.equal(await page.locator('#placeholder').innerHTML(), '');
  assert.equal(await page.locator('.titlebar > .brand-lockup').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.equal(await page.locator('[data-job]').count(), 0);
  await page.evaluate(() => window.resolvePlatform());
  await page.waitForFunction(() => document.documentElement.dataset.platform === 'darwin');
  await page.locator('[data-pref="open-config"]').waitFor();
  for (const name of ['设置', '环境']) {
    await page.locator(`[data-page="${name}"]`).click();
    await page.locator('[data-pref="open-config"]').waitFor();
    assert.equal(await page.locator('[data-pref="open-config"]').innerText(), '在访达中显示');
    assert.equal(await page.locator('.path-value > .mono').innerText(), '~/config.json');
    assert.equal(await page.getByRole('button', { name: '在访达中显示', exact: true }).count(), 1);
  }
  assert.equal(await page.locator('.titlebar > .brand-lockup').evaluate(el => getComputedStyle(el).paddingLeft), '78px');
  assert.equal(await page.locator('.titlebar > .brand-lockup').evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.equal(await page.locator('.info-row .mono').last().innerText(), '~/bin/multiplane');
  await page.locator('[data-page="作业"]').click();
  await page.getByRole('tab', { name: '结果', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '在访达中显示', exact: true }).count(), 1);
  assert.equal(await page.locator('.artifact .mono').innerText(), '~/output.png');
  assert.deepEqual(errors, []);
});
