import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { Updates } from '../src/main/updates.mjs';
import { FakeUpdater, reportFallback } from './updates-fake.mjs';

test('About controls drive the real update controller through a local double in both languages', { timeout: 45000 }, async ctx => {
  const browser = await chromium.launch(); ctx.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1160, height: 720 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const source = name => new URL(`../src/renderer/${name}`, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  await page.setContent((await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', ''));
  await page.addStyleTag({ content: await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  const fake = new FakeUpdater();
  let updates = new Updates({ platform: 'win32', packaged: true, version: '0.3.0', updater: fake });
  const publish = state => { void page.evaluate(state => window.updateSubscriber?.(state), state).catch(() => {}); };
  updates.publish = publish;
  let opened = 0;
  await page.exposeFunction('updateCall', async action => {
    if (action === 'state') return updates.state;
    if (action === 'release') { opened++; return; }
    return updates[action]();
  });
  await page.evaluate(() => {
    const own = { language: 'en', theme: 'light', wizardDone: true, autoCheckUpdates: true };
    const snapshot = { language: 'en', languagePreference: 'en', jobs: [], runningCount: 2, theme: 'light' };
    const settings = () => ({ values: {}, file: '/fixtures/config.json', own: { ...own }, overrides: {}, version: '0.3.0', packaged: true });
    window.multiplane = {
      reportFault: message => { throw Error(message); },
      platform: async () => ({ platform: 'win32', home: '/fixtures' }),
      settings: async () => settings(), saveSetting: async (key, value, personal) => { if (!personal) throw Error('Expected desktop preference'); own[key] = value; return settings(); },
      snapshot: async () => snapshot, subscribe: fn => { window.snapshotSubscriber = fn; return () => {}; },
      browserInstallState: async () => ({ running: false, text: '' }), onBrowserInstallState: () => () => {}, onSkillConfirmation: () => () => {},
      updateState: () => window.updateCall('state'), onUpdateState: fn => { window.updateSubscriber = fn; return () => {}; },
      checkUpdates: () => window.updateCall('check'), downloadUpdate: () => window.updateCall('download'), cancelUpdate: () => window.updateCall('cancel'), installUpdate: () => window.updateCall('install'), openRelease: () => window.updateCall('release')
    };
    window.changeLanguage = language => window.snapshotSubscriber({ ...snapshot, language, languagePreference: language });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const countBundle = await build({ stdin: { contents: `export { updateBusyCount } from './updates';`, resolveDir: fileURLToPath(new URL('../src/renderer/', import.meta.url)) }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'updateHelpers' });
  await page.addScriptTag({ content: countBundle.outputFiles[0].text });
  assert.equal(await page.evaluate(() => window.updateHelpers.updateBusyCount({ runningCount: 2, jobs: [{ state: 'running' }, { state: 'queued' }, { state: 'queued' }, { state: 'succeeded' }] })), 4);
  const phase = value => page.locator(`[data-update-phase="${value}"]`).waitFor();
  const click = action => page.locator(`[data-pref="update-${action}"]`).click();
  await page.locator('[data-page=about]').click(); await phase('idle');
  let finishCheck; fake.waitCheck = new Promise(resolve => { finishCheck = resolve; });
  await click('check'); await phase('checking'); finishCheck(); await phase('available'); fake.waitCheck = undefined;
  assert.equal(await page.locator('.notes img').count(), 0); assert.match(await page.locator('.notes').innerText(), /<img/);
  await click('release'); assert.equal(opened, 1);
  await page.locator('[data-page=jobs]').click(); await page.locator('#update-hint').click(); await phase('available');
  await click('download'); await phase('downloading');
  assert.match(await page.locator('.upd-head').innerText(), /Preparing to download/);
  assert.equal(await page.locator('progress').getAttribute('value'), null);
  fake.emit('download-progress', { percent: 44, transferred: 264000, total: 600000 });
  await page.waitForFunction(() => document.querySelector('progress')?.value === 44);
  assert.match(await page.locator('.upd-head').innerText(), /0\.3 \/ 0\.6 MB/);
  assert.equal(await page.locator('[data-full-download]').count(), 0);
  reportFallback(fake);
  await page.locator('[data-full-download]').waitFor();
  assert.equal(updates.state.fullDownloadReason, 'old-blockmap-missing');
  assert.equal(await page.locator('[data-full-download]').innerText(), 'Version 0.3.0 was not published on GitHub, so this update downloads the full installer. Later updates download only the changed parts.');
  await page.evaluate(() => window.changeLanguage('zh-CN'));
  await page.waitForFunction(() => document.querySelector('.upd-head').innerText.includes('正在下载'));
  assert.match(await page.locator('.upd-head').innerText(), /0\.3 \/ 0\.6 MB/);
  assert.equal(await page.locator('[data-full-download]').innerText(), '当前版本 0.3.0 没有在 GitHub 上公开发布，这次需要下载完整安装包。之后的更新只下载变化的部分。');
  assert.equal(await page.locator('.upd-tip').first().getAttribute('data-full-download'), '');
  const noticeOutput = new URL('../../out/079-full-download-notice/', import.meta.url);
  await mkdir(noticeOutput, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('fallback-zh.png', noticeOutput)) });
  reportFallback(fake, 'other');
  await page.waitForFunction(() => document.querySelector('[data-full-download]')?.textContent === '这次没法只下载变化的部分，需要下载完整安装包。');
  assert.equal(updates.state.fullDownloadReason, 'other');
  await page.evaluate(() => window.changeLanguage('en'));
  assert.equal(await page.locator('[data-full-download]').innerText(), 'This update cannot download only the changed parts, so it downloads the full installer.');
  await click('cancel'); await phase('available');
  assert.equal(await page.locator('[data-full-download]').count(), 0);
  await click('download'); await phase('downloading');
  assert.equal(await page.locator('[data-full-download]').count(), 0);
  fake.rejectDownload(Error('offline')); await phase('error');
  assert.match(await page.locator('.upd-head').innerText(), /Could not download/);
  fake.checkError = true; await click('check'); await phase('error'); assert.equal(updates.state.errorStage, 'check');
  fake.checkError = false; await click('check'); await phase('available');
  await click('download'); await phase('downloading'); fake.resolveDownload([]); await phase('downloaded');
  assert.match(await page.locator('.upd-head').innerText(), /2 jobs/);
  const output = new URL('../../out/051-updates/', import.meta.url); await mkdir(output, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('downloaded-en.png', output)) });
  await page.evaluate(() => window.changeLanguage('zh-CN')); await phase('downloaded');
  assert.match(await page.locator('.upd-head').innerText(), /2/);
  await page.screenshot({ path: fileURLToPath(new URL('downloaded-zh.png', output)) });
  await click('later'); assert.equal(await page.locator('#jobs').isVisible(), true); await page.locator('#update-hint').click(); await phase('downloaded');
  await click('install'); assert.equal(fake.installs, 1);
  await page.locator('[data-pref=autoCheckUpdates]').click(); assert.equal(await page.locator('[data-pref=autoCheckUpdates]').getAttribute('aria-checked'), 'false');
  updates = new Updates({ platform: 'darwin', packaged: true, version: '0.3.0', publish, fetcher: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.3.1', body: 'Local release notes.' }) }) });
  await updates.check(); await phase('manual'); assert.equal(await page.locator('[data-pref=update-install]').count(), 0);
  await click('release'); assert.equal(opened, 2);
  await page.screenshot({ path: fileURLToPath(new URL('manual-zh.png', output)) });
  await page.evaluate(() => window.changeLanguage('en')); await page.screenshot({ path: fileURLToPath(new URL('manual-en.png', output)) });
  updates.close(); assert.deepEqual(errors, []);
});
