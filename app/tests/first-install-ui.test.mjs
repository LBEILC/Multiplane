import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import en from '../src/shared/copy/en.mjs';
import zh from '../src/shared/copy/zh-CN.mjs';
import { completeFirstInstall } from '../tools/first-install-flow.mjs';

for (const ffmpegAvailable of [false, true]) test(`first launch retains snapshots ${ffmpegAvailable ? 'when FFmpeg skips step two' : 'through all three wizard steps'} and accepts subsequent jobs`, { timeout: 45000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const source = name => new URL(`../src/renderer/${name}`, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '');
  await page.setContent(html);
  await page.evaluate(ffmpegAvailable => {
    const own = { language: 'en', theme: 'light', wizardDone: false, notifications: true }, values = {};
    const jobs = Array.from({ length: 9 }, (_, i) => ({ jobId: `historical-${i}`, jobDir: '/fixtures/job', shot: '/fixtures/shot.html', state: 'succeeded', command: 'render', startedAt: '2025-01-02T03:04:05Z', events: [] }));
    const snapshot = () => ({ language: 'en', jobs: structuredClone(jobs), runningCount: 0, theme: 'light' });
    let subscriber;
    window.installed = []; window.saved = [];
    window.pushJobs = newer => { if (newer) jobs.push({ ...jobs[0], jobId: 'new-cli-job' }); subscriber(snapshot()); };
    const settings = () => ({ own: { ...own }, values: { ...values }, overrides: {}, version: '0.2.0', packaged: true });
    window.multiplane = {
      platform: async () => ({ platform: 'win32', home: '/fixtures' }),
      snapshot: async () => snapshot(), subscribe: fn => { subscriber = fn; return () => {}; },
      settings: async () => settings(),
      saveSetting: async (key, value, personal) => { (personal ? own : values)[key] = value; window.saved.push({ key, value }); subscriber(snapshot()); return { ...settings(), ...(key === 'ffmpeg' ? { check: { usable: true, version: 'ffmpeg version fixture', reason: null, encoders: { libx264: true } } } : {}) }; },
      checkFfmpeg: async () => { throw Error('Saving must reuse the config command check'); },
      browserInstallState: async () => ({ running: false, text: '' }), updateState: async () => ({ phase: 'development' }), onUpdateState: () => () => {}, onBrowserInstallState: () => () => {}, onSkillConfirmation: () => () => {},
      doctor: async () => ({ data: { checks: [{ name: 'ffmpeg', ok: ffmpegAvailable, detail: '' }] } }),
      environment: async () => ({ command: {}, skills: ['claude', 'codex'].map(host => ({ host, target: `/fixtures/${host}`, state: 'missing', detected: true })) }),
      skill: async host => { window.installed.push(host); subscriber(snapshot()); return {}; }
    };
  }, ffmpegAvailable);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.wizard').waitFor();
  await page.evaluate(() => window.pushJobs(false));
  await completeFirstInstall(page, '/fixtures/ffmpeg', ffmpegAvailable);
  assert.equal(await page.locator('[data-job]').count(), 9);
  assert.deepEqual(await page.evaluate(() => window.installed), ['claude', 'codex']);
  assert.deepEqual(await page.evaluate(() => window.saved), [...(ffmpegAvailable ? [] : [{ key: 'ffmpeg', value: '/fixtures/ffmpeg' }]), { key: 'wizardDone', value: true }]);
  await page.evaluate(() => window.pushJobs(true));
  await page.locator('[data-job=new-cli-job]').waitFor();
  assert.equal(await page.locator('[data-job]').count(), 10);
  assert.deepEqual(errors, []);
});

test('mixed jobs stay visible; saved FFmpeg paths are checked automatically in settings and wizard with localized feedback', { timeout: 45000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const source = name => new URL(`../src/renderer/${name}`, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '');
  await page.setContent(html);
  await page.addStyleTag({ content: await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  await page.evaluate(() => {
    const own = { language: 'en', theme: 'light', wizardDone: true, notifications: false }, values = {};
    const valid = { jobId: 'legacy', jobDir: '/fixtures/job', shot: '/fixtures/shot.html', state: 'succeeded', command: 'render', startedAt: '2025-01-02T03:04:05Z', events: [] };
    const snapshot = { language: 'en', languagePreference: 'en', jobs: [valid, { ...valid, jobId: 'missing-fields', startedAt: undefined, result: { artifacts: {} } }, { ...valid, jobId: 'invalid', shot: null }], runningCount: 0, theme: 'light' };
    let subscriber;
    const settings = () => ({ values: { ...values }, file: '/fixtures/config.json', own: { ...own }, overrides: {}, version: '0.2.0', packaged: true });
    window.faults = [];
    window.saved = [];
    window.changeLanguage = language => { own.language = language; snapshot.language = language; snapshot.languagePreference = language; subscriber({ ...snapshot }); };
    window.multiplane = {
      reportFault: error => window.faults.push(error),
      platform: async () => ({ platform: 'win32', home: '/fixtures' }),
      snapshot: async () => snapshot, subscribe: fn => { subscriber = fn; return () => {}; },
      settings: async () => settings(),
      saveSetting: async (key, value, personal) => { (personal ? own : values)[key] = value; window.saved.push({ key, value }); return settings(); },
      chooseSetting: async () => { values.ffmpeg = '/fixtures/chosen-ffmpeg'; return settings(); },
      checkFfmpeg: () => new Promise(resolve => { window.completeCheck = resolve; }),
      browserInstallState: async () => ({ running: false, text: '' }), updateState: async () => ({ phase: 'development' }), onUpdateState: () => () => {}, onBrowserInstallState: () => () => {},
      onSkillConfirmation: () => () => {},
      doctor: async () => ({ data: { checks: [{ name: 'ffmpeg', ok: false, detail: 'FFmpeg was not found.', hint: '--ffmpeg or PATH' }, { name: 'future', ok: 'maybe', detail: 'Future detail', hint: 'Future hint' }] } }),
      copyBundledCommand: async () => { window.copiedBundled = (window.copiedBundled ?? 0) + 1; },
      environment: async () => ({ command: { path: null, version: null, error: null, bundled: '"C:\\Program Files\\Multiplane\\multiplane.cmd"' }, skills: [] })
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-job=legacy]').waitFor();
  assert.equal(await page.locator('[data-job]').count(), 2);
  assert.ok((await page.evaluate(() => window.faults)).length >= 2);
  await page.locator('[data-job=missing-fields]').click();
  await page.locator('[data-tab=result]').click();
  await page.locator('[data-page=settings]').click();
  const save = async path => { await page.locator('#input-ffmpeg').fill(path); await page.locator('#input-ffmpeg').press('Tab'); await page.waitForFunction(() => window.completeCheck); };
  const finish = async result => { await page.evaluate(result => { window.completeCheck(result); window.completeCheck = undefined; }, result); await page.waitForFunction(() => !document.querySelector('#input-ffmpeg').disabled); };
  await save('/fixtures/missing');
  assert.equal(await page.locator('.ffmpeg-feedback').innerText(), en.checking);
  assert.deepEqual((await page.evaluate(() => window.saved)).at(-1), { key: 'ffmpeg', value: '/fixtures/missing' });
  await finish({ name: 'ffmpeg', ok: false, detail: '', reason: 'not-found' });
  assert.match(await page.locator('.ffmpeg-feedback').innerText(), /FFmpeg was not found/);
  assert.equal(await page.locator('#input-ffmpeg').inputValue(), '/fixtures/missing');
  await page.locator('[data-pref=choose][data-key=ffmpeg]').click(); await page.waitForFunction(() => window.completeCheck);
  assert.equal(await page.locator('.ffmpeg-feedback').innerText(), en.checking);
  await finish({ name: 'ffmpeg', ok: true, detail: 'ffmpeg version 9.0' });
  assert.equal(await page.locator('.ffmpeg-feedback .mono').innerText(), 'ffmpeg version 9.0');
  for (const locale of ['zh-CN', 'en']) {
    const copy = locale === 'en' ? en : zh;
    await page.locator('[data-page=settings]').click();
    await page.evaluate(locale => window.changeLanguage(locale), locale);
    assert.equal(await page.locator('.ffmpeg-feedback .check-detail').innerText(), copy.doctorFfmpegReady);
    await page.locator('[data-page=environment]').click();
    await page.locator('[data-check=future]').waitFor();
    assert.equal(await page.locator('[data-check=future] .check-detail').innerText(), 'Future hint');
    assert.equal(await page.locator('[data-check=ffmpeg] .check-detail').innerText(), copy.doctorFfmpegMissing);
    assert.doesNotMatch(await page.locator('[data-check=ffmpeg]').innerText(), /--ffmpeg|PATH/);
    await page.locator('[data-pref=copy-bundled]').click();
    assert.match(await page.locator('#placeholder').innerText(), new RegExp(copy.bundledCommand));
    assert.ok((await page.locator('#placeholder').innerText()).includes('C:\\Program Files\\Multiplane\\multiplane.cmd'));
  }
  assert.equal(await page.evaluate(() => window.copiedBundled), 2);
  await page.locator('[data-page=about]').click(); await page.locator('[data-pref=wizard]').click();
  await page.locator('[data-pref=next]').click(); await page.locator('#input-ffmpeg').waitFor();
  await save('/fixtures/not-executable'); await finish({ name: 'ffmpeg', ok: false, detail: '', reason: 'cannot-run', diagnostic: 'EACCES' });
  const out = new URL('../../out/037/ui/', import.meta.url); await mkdir(out, { recursive: true });
  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate(locale => window.changeLanguage(locale), locale);
    const copy = locale === 'en' ? en : zh;
    assert.equal(await page.locator('.ffmpeg-feedback .check-detail').innerText(), copy.doctorFfmpegUnusable);
    assert.equal(await page.locator('.ffmpeg-feedback .mono').innerText(), 'EACCES');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: fileURLToPath(new URL(`wizard-${locale}.png`, out)) });
  }
  assert.deepEqual(errors, []);
});
