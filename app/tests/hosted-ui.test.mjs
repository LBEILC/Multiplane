import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('hosted UI shows ordered queue, stuck state, stop actions and persistent hosting controls', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1160, height: 720 } });
  await page.route('https://multiplane.test/**', async route => {
    const file = new URL(route.request().url()).pathname;
    const asset = file === '/fonts/MiSansVF.ttf' ? new URL('../build/fonts/MiSansVF.ttf', import.meta.url)
      : file.startsWith('/icons/') ? new URL('../node_modules/remixicon/fonts/' + file.split('/').at(-1), import.meta.url) : null;
    try { if (!asset) return await route.abort(); await route.fulfill({ body: await readFile(asset), headers: { 'access-control-allow-origin': '*' } }); }
    catch { await route.abort(); }
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const source = name => new URL('../src/renderer/' + name, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  let html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '');
  html = html.replace('<!-- BRAND_MARK -->', (await readFile(new URL('../design/icons/mark.svg', import.meta.url), 'utf8')).replace('<svg ', '<svg class="brand-mark" '));
  await page.setContent(html.replace('<head>', '<head><base href="https://multiplane.test/">'));
  await page.addStyleTag({ content: await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  await page.addStyleTag({ content: (await readFile(new URL('../node_modules/remixicon/fonts/remixicon.css', import.meta.url), 'utf8')).replaceAll('url("', 'url("https://multiplane.test/icons/') });
  await page.evaluate(() => {
    const own = { language: 'zh-CN', theme: 'light', wizardDone: true, notifications: false }, values = { hosted: true };
    const base = { jobDir: '/demo/jobs', command: 'render', pid: 1, startedAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:30Z', hosted: true, events: [], done: 24, total: 100, fps: 12, etaMs: 5000 };
    let jobs = [{ ...base, jobId: 'queue-2', shot: '/demo/promo/cards.html', state: 'queued', queuePosition: 2 }, { ...base, jobId: 'completed', shot: '/demo/promo/ending.html', state: 'succeeded', hosted: false }, { ...base, jobId: 'queue-1', shot: '/demo/promo/title.html', state: 'queued', queuePosition: 1 }, { ...base, jobId: 'running', shot: '/demo/promo/opening.html', state: 'running' }];
    let subscriber;
    const snapshot = () => ({ jobs, hosted: values.hosted, runningCount: 1, language: 'zh-CN', theme: 'light' });
    const settings = () => ({ own, values, overrides: {}, version: '0.3.0', file: '/demo/config.json', packaged: true });
    window.stopped = [];
    window.stuck = () => { jobs[3].stuck = true; subscriber(snapshot()); };
    window.multiplane = {
      platform: async () => ({ platform: 'win32', home: '/demo' }), reportFault: () => {},
      snapshot: async () => snapshot(), subscribe: fn => { subscriber = fn; return () => {}; },
      settings: async () => settings(), saveSetting: async (key, value, local) => { (local ? own : values)[key] = value; subscriber(snapshot()); return settings(); },
      updateState: async () => ({ phase: 'current', version: '0.3.0' }), onUpdateState: () => () => {},
      browserInstallState: async () => ({ running: false, text: '' }), onBrowserInstallState: () => () => {}, onSkillConfirmation: () => () => {},
      stop: async id => window.stopped.push(id), media: () => '',
      doctor: async () => ({ data: { checks: [{ name: 'ffmpeg', ok: true }] } }), environment: async () => ({ command: {}, skills: [] })
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-job=running]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(await page.locator('[data-job]').evaluateAll(nodes => nodes.map(n => n.dataset.job)), ['running', 'queue-1', 'queue-2', 'completed']);
  assert.match(await page.locator('[data-job=queue-1]').innerText(), /排队中 · 第 1 个/);
  await page.locator('[data-job=queue-1]').click(); await page.locator('[data-action=stop]').click(); assert.deepEqual(await page.evaluate(() => window.stopped), ['queue-1']);
  const out = new URL('../../out/046/ui/', import.meta.url); await mkdir(out, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('queue.png', out)) });
  await page.evaluate(() => window.stuck()); await page.locator('[data-job=running]').click();
  assert.match(await page.locator('#banner').innerText(), /可能卡住了/);
  await page.screenshot({ path: fileURLToPath(new URL('stuck.png', out)) });
  await page.locator('#hosting-status').click();
  assert.equal(await page.locator('[data-pref=hosted]').getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: fileURLToPath(new URL('settings.png', out)) });
  await page.locator('[data-pref=hosted]').click(); assert.equal(await page.locator('[data-pref=hosted]').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#hosting-status').innerText(), '托管未开启');
  await page.locator('[data-page=about]').click(); await page.locator('[data-pref=wizard]').click();
  await page.locator('[data-pref=next]:not([disabled])').click(); await page.locator('[data-pref=next]').click();
  await page.locator('[data-pref=hosted]').waitFor();
  assert.equal(await page.locator('[data-pref=hosted]').getAttribute('aria-checked'), 'false');
  await page.screenshot({ path: fileURLToPath(new URL('wizard.png', out)) });
  assert.deepEqual(errors, []);
});
