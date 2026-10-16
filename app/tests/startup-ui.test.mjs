import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

async function fixture(ctx, { reduced = false, ready = false } = {}) {
  const browser = await chromium.launch(); ctx.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1160, height: 720 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  page.setDefaultTimeout(5000);
  const source = name => new URL(`../src/renderer/${name}`, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const mark = await readFile(new URL('../design/icons/mark.svg', import.meta.url), 'utf8');
  const html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '').replace('<!-- BRAND_MARK -->', mark.replace('<svg ', '<svg class="brand-mark" '));
  await page.setContent(html);
  await page.addStyleTag({ content: await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(ready => {
    document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.language = 'zh-CN';
    const state = { ready, language: 'zh-CN', hosted: false, theme: 'dark', runningCount: 0, jobs: [] };
    let subscriber;
    const settings = new Promise(resolve => { window.resolveSettings = () => resolve({ file: '/settings/config.json', values: {}, overrides: {}, own: { wizardDone: true, theme: 'dark' }, version: '0.3.7' }); });
    window.publishJobs = (count = 0) => {
      state.ready = true;
      state.jobs = Array.from({ length: count }, (_, i) => ({ jobId: `example-${i}`, jobDir: '/jobs/example', shot: `/examples/geometry-${i}.html`, command: 'stills', state: 'succeeded', startedAt: '2026-01-01T00:00:00Z', events: [], result: { artifacts: [], elapsedMs: 1000 } }));
      subscriber({ ...state });
    };
    window.multiplane = {
      platform: async () => ({ platform: 'win32', home: '/user' }), snapshot: async () => state, subscribe: fn => { subscriber = fn; },
      settings: () => settings, updateState: async () => ({ phase: 'development' }), browserInstallState: async () => ({ running: false, text: '' }),
      onUpdateState: () => {}, onBrowserInstallState: () => {}, onSkillConfirmation: () => {},
      doctor: async () => ({ data: { checks: [] } }), environment: async () => ({ command: {}, skills: [] }),
    };
    window.startedAt = performance.now();
    new MutationObserver(() => {
      if (document.body.classList.contains('boot-waiting') && !window.markerShownAt) window.markerShownAt = performance.now();
      if (window.markerShownAt && !document.body.classList.contains('boot-waiting') && !window.markerHiddenAt) window.markerHiddenAt = performance.now();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }, ready);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return { page, errors };
}

test('pending jobs show the delayed dark waiting state; jobs do not wait for settings', async ctx => {
  const { page, errors } = await fixture(ctx);
  assert.equal(await page.locator('#heading').innerText(), '作业');
  assert.equal(await page.locator('#list').innerText(), '');
  await page.waitForFunction(() => document.body.classList.contains('boot-waiting'));
  assert.ok(await page.evaluate(() => window.markerShownAt - window.startedAt) >= 300);
  await mkdir(new URL('../../out/083/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../out/083/dark-waiting-fixture.png', import.meta.url)) });
  await page.evaluate(() => window.publishJobs(12));
  await page.waitForFunction(() => !document.body.classList.contains('boot'));
  assert.ok(await page.evaluate(() => window.markerHiddenAt - window.markerShownAt) >= 499);
  assert.equal(await page.locator('[data-job]').count(), 12);
  assert.equal(await page.locator('[data-job]').first().evaluate(el => getComputedStyle(el).animationDelay), '0s');
  assert.equal(await page.locator('[data-job]').nth(10).evaluate(el => getComputedStyle(el).animationDelay), '0.16s');
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#placeholder [role=status]').count(), 1);
  await page.locator('[data-page=environment]').click();
  assert.equal(await page.locator('#placeholder [role=status]').count(), 1);
  await page.evaluate(() => window.resolveSettings());
  await page.locator('[data-page=settings]').click();
  await page.locator('#input-ffmpeg').waitFor();
  assert.deepEqual(errors, []);
});

test('fast empty snapshot skips the marker and reveals the actual empty state', async ctx => {
  const { page, errors } = await fixture(ctx, { ready: true });
  await page.waitForFunction(() => !document.body.classList.contains('boot'));
  assert.equal(await page.locator('.boot-wait').count(), 0);
  assert.notEqual(await page.locator('#list').innerText(), '');
  await page.evaluate(() => window.publishJobs(1));
  assert.equal(await page.locator('[data-job]').count(), 1);
  assert.deepEqual(errors, []);
});

test('reduced motion keeps the waiting mark and entrance static', async ctx => {
  const { page, errors } = await fixture(ctx, { reduced: true });
  await page.waitForFunction(() => document.body.classList.contains('boot-waiting'));
  assert.equal(await page.locator('.pl-front').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.evaluate(() => window.publishJobs(1));
  await page.waitForFunction(() => !document.body.classList.contains('boot'));
  assert.equal(await page.locator('[data-job]').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.deepEqual(errors, []);
});
