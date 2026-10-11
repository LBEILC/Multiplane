import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { demo } from './demo.mjs';
import sharp from 'sharp';
import { errorCodes } from '../../src/errors.mjs';
const demoIds = Object.fromEntries(['running', 'success', 'failed', 'cancelled', 'verify', 'lost', 'stills'].map((name, i) => [name, `demo-20261011-${String(i + 1).padStart(3, '0')}`]));
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { _electron } = require('playwright');
const fixture = await demo(), out = path.join(root, 'out', 'app-shots'); await mkdir(out, { recursive: true });
await writeFile(path.join(fixture.appData, 'preferences.json'), JSON.stringify({ theme: 'system', notifications: true, hidden: [], wizardDone: true }));
const electron = await _electron.launch({ args: [path.join(root, 'app')], executablePath: (await import('electron')).default, env: fixture.env });
const errors = []; const evidence = { screenshots: [], notifications: [], real: {} };
let child;
try {
  const page = await electron.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.locator(`[data-job="${demoIds.running}"]`).waitFor();
  await page.evaluate(() => document.fonts.ready);
  evidence.brand = await page.evaluate(() => {
    const lockup = document.querySelector('.brand-lockup'), svg = lockup.querySelector('svg');
    const probe = document.createElement('span'); probe.style.cssText = 'height:1cap;display:block;position:absolute'; lockup.append(probe);
    const ratio = svg.getBoundingClientRect().height * .72 / probe.getBoundingClientRect().height; probe.remove();
    return { fontLoaded: document.fonts.check('500 13px "Multiplane MiSans"'), weight: getComputedStyle(lockup).fontWeight, markToCap: ratio };
  });
  assert.equal(evidence.brand.fontLoaded, true); assert.equal(evidence.brand.weight, '500'); assert.ok(Math.abs(evidence.brand.markToCap - 1.2) < .01);
  await electron.evaluate(({ Notification }) => {
    globalThis.__notifications = [];
    const show = Notification.prototype.show;
    Notification.prototype.show = function() { globalThis.__notifications.push(this); show.call(this); };
  });
  for (const theme of ['light', 'dark']) for (const [size, width, height] of [['default', 1160, 720], ['minimum', 960, 600]]) {
    await electron.evaluate(({ nativeTheme, BrowserWindow }, { theme, width, height }) => { nativeTheme.themeSource = theme; BrowserWindow.getAllWindows()[0].setSize(width, height); }, { theme, width, height });
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    for (const id of ['success', 'running', 'failed', 'verify', 'cancelled', 'lost', 'stills']) {
      await page.locator(`[data-job="${demoIds[id]}"]`).click();
      await page.getByRole('tab', { name: '预览', exact: true }).click();
      if (id === 'success') {
        await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
        await page.evaluate(async () => { const video = document.querySelector('video'); video.muted = true; await video.play(); });
        await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
        await page.evaluate(() => document.querySelector('video').pause());
      }
      if (['running', 'verify', 'stills'].includes(id)) await page.waitForFunction(() => [...document.querySelectorAll('#tab-content img')].every(img => img.complete && img.naturalWidth > 0));
      if (id === 'verify') { assert.equal(await page.locator('.bbox:not([hidden])').count(), 3); assert.match(await page.locator('.caption').innerText(), /变化区域 x 180，y 95，120 × 80 · 6400 像素/); }
      assert.equal(await page.locator('.job-id').innerText(), demoIds[id]);
      assert.equal(await page.locator('.job-id').evaluate(el => getComputedStyle(el).userSelect), 'text');
      if (['failed', 'verify', 'cancelled'].includes(id)) assert.ok((await page.locator('#banner').innerText()).includes(errorCodes[id === 'failed' ? 'render_threw' : id === 'verify' ? 'nondeterministic_output' : 'cancelled'].message));
      if (id === 'lost') assert.match(await page.locator('#banner').innerText(), /渲染进程意外退出/);
      await delay(120);
      const file = `${theme}-${size}-${id}.png`; await page.screenshot({ path: path.join(out, file) }); evidence.screenshots.push(file);
    }
    if (size === 'default') {
      await page.locator(`[data-job="${demoIds.failed}"]`).click();
      const bannerFile = `${theme}-failure-banner.png`;
      await page.locator('#banner').screenshot({ path: path.join(out, bannerFile) }); evidence.screenshots.push(bannerFile);
      await page.locator('#state-filter').focus(); await page.keyboard.press('Tab');
      const colourFile = `${theme}-failure-focus.png`;
      await page.screenshot({ path: path.join(out, colourFile) }); evidence.screenshots.push(colourFile);
      await page.locator('#state-filter').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.ctx')).opacity === '1');
      const filterFile = `${theme}-filter-open.png`;
      await page.screenshot({ path: path.join(out, filterFile) }); evidence.screenshots.push(filterFile);
      await page.keyboard.press('Escape');
      await page.locator('[data-page="关于"]').click();
      // Render at 2x in Chromium, then combine both actual UI crops without resizing.
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
      await page.evaluate(() => document.fonts.ready);
      await delay(150);
      const zoomed = Buffer.from(await electron.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64');
      const zoomMeta = await sharp(zoomed).metadata();
      const scale = await electron.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win.webContents.getZoomFactor();
      }) * zoomMeta.width / await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds().width);
      const crop = async selector => {
        const r = await page.locator(selector).boundingBox();
        return sharp(zoomed).extract({ left: Math.round(r.x * scale), top: Math.round(r.y * scale), width: Math.min(zoomMeta.width - Math.round(r.x * scale), Math.round(r.width * scale)), height: Math.round(r.height * scale) }).png().toBuffer();
      };
      const sidebar = await crop('.titlebar .brand-lockup');
      const about = await crop('#about-brand');
      const sa = await sharp(sidebar).metadata(), aa = await sharp(about).metadata();
      const zoomFile = `${theme}-brand-about-2x.png`;
      await sharp({ create: { width: Math.max(sa.width, aa.width), height: sa.height + aa.height, channels: 4, background: theme === 'light' ? '#fcfcfb' : '#151515' } }).composite([{ input: sidebar, left: 0, top: 0 }, { input: about, left: 0, top: sa.height }]).png().toFile(path.join(out, zoomFile));
      evidence.screenshots.push(zoomFile);
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
      await page.locator('[data-page="作业"]').click();
    }
  }
  await page.locator(`[data-job="${demoIds.success}"]`).click();
  for (const tab of ['事件', '结果', '参数']) { await page.getByRole('tab', { name: tab, exact: true }).click(); assert.ok((await page.locator('#tab-content').innerText()).length > 10); }
  await page.getByRole('tab', { name: '预览', exact: true }).click();
  await page.evaluate(() => { document.querySelector('video').dataset.preserved = 'yes'; }); await delay(2200);
  assert.equal(await page.locator('video').getAttribute('data-preserved'), 'yes');
  await page.getByRole('button', { name: '打开文件夹', exact: true }).focus(); await delay(1200);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '打开文件夹');
  await page.getByRole('button', { name: '从列表隐藏', exact: true }).click(); await page.locator(`[data-job="${demoIds.success}"]`).waitFor({ state: 'detached' });
  for (const name of ['环境', '设置', '关于', '作业']) await page.locator(`[data-page="${name}"]`).click();
  assert.equal(await page.locator('select').count(), 0);
  await page.locator('#state-filter').focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-job]').count(), 1);
  assert.equal(await page.locator('#state-filter').getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-job]').count(), 4);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-job]').count(), 6);
  await page.locator('#project-filter').click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-job]').count(), 6);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'project-filter');
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  assert.equal(await page.locator('[role="listbox"]').count(), 0);
  await page.locator('#project-filter').click(); await page.locator('#heading').click();
  assert.equal(await page.locator('#project-filter').getAttribute('aria-expanded'), 'false');
  await page.locator('#project-filter').click(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  evidence.customFilters = 'mouse, Enter, Space, arrows, Home, End, Escape, Tab, outside click passed';

  // Exercise a real CLI job through the same filesystem boundary as an agent.
  const started = performance.now();
  const cli = process.env.npm_execpath
    ? [path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'), '--offline', '--yes=false', 'multiplane']
    : [path.join(root, 'bin', 'multiplane')];
  child = spawn(process.execPath, [...cli, 'render', 'examples/animation.html', '--workers', '1', '--scale', '2', '--fps', '60', '--job-dir', path.join(fixture.home, 'real-jobs'), '--json'], { cwd: root, env: { ...fixture.env, MULTIPLANE_NO_INDEX: '0' }, shell: false, windowsHide: true });
  let text = '', stderr = ''; const eventTimes = [];
  child.stderr.on('data', b => stderr += b);
  child.stdout.on('data', b => { text += b; eventTimes.push({ at: performance.now(), text: String(b) }); });
  const done = new Promise(resolve => child.on('exit', code => resolve(code)));
  let id;
  for (let i = 0; i < 200; i++) {
    id = text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(e => e?.type === 'start')?.jobId;
    if (id) break; await delay(50);
  }
  assert.ok(id, stderr); await page.locator(`[data-job="${id}"]`).click();
  await page.waitForFunction(id => document.querySelector('.job-id')?.textContent === id, id);
  console.log('Real job selected');
  const discoveryMs = performance.now() - started;
  await page.waitForFunction(() => document.querySelector('#tab-content img')?.naturalWidth > 0, null, { timeout: 60000 });
  const first = await page.locator('.caption').innerText(); const firstAt = performance.now();
  console.log('First preview:', first);
  await page.waitForFunction(first => document.querySelector('.caption')?.textContent !== first, first, { timeout: 60000 });
  const second = await page.locator('.caption').innerText();
  const frameIntervalMs = performance.now() - firstAt;
  const snapshotBefore = JSON.parse(await readFile(path.join(fixture.home, 'real-jobs', id, 'status.json'), 'utf8'));
  assert.ok(snapshotBefore.done > 0); assert.equal(snapshotBefore.state, 'running');
  // Native dialog response is automated; verify its exact text and default focus.
  await electron.evaluate(({ dialog }) => { globalThis.__dialog = null; globalThis.__answer = 0; dialog.showMessageBox = async (_win, options) => { globalThis.__dialog = options; return { response: globalThis.__answer, checkboxChecked: false }; }; });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await delay(100);
  await assert.rejects(readFile(path.join(fixture.home, 'real-jobs', id, 'stop')), { code: 'ENOENT' });
  await electron.evaluate(() => { globalThis.__answer = 1; });
  const stopAt = performance.now(); await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#banner')?.textContent.includes('cancelled'), null, { timeout: 30000 });
  const cancelMs = performance.now() - stopAt; const exit = await done;
  assert.equal(exit, 130, stderr);
  const dialog = await electron.evaluate(() => globalThis.__dialog); assert.equal(dialog.defaultId, 0); assert.deepEqual(dialog.buttons, ['取消', '停止']);
  const status = JSON.parse(await readFile(path.join(fixture.home, 'real-jobs', id, 'status.json'), 'utf8')); assert.equal(status.state, 'cancelled');
  evidence.notifications = await electron.evaluate(() => globalThis.__notifications.map(n => n.title));
  assert.deepEqual(evidence.notifications, ['已取消：animation.html']);
  await page.getByRole('button', { name: '从列表隐藏', exact: true }).click();
  await page.locator(`[data-job="${id}"]`).waitFor({ state: 'detached' });
  await electron.evaluate(() => { globalThis.__notifications[0].emit('click'); });
  await page.waitForFunction(id => document.querySelector('.job-id')?.textContent === id, id);
  evidence.real = { discoveryMs, first, second, frameIntervalMs, doneBeforeStop: snapshotBefore.done, cancelMs, exit, dialogDefault: dialog.defaultId, stopFile: await readFile(path.join(fixture.home, 'real-jobs', id, 'stop'), 'utf8') === '' };
  // Measure watch-to-paint latency without depending on the renderer's capture rate.
  const statusFile = path.join(fixture.home, 'jobs', 'running', 'status.json');
  const synthetic = JSON.parse(await readFile(statusFile, 'utf8')); synthetic.done = 31;
  const writeAt = performance.now(); await writeFile(statusFile, JSON.stringify(synthetic));
  await page.waitForFunction(id => document.querySelector(`[data-job="${id}"] small`)?.textContent.startsWith('31 /'), demoIds.running);
  evidence.watchToPaintMs = performance.now() - writeAt;
  const original = await page.evaluate(() => window.multiplane.snapshot());
  const publish = snapshot => electron.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('snapshot', snapshot), snapshot);
  await publish({ ...original, jobs: [], runningCount: 0 });
  await page.waitForFunction(() => document.querySelector('#list')?.textContent.includes('还没有作业。'));
  assert.equal(await page.locator('#list code').count(), 3);
  assert.equal(await page.locator('#detail .empty').innerText(), '选择一个作业');
  for (const [command, state, message] of [['render', 'running', '第一帧完成后显示预览'], ['render', 'failed', '这个作业没有预览'], ['stills', 'succeeded', '这个作业没有预览'], ['verify', 'succeeded', '这个作业没有预览']]) {
    await publish({ ...original, jobs: [{ ...original.jobs[0], jobId: `empty-${command}-${state}`, command, state, previewFrame: null, result: null, events: [] }] });
    await page.waitForFunction(message => document.querySelector('#tab-content .empty')?.textContent === message, message);
  }
  await publish(original); evidence.emptyStates = 'all specified copy passed';
  assert.deepEqual(errors, []); evidence.pageErrors = errors;
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence.real)); console.log(`Screenshots: ${evidence.screenshots.length}; watch-to-paint: ${evidence.watchToPaintMs.toFixed(0)} ms`);
} finally { if (child && child.exitCode === null) child.kill(); await electron.close(); }
