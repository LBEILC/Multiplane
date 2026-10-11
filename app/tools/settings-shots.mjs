import { _electron } from 'playwright';
import { ensureElectron } from './electron.mjs';
import { realpath, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-ui-')));
const home = path.join(work, 'renderer'), data = path.join(work, 'desktop'), user = path.join(work, 'user');
for (const dir of [home, data, path.join(user, '.claude'), path.join(user, '.codex')]) await mkdir(dir, { recursive: true });
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user, USERPROFILE: user, HOME: user, CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude'), MULTIPLANE_FFMPEG: 'Z:/missing/ffmpeg.exe', MULTIPLANE_JOBS_DIR: 'D:/renders' };
delete env.ELECTRON_RUN_AS_NODE;
const out = path.join(root, 'out', '008-settings'); await mkdir(out, { recursive: true });
const app = await _electron.launch({ executablePath: await ensureElectron(), args: [path.join(root, 'app')], env });
const evidence = { screenshots: [], realDoctor: {}, checks: [] }, errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('.wizard').waitFor();
  const actual = await page.evaluate(() => window.multiplane.doctor());
  assert.equal(actual.data.checks.length, 6); assert.match(actual.data.checks[0].detail, /Node v/);
  assert.equal(actual.data.config.path, path.join(home, 'config.json'));
  assert.equal(actual.data.checks.find(c => c.name === 'ffmpeg').ok, false);
  evidence.realDoctor = { checks: actual.data.checks.map(c => ({ name: c.name, ok: c.ok })), node: actual.data.checks[0].detail, isolatedConfig: true };
  await page.getByRole('button', { name: '下一步', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
  assert.equal(await page.locator('[data-page]:enabled').count(), 0);
  await page.getByRole('button', { name: '选择 FFmpeg…', exact: true }).click();
  await page.locator('#input-ffmpeg').waitFor();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.getByRole('checkbox', { name: /Claude Code/ }).waitFor();
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 2);
  const choice = page.getByRole('checkbox', { name: /Claude Code/ });
  await choice.focus(); await choice.press('Space'); assert.equal(await choice.isChecked(), false);
  assert.equal(await choice.evaluate(el => el === document.activeElement), true);
  await page.locator('.skill-choice').filter({hasText:'Claude Code'}).click(); assert.equal(await choice.isChecked(), true);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.wizard').waitFor({ state: 'detached' });
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).wizardDone, true);
  for (const dir of ['.claude', '.agents']) assert.ok(await readFile(path.join(user, dir, 'skills', 'multiplane', 'SKILL.md')));
  evidence.checks.push('first launch, missing FFmpeg step, default selection, install, completion persistence');
  await page.locator('[data-page="设置"]').click();
  await page.getByLabel('FFmpeg 路径', { exact: true }).fill('D:/tools/ffmpeg.exe'); await page.getByLabel('FFmpeg 路径', { exact: true }).press('Tab');
  await page.waitForFunction(() => !document.querySelector('#input-ffmpeg').disabled);
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).ffmpeg, 'D:/tools/ffmpeg.exe');
  assert.match(await page.locator('#setting-ffmpeg small').innerText(), /环境变量优先/);
  assert.match(await page.locator('#setting-jobsDir small').innerText(), /环境变量优先/);
  await mkdir(path.join(home, 'config.json.tmp'));
  await page.getByLabel('并行数', { exact: true }).fill('3'); await page.getByLabel('并行数', { exact: true }).press('Tab');
  await page.locator('#placeholder [role=alert]').waitFor(); assert.equal(await page.getByLabel('并行数', { exact: true }).inputValue(), '');
  await rm(path.join(home, 'config.json.tmp'), { recursive: true });
  await page.getByRole('switch', { name: '作业结束通知' }).click();
  await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false');
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).notifications, false);
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('option', { name: '深', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8')).theme, 'dark');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['D:/selected/ffmpeg.exe'] }); });
  await page.locator('#setting-ffmpeg').getByRole('button', { name: '浏览…' }).click();
  await page.waitForFunction(() => document.querySelector('#input-ffmpeg').value === 'D:/selected/ffmpeg.exe');
  await page.getByRole('button', { name: '检测', exact: true }).click();
  await page.getByText(/不可用 ·/).waitFor();
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).ffmpeg, 'D:/selected/ffmpeg.exe');
  evidence.checks.push('config persisted, environment override rows, failed write restores input');
  evidence.checks.push('theme and notification preference persistence, browse selection, FFmpeg-only result');
  const target = path.join(user, '.claude', 'skills', 'multiplane');
  await writeFile(path.join(target, 'extra.md'), 'custom');
  await page.locator('[data-page="环境"]').click();
  await page.locator('[data-host-card=claude]').getByText('已被修改，不会自动替换').waitFor();
  const confirm = page.getByRole('dialog');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: '更新' }).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('h2').innerText(), '替换 Claude Code 里改过的 Multiplane skill？');
  assert.equal(await confirm.locator('h2').evaluate(el => getComputedStyle(el).fontWeight), '500');
  assert.equal(await confirm.locator('p').evaluate(el => getComputedStyle(el).fontWeight), '400');
  assert.equal(await confirm.getByRole('button', {name:'取消'}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await confirm.getByRole('button', {name:'替换'}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await confirm.getByRole('button', {name:'取消'}).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await confirm.waitFor({state:'detached'});
  await page.waitForFunction(() => !document.querySelector('[data-host-card=claude] button').disabled);
  assert.equal(await page.locator('[data-host-card=claude] [data-operation=install]').evaluate(el => el === document.activeElement), true);
  assert.equal(await readFile(path.join(target, 'extra.md'), 'utf8'), 'custom');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: '更新' }).click();
  await confirm.waitFor();
  const backupName = (await confirm.locator('p').innerText()).match(/multiplane\.bak-\d{8}-\d{6}(?:-\d+)?/)[0];
  assert.equal(await confirm.locator('button.primary').innerText(), '替换');
  await confirm.getByRole('button', {name:'替换', exact:true}).click();
  await page.locator('[data-host-card=claude]').getByText('已是最新').waitFor();
  assert.equal(await readFile(path.join(path.dirname(target), backupName, 'extra.md'), 'utf8'), 'custom');
  await page.locator('[data-host-card=claude]').getByRole('button', { name: '移除' }).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('p').innerText(), 'Claude Code 之后将不再加载这个 skill。');
  assert.equal(await confirm.locator('button.danger').innerText(), '移除');
  await confirm.getByRole('button', {name:'移除', exact:true}).click();
  await page.locator('[data-host-card=claude]').getByText('未安装', { exact: true }).waitFor();
  evidence.checks.push('real checkbox Space/row click; modal cancel default, focus trap, Escape, exact backup name, replace/remove styles and IPC');
  // Use protocol-shaped public fixtures for screenshots; never expose machine paths.
  await app.evaluate(({ ipcMain }, { home }) => {
    globalThis.__ffmpeg = false;
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, code: 'ffmpeg_not_found', hint: 'Select an FFmpeg executable.', data: { checks: [
      { name: 'node', ok: true, detail: 'Node v24.21.0; version 24 or newer is required.' }, { name: 'browser', ok: true, detail: 'Chromium 145.0.7632.6 is available.' }, { name: 'gpu', ok: true, detail: 'Hardware rasterization is available.' },
      { name: 'ffmpeg', ok: globalThis.__ffmpeg, detail: globalThis.__ffmpeg ? 'FFmpeg is available.' : 'FFmpeg executable was not found.' }, { name: 'libx264', ok: globalThis.__ffmpeg, detail: 'Encoder list follows FFmpeg availability.' }, { name: 'three', ok: false, detail: 'Optional three.js is not installed.' }
    ], config: { path: 'D:/Multiplane/config.json', exists: true, applied: ['ffmpeg', 'raster', 'encoder', 'workers', 'jobsDir'] } } }));
    const settingsHandler = { values: { ffmpeg: 'D:/tools/ffmpeg.exe', raster: 'gpu', encoder: 'x264', workers: null, jobsDir: null }, file: 'D:/Multiplane/config.json', overrides: { ffmpeg: 'D:/tools/ffmpeg.exe', jobsDir: 'D:/renders' }, own: { theme: 'system', notifications: true, wizardDone: true }, version: '0.0.0' };
    ipcMain.removeHandler('settings'); ipcMain.handle('settings', () => settingsHandler);
    ipcMain.removeHandler('save-setting'); ipcMain.handle('save-setting', (_event, key, value, own) => { (own ? settingsHandler.own : settingsHandler.values)[key] = value; return settingsHandler; });
    ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => ({ command: { path: 'D:/tools/multiplane.cmd', version: '0.1.0', error: null }, skills: ['claude', 'codex'].map(host => ({ host, detected: true, target: host === 'claude' ? '~/.claude/skills/multiplane' : '~/.agents/skills/multiplane', state: 'missing', version: null, availableVersion: '0.0.0' })) }));
  }, { home });
  await page.reload(); await page.locator('[data-page="环境"]').click();
  await page.getByText('版本与软件不同，作业以 agent 实际调用的版本为准。').waitFor();
  assert.equal(await page.locator('[data-check=node] .check-status').innerText(), '可用（v24.21.0）');
  assert.equal(await page.locator('[data-check=browser] .check-status').innerText(), '可用（Chromium 145.0.7632.6）');
  for (const name of ['libx264', 'three']) assert.equal(await page.locator(`[data-check=${name}] .cancelled`).count(), 0);
  assert.equal(await page.locator('[data-check=ffmpeg] .check-detail').innerText(), 'FFmpeg executable was not found.\nSelect an FFmpeg executable.');
  assert.equal(await page.locator('#placeholder pre').count(), 0);
  assert.ok((await page.locator('#placeholder').innerText()).includes('FFmpeg 路径、光栅、编码器、并行数、作业目录'));
  assert.equal(await page.locator('.check-detail').first().evaluate(el => getComputedStyle(el).userSelect), 'text');
  const publicDoctor = await page.evaluate(() => window.multiplane.doctor());
  const publicEnvironment = await page.evaluate(() => window.multiplane.environment());
  await page.getByRole('button', { name: '选择 FFmpeg…', exact: true }).click(); assert.equal(await page.locator('#heading').innerText(), '设置'); assert.equal(await page.evaluate(() => document.activeElement.id), 'input-ffmpeg');
  evidence.checks.push('doctor checks/config display, PATH mismatch, FFmpeg navigation and focus');
  for (const theme of ['light', 'dark']) for (const [size, width, height] of [['default',1160,720],['minimum',960,600]]) {
    await app.evaluate(({ nativeTheme, BrowserWindow }, x) => { nativeTheme.themeSource=x.theme; BrowserWindow.getAllWindows()[0].setSize(x.width,x.height); }, {theme,width,height});
    await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    for (const [name, label] of [['environment','环境'], ['settings','设置'], ['about','关于']]) {
      await page.locator(`[data-page="${label}"]`).click(); await page.evaluate(() => document.fonts.ready); if (name === 'environment') await page.locator('[data-check=node]').waitFor();
      assert.ok(await page.locator('#placeholder').evaluate(el => el.scrollWidth <= el.clientWidth));
      if (name === 'environment' || name === 'settings') assert.ok((await page.locator('#placeholder').getAttribute('class')).includes('has-thumb'));
      const file = `${theme}-${size}-${name}.png`; await page.screenshot({path:path.join(out,file)}); evidence.screenshots.push(file);
      if (name === 'environment') {
        await page.getByRole('heading', {name:'配置', exact:true}).evaluate(el => el.scrollIntoView({block:'start'}));
        const configFile = `${theme}-${size}-configuration.png`; await page.screenshot({path:path.join(out,configFile)}); evidence.screenshots.push(configFile);
      }
      if (['environment', 'settings'].includes(name)) { await page.locator('#placeholder').evaluate(el => el.scrollTop=el.scrollHeight); const lower=`${theme}-${size}-${name === 'environment' ? 'skills' : 'preferences'}.png`; await page.screenshot({path:path.join(out,lower)}); evidence.screenshots.push(lower); await page.locator('#placeholder').evaluate(el=>el.scrollTop=0); }
    }
    await page.getByRole('button', {name:'重新运行首次引导'}).click();
    await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
    for (let step=1;step<=3;step++) {
      const file=`${theme}-${size}-wizard-${step}.png`; await page.screenshot({path:path.join(out,file)}); evidence.screenshots.push(file);
      await page.getByRole('button',{name:'跳过',exact:true}).click();
    }
    await page.locator('.wizard').waitFor({state:'detached'});
  }
  await app.evaluate(() => { globalThis.__ffmpeg=true; });
  await page.locator('[data-page="关于"]').click(); await page.getByRole('button',{name:'重新运行首次引导'}).click();
  await page.waitForFunction(() => !document.querySelector('[data-pref=next]').disabled);
  await page.getByRole('button',{name:'下一步',exact:true}).click(); await page.getByRole('checkbox').first().waitFor();
  assert.equal(await page.locator('#input-ffmpeg').count(),0); await page.getByRole('button',{name:'跳过',exact:true}).click();
  evidence.checks.push('all wizard steps skip; available FFmpeg automatically skips step 2; rerun works');
  // Capture the actual application dialogs over public fixtures, backed by isolated skill files.
  await page.evaluate(() => window.multiplane.skill('claude', 'install'));
  await writeFile(path.join(target, 'extra.md'), 'custom');
  await app.evaluate(({ ipcMain }, fixture) => {
    fixture.skills[0].state = 'modified';
    ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => fixture);
  }, publicEnvironment);
  await page.locator('[data-page="环境"]').click();
  await page.locator('[data-host-card=claude]').getByRole('button', {name:'更新'}).click();
  await confirm.waitFor();
  await page.screenshot({path:path.join(out,'confirm-replace.png')}); evidence.screenshots.push('confirm-replace.png');
  await confirm.getByRole('button', {name:'取消'}).click();
  await page.locator('[data-host-card=claude]').getByRole('button', {name:'移除'}).click();
  await confirm.waitFor();
  assert.equal(await confirm.locator('h2').innerText(), '移除 Claude Code 的 Multiplane skill？');
  const removeBackup = (await confirm.locator('p').innerText()).match(/multiplane\.bak-\d{8}-\d{6}(?:-\d+)?/)[0];
  assert.ok((await confirm.locator('p').innerText()).startsWith('你改过这个 skill，原来的目录会先备份为 '));
  assert.equal(await confirm.getByRole('button', {name:'取消'}).evaluate(el => el === document.activeElement), true);
  await page.screenshot({path:path.join(out,'confirm-remove.png')}); evidence.screenshots.push('confirm-remove.png');
  await confirm.getByRole('button', {name:'移除',exact:true}).click(); await confirm.waitFor({state:'detached'});
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
  await page.getByRole('button', {name:'重新检查'}).click();
  await page.getByText('正在检查…', {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check]').count(), 0);
  await app.evaluate(() => globalThis.__releaseDoctor());
  await page.getByText('尚未创建（全部使用默认值）', {exact:true}).waitFor();
  await page.getByText('未找到（agent 也可以在项目里用 npx 调用）', {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check=node] .check-status').innerText(), '版本过低，需要 24 或更新');
  assert.equal(await page.locator('[data-check=gpu] .check-status').innerText(), '只能用软件光栅，渲染会变慢');
  assert.equal(await page.locator('[data-check=libx264] .check-status').innerText(), '不可用');
  assert.equal(await page.getByText('生效的设置', {exact:true}).locator('..').locator('div').innerText(), '无');
  for (const [host, name] of [['claude','Claude Code'],['codex','Codex']]) {
    await page.getByText(`未检测到 ${name}`, {exact:true}).waitFor();
    assert.equal(await page.locator(`[data-host-card=${host}]`).getByRole('button', {name:'安装'}).isEnabled(), true);
  }
  await app.evaluate(() => { globalThis.__doctorMode='error'; });
  await page.getByRole('button', {name:'重新检查'}).click();
  await page.getByText('无法运行检查：internal_error', {exact:true}).waitFor();
  assert.equal(await page.locator('[data-check]').count(), 0);
  await app.evaluate(() => { globalThis.__doctorMode='ok'; });
  await page.getByRole('button', {name:'重新检查'}).click(); await page.locator('[data-check=node]').waitFor();
  assert.equal(await page.getByText('无法运行检查：internal_error', {exact:true}).count(), 0);
  evidence.checks.push('Chinese status branches; neutral dependencies; inline hints; config labels/defaults; missing PATH/agents; loading, error code and retry without stale checks');
  await app.evaluate(({ ipcMain, clipboard }) => {
    globalThis.__copied = '';
    clipboard.writeText = value => { globalThis.__copied = value; };
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: false, data: { checks: [{ name: 'browser', ok: false, detail: 'Chromium is missing.', hint: 'Install Chromium.' }], config: {} } }));
  });
  await page.locator('[data-page="环境"]').click(); await page.getByRole('button', { name: '复制', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.__copied), 'npx playwright install chromium');
  assert.ok((await page.locator('#placeholder').innerText()).includes('Install Chromium.'));
  evidence.checks.push('missing browser hint and copy command (clipboard mocked)');
  assert.deepEqual(errors, []); evidence.pageErrors=errors;
  await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally { await app.close(); await rm(work,{recursive:true,force:true}); }
