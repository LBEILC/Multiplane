import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import en from '../src/shared/copy/en.mjs';
import zh from '../src/shared/copy/zh-CN.mjs';

test('live language changes preserve jobs, tabs, scroll and inputs and update all pages, wizard and an open confirmation', { timeout: 45000 }, async ctx => {
  const browser = await chromium.launch(); ctx.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const source = name => new URL(`../src/renderer/${name}`, import.meta.url);
  const bundle = await build({ entryPoints: [fileURLToPath(source('index.ts'))], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const html = (await readFile(source('index.html'), 'utf8')).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/g, '').replace('<script src="renderer.js"></script>', '');
  await page.setContent(html);
  await page.addStyleTag({ content: await readFile(new URL('../design/tokens.css', import.meta.url), 'utf8') });
  await page.addStyleTag({ content: await readFile(source('style.css'), 'utf8') });
  await page.evaluate(() => {
    window.marker = 'same-document';
    const own = { language: 'en', theme: 'light', wizardDone: true, notifications: false };
    const values = {};
    const snapshot = { language: 'en', languagePreference: 'en', runningCount: 1, theme: 'light', jobs: Array.from({ length: 25 }, (_, i) => ({ jobId: `job-${i}`, jobDir: '/jobs/test', shot: `/projects/shot-${i}.html`, state: i === 0 ? 'running' : 'succeeded', command: 'render', done: 30, total: 60, fps: 12.5, etaMs: 2400, startedAt: '2026-01-01T00:00:00Z', previewFrame: null, events: Array.from({ length: 30 }, () => ({ type: 'warning', ts: '2026-01-01T00:00:00Z', message: 'Renderer message stays in English.', code: 'example_warning' })) })) };
    let subscriber, confirmation;
    const settings = () => ({ values: { ...values }, file: '/settings/config.json', own: { ...own }, overrides: {}, version: '1.0.0' });
    window.changeLanguage = value => { own.language = value; snapshot.language = value; snapshot.languagePreference = value; subscriber({ ...snapshot }); };
    window.confirmSkill = () => confirmation({ id: 1, titleKey: 'removeSkillTitle', detailKey: 'removeSkillDetail', actionKey: 'remove', values: { agent: 'Codex' }, danger: true });
    window.multiplane = {
      platform: async () => ({ platform: 'win32', home: '/user' }),
      snapshot: async () => snapshot, subscribe: fn => { subscriber = fn; return () => {}; },
      settings: async () => settings(),
      saveSetting: async (key, value, personal) => { (personal ? own : values)[key] = value; if (key === 'language') window.changeLanguage(value); return settings(); },
      browserInstallState: async () => ({ running: false, text: '' }), onBrowserInstallState: () => () => {},
      onSkillConfirmation: fn => { confirmation = fn; return () => {}; }, answerSkillConfirmation: async () => {},
      doctor: async () => ({ data: { checks: [{ name: 'ffmpeg', ok: false, detail: 'FFmpeg was not found.', hint: 'Choose an executable.' }] } }),
      environment: async () => ({ command: {}, skills: [{ host: 'codex', target: '/skills/multiplane', state: 'modified', detected: true, version: '1.0.0', availableVersion: '1.0.0' }] })
    };
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('[data-job="job-1"]').click();
  await page.locator('[data-tab=events]').click();
  await page.evaluate(() => { document.querySelector('#list').scrollTop = 180; document.querySelector('#detail').scrollTop = 200; });
  await page.evaluate(() => window.changeLanguage('zh-CN'));
  assert.equal(await page.locator('[data-job="job-1"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('[data-tab=events]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#list').scrollTop, document.querySelector('#detail').scrollTop]), [180, 200]);
  assert.equal(await page.locator('#heading').innerText(), zh.jobs);
  assert.equal(await page.locator('[data-tab=events]').innerText(), zh.events);
  await page.evaluate(() => window.changeLanguage('en'));
  assert.equal(await page.locator('#heading').innerText(), en.jobs);
  for (const id of ['environment', 'settings', 'about', 'jobs']) {
    await page.locator(`[data-page=${id}]`).click();
    for (const [locale, copy] of [['zh-CN', zh], ['en', en]]) {
      await page.evaluate(locale => window.changeLanguage(locale), locale);
      assert.equal(await page.locator('#heading').innerText(), copy[id]);
      assert.equal(await page.locator(`[data-page=${id}]`).innerText(), copy[id]);
      if (id === 'environment') {
        await page.locator('[data-check=ffmpeg]').waitFor();
        assert.equal(await page.locator('[data-check=ffmpeg] .check-status').innerText(), locale === 'en' ? 'FFmpeg was not found.' : copy.notFound);
        assert.equal(await page.locator('[data-check=ffmpeg] .check-detail').count(), locale === 'en' ? 0 : 1);
      }
    }
  }
  await page.locator('[data-page=settings]').click();
  await page.locator('#input-ffmpeg').fill('/unsaved/ffmpeg');
  await page.evaluate(() => window.changeLanguage('zh-CN'));
  assert.equal(await page.locator('#input-ffmpeg').inputValue(), '/unsaved/ffmpeg');
  await page.locator('[data-select=language]').click();
  assert.deepEqual(await page.locator('[role=option]').allTextContents(), [zh.languageSystem, zh.languageChinese, zh.languageEnglish]);
  await page.locator('[data-option="2"]').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal((await page.evaluate(() => window.multiplane.settings())).own.language, 'en');
  await page.locator('[data-page=about]').click();
  await page.locator('[data-pref=wizard]').click();
  for (const [step, key] of [[1, 'checkEnvironment'], [2, 'setupFfmpeg'], [3, 'installAgentSkill']]) {
    for (const [locale, copy] of [['zh-CN', zh], ['en', en]]) {
      await page.evaluate(locale => window.changeLanguage(locale), locale);
      assert.equal(await page.locator('.wizard-body h2').innerText(), copy[key]);
    }
    if (step === 3) await page.locator('[data-host=codex]').check();
    await page.locator('[data-pref=skip]').click();
  }
  await page.evaluate(() => window.confirmSkill());
  for (const [locale, copy] of [['zh-CN', zh], ['en', en]]) {
    await page.evaluate(locale => window.changeLanguage(locale), locale);
    assert.equal(await page.locator('dialog h2').innerText(), copy.removeSkillTitle.replace('{agent}', 'Codex'));
    assert.equal(await page.locator('[data-confirm=cancel]').innerText(), copy.cancel);
    assert.equal(await page.locator('[data-confirm=accept]').innerText(), copy.remove);
  }
  await page.locator('[data-confirm=cancel]').click();
  assert.equal(await page.evaluate(() => window.marker), 'same-document');
  assert.deepEqual(errors, []);
});
