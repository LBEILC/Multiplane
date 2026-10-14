import copy from '../src/shared/copy/en.mjs';
import releasePackage from '../../package.json' with { type: 'json' };
import { nativeRealpath } from '../../tools/native-realpath.mjs';
import { _electron } from 'playwright';
import { ensureElectron } from './electron.mjs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'out', '008-settings'); await mkdir(out, { recursive: true });
const work = await nativeRealpath(await mkdtemp(path.join(out, 'work-')));
const home = path.join(work, 'renderer'), data = path.join(work, 'desktop'), user = path.join(work, 'user');
for (const dir of [home, data, path.join(user, '.claude'), path.join(user, '.codex')]) await mkdir(dir, { recursive: true });
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user, USERPROFILE: user, HOME: user, CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude'), MULTIPLANE_FFMPEG: 'Z:/missing/ffmpeg.exe', MULTIPLANE_JOBS_DIR: 'D:/renders' };
delete env.ELECTRON_RUN_AS_NODE;
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ language: 'en', wizardDone: false }));
const app = await _electron.launch({ executablePath: await ensureElectron(), args: [path.join(root, 'app')], env });
const evidence = { screenshots: [], realDoctor: {}, checks: [] }, errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('.wizard').waitFor();
  const actual = await page.evaluate(() => window.multiplane.doctor());
  for (const name of ['node', 'browser', 'gpu', 'ffmpeg', 'libx264', 'three']) assert.ok(actual.data.checks.some(check => check.name === name));
  assert.match(actual.data.checks[0].detail, /Node v/);
  assert.equal(actual.data.config.path, path.join(home, 'config.json'));
  assert.equal(actual.data.checks.find(c => c.name === 'ffmpeg').ok, false);
  evidence.realDoctor = { checks: actual.data.checks.map(c => ({ name: c.name, ok: c.ok })), node: actual.data.checks[0].detail, isolatedConfig: true };
  await page.getByRole('button', { name: copy.next, exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
  assert.equal(await page.locator('[data-page]:enabled').count(), 0);
  await page.getByRole('button', { name: copy.chooseFfmpeg, exact: true }).click();
  await page.locator('#input-ffmpeg').waitFor();
  await page.getByRole('button', { name: copy.skip, exact: true }).click();
  await page.getByRole('checkbox', { name: /Claude Code/ }).waitFor();
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 2);
  const choice = page.getByRole('checkbox', { name: /Claude Code/ });
  await choice.focus(); await choice.press('Space'); assert.equal(await choice.isChecked(), false);
  assert.equal(await choice.evaluate(el => el === document.activeElement), true);
  await page.locator('.skill-choice').filter({hasText:'Claude Code'}).click(); assert.equal(await choice.isChecked(), true);
  await page.getByRole('button', { name: copy.done, exact: true }).click();
  await page.locator('.wizard').waitFor({ state: 'detached' });
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).wizardDone, true);
  for (const dir of ['.claude', '.agents']) assert.ok(await readFile(path.join(user, dir, 'skills', 'multiplane', 'SKILL.md')));
  evidence.checks.push('first launch, missing FFmpeg step, default selection, install, completion persistence');
  await page.locator('[data-page="settings"]').click();
  await page.getByLabel(copy.ffmpegPath, { exact: true }).fill('D:/tools/ffmpeg.exe'); await page.getByLabel(copy.ffmpegPath, { exact: true }).press('Tab');
  await page.waitForFunction(() => !document.querySelector('#input-ffmpeg').disabled);
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).ffmpeg, 'D:/tools/ffmpeg.exe');
  assert.match(await page.locator('#setting-ffmpeg > div:first-child small').innerText(), /Environment variable takes precedence/g);
  assert.ok((await page.locator('#setting-jobsDir small').innerText()).startsWith(copy.envPrecedence));
  await mkdir(path.join(home, 'config.json.tmp'));
  await page.getByLabel(copy.workers, { exact: true }).fill('3'); await page.getByLabel(copy.workers, { exact: true }).press('Tab');
  await page.locator('#placeholder [role=alert]').waitFor(); assert.equal(await page.getByLabel(copy.workers, { exact: true }).inputValue(), '');
  await rm(path.join(home, 'config.json.tmp'), { recursive: true });
  await page.getByRole('switch', { name: copy.notifyFinish }).click();
  await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false');
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).notifications, false);
  await page.getByRole('button', { name: copy.appearance, exact: true }).click();
  await page.getByRole('option', { name: copy.dark, exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).theme, 'dark');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['D:/selected/ffmpeg.exe'] }); });
  await page.locator('#setting-ffmpeg').getByRole('button', { name: copy.chooseFfmpeg }).click();
  await page.waitForFunction(() => document.querySelector('#input-ffmpeg').value === 'D:/selected/ffmpeg.exe');
  await page.getByRole('button', { name: copy.detect, exact: true }).click();
  await page.locator('.ffmpeg-feedback .check-status').waitFor();
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).ffmpeg, 'D:/selected/ffmpeg.exe');
  evidence.checks.push('config persisted, environment override rows, failed write restores input');
  evidence.checks.push('theme and notification preference persistence, browse selection, FFmpeg-only result');
  const target = path.join(user, '.claude', 'skills', 'multiplane');
  await writeFile(path.join(target, 'extra.md'), 'custom');
  await page.locator('[data-page="environment"]').click();
  await page.locator('[data-host-card=claude]').getByText(copy.modified).waitFor();
  const confirm = page.getByRole('dialog');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: copy.update }).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('h2').innerText(), copy.replaceSkillTitle.replace('{agent}', 'Claude Code'));
  assert.equal(await confirm.locator('h2').evaluate(el => getComputedStyle(el).fontWeight), '500');
  assert.equal(await confirm.locator('p').evaluate(el => getComputedStyle(el).fontWeight), '400');
  assert.equal(await confirm.getByRole('button', {name:copy.cancel}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await confirm.getByRole('button', {name:copy.replace}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await confirm.getByRole('button', {name:copy.cancel}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await confirm.waitFor({state:'detached'});
  await page.waitForFunction(() => !document.querySelector('[data-host-card=claude] button').disabled);
  assert.equal(await page.locator('[data-host-card=claude] [data-operation=install]').evaluate(el => el === document.activeElement), true);
  assert.equal(await readFile(path.join(target, 'extra.md'), 'utf8'), 'custom');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: copy.update }).click();
  await confirm.waitFor();
  const backupName = (await confirm.locator('p').innerText()).match(/multiplane\.bak-\d{8}-\d{6}(?:-\d+)?/)[0];
  assert.equal(await confirm.locator('button.primary').innerText(), copy.replace);
  await confirm.getByRole('button', {name:copy.replace, exact:true}).click();
  await page.locator('[data-host-card=claude]').getByText(copy.upToDate).waitFor();
  assert.equal(await readFile(path.join(path.dirname(target), backupName, 'extra.md'), 'utf8'), 'custom');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: copy.remove }).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('p').innerText(), copy.removeSkillDetail.replace('{agent}', 'Claude Code'));
  assert.equal(await confirm.locator('button.danger').innerText(), copy.remove);
  await confirm.getByRole('button', {name:copy.remove, exact:true}).click();
  await page.locator('[data-host-card=claude]').getByText(copy.notInstalled, { exact: true }).waitFor();
  evidence.checks.push('real checkbox Space/row click; modal cancel default, focus trap, Escape, exact backup name, replace/remove styles and IPC');
  // Use protocol-shaped public fixtures for screenshots; never expose machine paths.
  await app.evaluate(({ ipcMain }, { home, version }) => {
    globalThis.__ffmpeg = false;
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, code: 'ffmpeg_not_found', hint: 'Select an FFmpeg executable.', data: { checks: [
      { name: 'node', ok: true, detail: 'Node v24.21.0; version 24 or newer is required.' }, { name: 'browser', ok: true, detail: 'Chromium 145.0.7632.6 is available.' }, { name: 'gpu', ok: true, detail: 'Hardware rasterization is available.' },
      { name: 'ffmpeg', ok: globalThis.__ffmpeg, detail: globalThis.__ffmpeg ? 'FFmpeg is available.' : 'FFmpeg executable was not found.' }, { name: 'libx264', ok: globalThis.__ffmpeg, detail: 'Encoder list follows FFmpeg availability.' }, { name: 'three', ok: false, detail: 'Optional three.js is not installed.' }
    ], config: { path: 'D:/Multiplane/config.json', exists: true, applied: ['ffmpeg', 'raster', 'encoder', 'workers', 'jobsDir'] } } }));
    const settingsHandler = { values: { ffmpeg: 'D:/tools/ffmpeg.exe', raster: 'gpu', encoder: 'x264', workers: null, jobsDir: null }, file: 'D:/Multiplane/config.json', overrides: { ffmpeg: 'D:/tools/ffmpeg.exe', jobsDir: 'D:/renders' }, own: { theme: 'system', notifications: true, wizardDone: true }, version: version };
    ipcMain.removeHandler('settings'); ipcMain.handle('settings', () => settingsHandler);
    ipcMain.removeHandler('save-setting'); ipcMain.handle('save-setting', (_event, key, value, own) => { (own ? settingsHandler.own : settingsHandler.values)[key] = value; return settingsHandler; });
    ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => ({ command: { path: 'D:/tools/multiplane.cmd', version: version + '-external', error: null }, skills: ['claude', 'codex'].map(host => ({ host, detected: true, target: host === 'claude' ? '~/.claude/skills/multiplane' : '~/.agents/skills/multiplane', state: 'missing', version: null, availableVersion: version })) }));
  }, { home, version: releasePackage.version });
  await page.reload(); await page.locator('[data-page="environment"]').click();
  await page.getByText(copy.versionMismatch).waitFor();
  assert.equal(await page.locator('[data-check=node] .check-status').innerText(), copy.availableVersion.replace('{version}', 'v24.21.0'));
  assert.equal(await page.locator('[data-check=browser] .check-status').innerText(), copy.availableVersion.replace('{version}', 'Chromium 145.0.7632.6'));
  for (const name of ['libx264', 'three']) assert.equal(await page.locator(`[data-check=${name}] .cancelled`).count(), 0);
  assert.equal(await page.locator('[data-check=ffmpeg] .check-status').innerText(), copy.notFound);
  assert.equal(await page.locator('[data-check=ffmpeg] .check-detail').innerText(), copy.doctorFfmpegMissing);
  assert.equal(await page.locator('#placeholder pre').count(), 0);
  assert.ok((await page.locator('#placeholder').innerText()).includes(new Intl.ListFormat('en').format([copy.ffmpegPath, copy.rasterization, copy.encoder, copy.workers, copy.jobDirectory])));
  assert.equal(await page.locator('.check-status.selectable').first().evaluate(el => getComputedStyle(el).userSelect), 'text');
  const publicDoctor = await page.evaluate(() => window.multiplane.doctor());
  const publicEnvironment = await page.evaluate(() => window.multiplane.environment());
  await page.getByRole('button', { name: copy.chooseFfmpeg, exact: true }).click(); assert.equal(await page.locator('#heading').innerText(), copy.settings); assert.equal(await page.evaluate(() => document.activeElement.id), 'input-ffmpeg');
  evidence.checks.push('doctor checks/config display, PATH mismatch, FFmpeg navigation and focus');
  for (const theme of ['light', 'dark']) for (const [size, width, height] of [['default',1160,720],['minimum',960,600]]) {
    await app.evaluate(({ nativeTheme, BrowserWindow }, x) => { nativeTheme.themeSource=x.theme; BrowserWindow.getAllWindows()[0].setSize(x.width,x.height); }, {theme,width,height});
    await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    for (const [name, label] of [['environment',copy.environment], ['settings',copy.settings], ['about',copy.about]]) {
      await page.locator(`[data-page="${name}"]`).click(); await page.evaluate(() => document.fonts.ready); if (name === 'environment') await page.locator('[data-check=node]').waitFor();
      assert.ok(await page.locator('#placeholder').evaluate(el => el.scrollWidth <= el.clientWidth));
      if (name === 'environment' || name === 'settings') assert.ok((await page.locator('#placeholder').getAttribute('class')).includes('has-thumb'));
      const file = `${theme}-${size}-${name}.png`; await page.screenshot({path:path.join(out,file)}); evidence.screenshots.push(file);
      if (name === 'environment') {
        await page.getByRole('heading', {name:copy.configuration, exact:true}).evaluate(el => el.scrollIntoView({block:'start'}));
        const configFile = `${theme}-${size}-configuration.png`; await page.screenshot({path:path.join(out,configFile)}); evidence.screenshots.push(configFile);
      }
      if (['environment', 'settings'].includes(name)) { await page.locator('#placeholder').evaluate(el => el.scrollTop=el.scrollHeight); const lower=`${theme}-${size}-${name === 'environment' ? 'skills' : 'preferences'}.png`; await page.screenshot({path:path.join(out,lower)}); evidence.screenshots.push(lower); await page.locator('#placeholder').evaluate(el=>el.scrollTop=0); }
    }
    await page.getByRole('button', {name:copy.rerunWizard}).click();
    await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
    for (let step=1;step<=3;step++) {
      const file=`${theme}-${size}-wizard-${step}.png`; await page.screenshot({path:path.join(out,file)}); evidence.screenshots.push(file);
      await page.getByRole('button',{name:copy.skip,exact:true}).click();
    }
    await page.locator('.wizard').waitFor({state:'detached'});
  }
  await app.evaluate(() => { globalThis.__ffmpeg=true; });
  await page.locator('[data-page="about"]').click(); await page.getByRole('button',{name:copy.rerunWizard}).click();
  await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
  await page.getByRole('button',{name:copy.next,exact:true}).click(); await page.getByRole('checkbox').first().waitFor();
  assert.equal(await page.locator('#input-ffmpeg').count(),0); await page.getByRole('button',{name:copy.skip,exact:true}).click();
  evidence.checks.push('all wizard steps skip; available FFmpeg automatically skips step 2; rerun works');
  // Capture the actual application dialogs over public fixtures, backed by isolated skill files.
  await page.evaluate(() => window.multiplane.skill('claude', 'install'));
  await writeFile(path.join(target, 'extra.md'), 'custom');
  await app.evaluate(({ ipcMain }, fixture) => {
    fixture.skills[0].state = 'modified';
    ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => fixture);
  }, publicEnvironment);
  await page.locator('[data-page="environment"]').click();
  await page.locator('[data-host-card=claude]').getByRole('button', {name:copy.update}).click();
  await confirm.waitFor();
  await page.screenshot({path:path.join(out,'confirm-replace.png')}); evidence.screenshots.push('confirm-replace.png');
  await confirm.getByRole('button', {name:copy.cancel}).click();
  await page.locator('[data-host-card=claude]').getByRole('button', {name:copy.remove}).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('h2').innerText(), copy.removeSkillTitle.replace('{agent}', 'Claude Code'));
  const removeBackup = (await confirm.locator('p').innerText()).match(/multiplane\.bak-\d{8}-\d{6}(?:-\d+)?/)[0];
  assert.ok((await confirm.locator('p').innerText()).startsWith(copy.modifiedBackup.split('{')[0]));
  assert.equal(await confirm.getByRole('button', {name:copy.cancel}).evaluate(el => el === document.activeElement), true);
  await page.screenshot({path:path.join(out,'confirm-remove.png')}); evidence.screenshots.push('confirm-remove.png');
  await confirm.getByRole('button', {name:copy.remove,exact:true}).click(); await confirm.waitFor({state:'detached'});
  await page.waitForFunction(() => !document.querySelector('[data-host-card=claude] button').disabled);
  assert.equal(await readFile(path.join(path.dirname(target), removeBackup, 'extra.md'), 'utf8'), 'custom');
  evidence.checks.push('modified removal wording and backup matches displayed directory; two real modal screenshots');
  await app.evaluate(({ ipcMain }, {doctor, environment}) => {
    globalThis.__doctorMode = 'pending';
    ipcMain.removeHandler('doctor'); ipcMain.handle('doctor', () => {
      if (globalThis.__doctorMode === 'pending') return new Promise(resolve => { globalThis.__releaseDoctor = () => resolve(doctor); });
      if (globalThis.__doctorMode === 'error') throw Error('internal_error');
      return doctor;
    });
    doctor.data.config.exists = false; doctor.data.config.applied = [];
    doctor.data.checks.find(c => c.name === 'node').ok = false;
    doctor.data.checks.find(c => c.name === 'gpu').ok = false;
    doctor.data.checks.find(c => c.name === 'ffmpeg').ok = true;
    environment.command = {path:null,version:null,error:null}; environment.skills.forEach(s => { s.detected=false; s.state='missing'; });
    ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => environment);
  }, {doctor:publicDoctor, environment:publicEnvironment});
  await page.getByRole('button', {name:copy.checkAgain}).click();
  await page.getByText(copy.checking, {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check]').count(), 0);
  await app.evaluate(() => globalThis.__releaseDoctor());
  await page.getByText(copy.configMissing, {exact:true}).waitFor();
  await page.getByText(copy.commandMissing, {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check=node] .check-status').innerText(), copy.nodeTooOld);
  assert.equal(await page.locator('[data-check=gpu] .check-status').innerText(), copy.softwareOnly);
  assert.equal(await page.locator('[data-check=libx264] .check-status').innerText(), copy.unavailable);
  assert.equal(await page.getByText(copy.settingsInEffect, {exact:true}).locator('..').locator('div').innerText(), copy.none);
  for (const [host, name] of [['claude','Claude Code'],['codex','Codex']]) {
    await page.getByText(copy.agentNotDetected.replace('{name}', name), {exact:true}).waitFor();
    assert.equal(await page.locator(`[data-host-card=${host}]`).getByRole('button', {name:copy.install}).isEnabled(), true);
  }
  await app.evaluate(() => { globalThis.__doctorMode='error'; });
  await page.getByRole('button', {name:copy.checkAgain}).click();
  await page.getByText(copy.checkFailed.replace('{error}', copy.errorCode.replace('{message}', copy.retryError).replace('{code}', 'internal_error')), {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check]').count(), 0);
  await app.evaluate(() => { globalThis.__doctorMode='ok'; });
  await page.getByRole('button', {name:copy.checkAgain}).click(); await page.locator('[data-check=node]').waitFor();
  assert.equal(await page.getByText(copy.checkFailed.replace('{error}', copy.errorCode.replace('{message}', copy.retryError).replace('{code}', 'internal_error')), {exact:true}).count(), 0);
  evidence.checks.push('Localized desktop diagnostics; neutral dependencies; inline hints; config labels/defaults; missing PATH/agents; loading, error code and retry without stale checks');
  await app.evaluate(({ ipcMain }) => {
    globalThis.__installRequested = 0;
    ipcMain.removeHandler('install-browser'); ipcMain.handle('install-browser', () => { globalThis.__installRequested++; });
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, data: { checks: [{ name: 'browser', ok: false, detail: 'Chromium is not installed.', hint: 'Install Chromium.' }], config: { path: 'D:/Multiplane/config.json', exists: false, applied: [] } } }));
  });
  await page.locator('[data-page="environment"]').click(); await page.getByRole('button', { name: copy.installBrowser, exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.__installRequested), 1);
  assert.equal(await page.locator('[data-check=browser] .check-detail').innerText(), copy.doctorBrowserMissing);
  assert.doesNotMatch(await page.locator('[data-check=browser]').innerText(), /npx playwright/);
  evidence.checks.push('missing browser hint points to the install action (installer mocked)');
  assert.deepEqual(errors, []); evidence.pageErrors=errors;
  await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally { await app.close(); await rm(work,{recursive:true,force:true}); }
