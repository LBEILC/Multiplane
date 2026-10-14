import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demo } from './demo.mjs';
import { ensureElectron } from './electron.mjs';
import en from '../src/shared/copy/en.mjs';
import zh from '../src/shared/copy/zh-CN.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.join(root, 'out/029-i18n'); await mkdir(out, { recursive: true });
const fixture = await demo();
const user = await mkdtemp(path.join(out, 'fixture-user-'));
Object.assign(fixture.env, { MULTIPLANE_TEST_USER_HOME: user, USERPROFILE: user, HOME: user, CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude') });
await writeFile(path.join(fixture.appData, 'preferences.json'), JSON.stringify({ language: 'en', theme: 'light', notifications: true, wizardDone: true, hidden: [] }));
for (const host of ['.claude', '.codex']) await mkdir(path.join(fixture.env.MULTIPLANE_TEST_USER_HOME, host), { recursive: true });
const application = await _electron.launch({ executablePath: await ensureElectron(), args: [path.join(root, 'app')], env: fixture.env });
const evidence = { screenshots: [], checks: [], layouts: [], nativeDialogs: [], pageErrors: [] };
try {
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => evidence.pageErrors.push(e.message));
  await page.locator('[data-job]').first().waitFor();
  await page.evaluate(() => { window.documentMarker = 'unchanged'; });
  const pid = await application.evaluate(({ app }) => process.pid);
  // Public, protocol-shaped environment fixtures; preference, job and skill IPC stay real.
  await application.evaluate(({ ipcMain, dialog, Notification }) => {
    globalThis.downloads = [];
    globalThis.notifications = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.notifications.push(this.title); };
    dialog.showMessageBox = async (_window, options) => { globalThis.downloads.push(options); return { response: 0, checkboxChecked: false }; };
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, code: 'ffmpeg_not_found', data: { checks: [
      { name: 'node', ok: true, detail: 'Node v24.21.0; version 24 or newer is required.' },
      { name: 'browser', ok: false, detail: 'Chromium is not installed.', hint: 'Install Chromium with Playwright.' },
      { name: 'gpu', ok: true, detail: 'Hardware rasterization is available.' },
      { name: 'ffmpeg', ok: false, detail: 'FFmpeg executable was not found.' },
      { name: 'libx264', ok: false, detail: 'Encoder availability depends on FFmpeg.' },
      { name: 'three', ok: false, detail: 'Optional three.js is not installed.' }
    ], config: { path: '/Multiplane/config.json', exists: false, applied: [] } } }));
  });
  await page.evaluate(() => window.multiplane.skill('claude', 'install'));
  const skill = path.join(fixture.env.MULTIPLANE_TEST_USER_HOME, '.claude/skills/multiplane');
  await writeFile(path.join(skill, 'custom.txt'), 'Local modification for confirmation testing.');
  const ids = Object.fromEntries(['running', 'success', 'failed', 'cancelled', 'verify', 'lost', 'stills'].map((name, i) => [name, `demo-20261011-${String(i + 1).padStart(3, '0')}`]));
  // Screenshot-only redaction respects clipping and cannot cover a foreground dialog.
  const redaction = '.path-value .mono, [data-host-card] .mono, .info-row .mono, .setting-row .mono, .job-id { visibility: hidden !important; } .path-input, .path-input::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }';
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
      const overflow = Array.from(document.querySelectorAll('main, #jobs, .list-pane, #detail, #placeholder, .card, .wizard, dialog[open]')).filter(visible).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.id || el.className);
      const clippedLabels = Array.from(document.querySelectorAll('.sel span')).filter(visible).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent);
      const wrappedButtons = Array.from(document.querySelectorAll('button:not(.job)')).filter(visible).filter(el => {
        if (el.querySelector('img')) return false;
        const range = document.createRange(); range.selectNodeContents(el);
        const lines = new Set(Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top / 3)));
        return lines.size > 2;
      }).map(el => el.textContent);
      return { overflow, clippedLabels, wrappedButtons, width: innerWidth, height: innerHeight };
    });
    evidence.layouts.push({ name, ...layout });
    assert.deepEqual(layout.overflow, [], `${name}: horizontal overflow`);
    assert.deepEqual(layout.clippedLabels, [], `${name}: truncated selector`);
    assert.deepEqual(layout.wrappedButtons, [], `${name}: wrapped button`);
    await page.screenshot({ path: path.join(out, `${name}.png`), style: redaction });
    evidence.screenshots.push(`${name}.png`);
  }
  async function language(locale, copy) {
    await page.locator('[data-page=settings]').click();
    await page.locator('[data-select=language]').click();
    await page.getByRole('option', { name: locale === 'en' ? 'English' : zh.languageChinese, exact: true }).click();
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    assert.equal(await page.locator('#heading').innerText(), copy.settings);
    const prefs = JSON.parse(await readFile(path.join(fixture.appData, 'preferences.json'), 'utf8'));
    assert.equal(prefs.language, locale);
    const rendererConfig = await readFile(path.join(fixture.home, 'config.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e; });
    assert.equal(JSON.parse(rendererConfig).language, undefined);
  }
  for (const [locale, copy] of [['en', en], ['zh-CN', zh]]) {
    await language(locale, copy);
    for (const [theme, size] of [['light', 'default'], ['light', 'minimum'], ['dark', 'default'], ['dark', 'minimum']]) {
      await page.locator('[data-page=settings]').click();
      await page.locator('[data-select=theme]').click();
      await page.getByRole('option', { name: copy[theme], exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme && !document.querySelector('[data-select=theme]')?.disabled, theme);
      const [width, height] = size === 'minimum' ? [960, 600] : [1160, 720];
      await application.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), { width, height });
      const prefix = `${locale}-${theme}-${size}`;
      await page.locator('[data-page=jobs]').click();
      for (const state of ['running', 'success', 'failed', 'cancelled', 'verify', 'lost']) {
        await page.locator(`[data-job="${ids[state]}"]`).click();
        await page.locator('[data-tab=preview]').click();
        if (state === 'success') {
          await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 0.5; });
          await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && !video.seeking && video.currentTime === 0.5; });
        }
        if (state === 'verify') { await page.waitForFunction(() => Array.from(document.querySelectorAll('.triptych img')).every(el => el.naturalWidth > 0)); assert.equal(await page.locator('.bbox:not([hidden])').count(), 3); }
        await shot(`${prefix}-jobs-${state}`);
      }
      await page.locator('#state-filter').click(); await page.locator('[data-option="2"]').click();
      await shot(`${prefix}-jobs-filter-failed`);
      await page.locator('#state-filter').click(); await page.locator('[data-option="0"]').click();
      await page.locator('[data-page=environment]').click();
      await page.locator('[data-check=node]').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-pref=check]').disabled);
      await shot(`${prefix}-environment-renderer`);
      await page.locator('.skill-cards').scrollIntoViewIfNeeded();
      await shot(`${prefix}-environment-skills`);
      for (const operation of ['install', 'remove']) {
        await page.locator(`[data-host-card=claude] [data-operation=${operation}]`).click();
        await page.locator('dialog[open]').waitFor();
        await shot(`${prefix}-confirmation-${operation === 'install' ? 'replace' : 'remove'}`);
        await page.locator('[data-confirm=cancel]').click();
        await page.waitForFunction(() => !document.querySelector('[data-host-card=claude] [data-operation=remove]')?.disabled);
      }
      await page.locator('[data-page=settings]').click();
      await shot(`${prefix}-settings-renderer`);
      await page.locator('#setting-language').evaluate(el => el.scrollIntoView({ block: 'center' }));
      await shot(`${prefix}-settings-software`);
      await page.locator('[data-page=about]').click();
      await shot(`${prefix}-about`);
      await page.locator('[data-pref=wizard]').click();
      await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
      for (const step of [1, 2, 3]) {
        await page.waitForFunction(expected => document.querySelector('.wizard-body h2')?.textContent === expected, copy[step === 1 ? 'checkEnvironment' : step === 2 ? 'setupFfmpeg' : 'installAgentSkill']);
        assert.equal(await page.locator('.wizard-body h2').innerText(), copy[step === 1 ? 'checkEnvironment' : step === 2 ? 'setupFfmpeg' : 'installAgentSkill']);
        await shot(`${prefix}-wizard-${step}`);
        await page.locator('[data-pref=skip]').click();
      }
    }
    await page.locator('[data-page=environment]').click(); await page.locator('[data-pref=install-browser]').waitFor();
    await page.locator('[data-pref=install-browser]').click();
    await page.locator('[data-page=jobs]').click();
    await page.locator(`[data-job="${ids.running}"]`).click();
    await page.locator('[data-action=stop]').click();
    const dialogs = await application.evaluate(() => globalThis.downloads.splice(0));
    assert.equal(dialogs[0].message, copy.browserConfirm); assert.equal(dialogs[0].detail, copy.browserConfirmDetail);
    assert.deepEqual(dialogs[0].buttons, [copy.cancel, copy.downloadInstall]);
    assert.equal(dialogs[1].detail, copy.stopDetail); assert.deepEqual(dialogs[1].buttons, [copy.cancel, copy.stop]);
    evidence.nativeDialogs.push({ locale, browser: true, stop: true, defaultId: dialogs[0].defaultId });
  }
  // An already-open modal follows a language change through real preference IPC.
  await page.locator('[data-page=environment]').click(); await page.locator('[data-host-card=claude] [data-operation=remove]').click();
  await page.locator('dialog[open]').waitFor();
  await page.evaluate(() => window.multiplane.saveSetting('language', 'en', true));
  assert.equal(await page.locator('dialog h2').innerText(), en.removeSkillTitle.replace('{agent}', 'Claude Code'));
  await page.locator('[data-confirm=cancel]').click();
  for (const [locale, copy] of [['en', en], ['zh-CN', zh]]) {
    await page.evaluate(locale => window.multiplane.saveSetting('language', locale, true), locale);
    const jobId = `notification-${locale}`, jobDir = path.join(fixture.home, 'jobs', jobId);
    await mkdir(jobDir, { recursive: true });
    const original = JSON.parse(await readFile(path.join(fixture.home, 'jobs/running/status.json'), 'utf8'));
    const startedAt = new Date().toISOString(), status = { ...original, jobId, shot: path.join(fixture.home, 'notification.html'), startedAt, updatedAt: startedAt, previewFrame: null };
    await writeFile(path.join(jobDir, 'events.jsonl'), '');
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify(status));
    await appendFile(path.join(fixture.home, 'jobs.jsonl'), JSON.stringify({ schema: 'multiplane/1', event: 'start', jobId, jobDir }) + '\n');
    await page.locator('[data-page=jobs]').click(); await page.locator(`[data-job="${jobId}"] .running`).waitFor();
    status.state = 'succeeded'; status.result = { ok: true, elapsedMs: 1000, ts: new Date().toISOString(), artifacts: [], data: {} };
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify(status));
    await page.locator(`[data-job="${jobId}"] .succeeded`).waitFor();
    const title = await application.evaluate(() => globalThis.notifications.at(-1));
    assert.equal(title, copy.notification.replace('{status}', copy.completed).replace('{name}', 'notification.html'));
  }
  evidence.notifications = await application.evaluate(() => globalThis.notifications);
  assert.equal(await page.evaluate(() => window.documentMarker), 'unchanged');
  assert.equal(await application.evaluate(() => process.pid), pid);
  assert.deepEqual(evidence.pageErrors, []);
  evidence.checks.push('Language preference persisted independently of config.json; no restart or document reload', 'All four pages, all three wizard steps, native stop/download dialogs, notifications and open skill confirmation follow language', 'Both languages, both themes and both sizes pass horizontal-overflow, selector-clipping and button-wrapping checks');
  console.log(`Saved ${evidence.screenshots.length} screenshots; live-language smoke passed.`);
} finally {
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await application.close();
  // The fixture user only holds a generated skill copy; screenshots and evidence.json are the output.
  await rm(user, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.warn(`Could not remove ${user}: ${error.code || error.message}`));
}
