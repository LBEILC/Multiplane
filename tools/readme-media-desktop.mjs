import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { _electron } from 'playwright';
import { ensureElectron } from '../app/tools/electron.mjs';
import { run } from './process.mjs';
import release from '../package.json' with { type: 'json' };

// Use the actual Electron renderer and protocol with isolated, synthetic jobs.
export async function captureDesktop({ root, work, output, preview, report }) {
  await run(process.execPath, ['tools/build.mjs'], { cwd: path.join(root, 'app'), capture: true });
  const executablePath = await ensureElectron();
  for (const language of ['zh-CN', 'en']) {
    const locale = language === 'en' ? 'en' : 'zh';
    const home = path.join(work, locale, 'renderer'), data = path.join(work, locale, 'desktop'), user = path.join(work, locale, 'user');
    for (const dir of [home, data, user]) await mkdir(dir, { recursive: true });
    const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user,
      USERPROFILE: user, HOME: user, APPDATA: path.join(user, 'roaming'), LOCALAPPDATA: path.join(user, 'local'),
      CODEX_HOME: path.join(user, '.codex'), CLAUDE_CONFIG_DIR: path.join(user, '.claude'), MULTIPLANE_AGENT_HOME: user };
    delete env.ELECTRON_RUN_AS_NODE;
    await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ language, theme: 'light', notifications: false, wizardDone: true, autoCheckUpdates: false }));
    const index = [];
    const timestamp = new Date().toISOString();
    for (const [i, name] of ['intro', 'outro', 'cards', 'shapes', 'orbit'].entries()) {
      const jobId = `demo-${name}`, jobDir = path.join(home, 'jobs', jobId), shot = `D:\\demo\\shots\\${name}.html`;
      await mkdir(jobDir, { recursive: true }); await copyFile(preview, path.join(jobDir, 'preview.png'));
      const state = i === 0 ? 'running' : i === 1 ? 'queued' : 'succeeded';
      const event = (type, fields) => ({ schema: 'multiplane/1', type, command: 'render', ts: timestamp, ...fields });
      const result = state === 'succeeded' ? event('result', { ok: true, code: null, message: null, jobId, artifacts: [], elapsedMs: 8400, data: {} }) : null;
      const events = [event('start', { jobId, shot, version: release.version, options: { root: 'D:\\demo', workers: 2, from: 0, to: 4 } })];
      if (result) events.push(result);
      await writeFile(path.join(jobDir, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
      await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ schema: 'multiplane/1', jobId, command: 'render', shot, pid: process.pid,
        state, phase: i === 0 ? 'capture' : i === 1 ? 'queue' : 'finalize', done: i === 0 ? 58 : i === 1 ? 0 : 96,
        total: 96, fps: 24, etaMs: i === 0 ? 1600 : null, startedAt: timestamp, updatedAt: timestamp, result, previewFrame: i === 0 ? 58 : null }));
      index.push(event('start', { jobId, jobDir, shot, pid: process.pid }));
    }
    await writeFile(path.join(home, 'jobs.jsonl'), index.map(JSON.stringify).join('\n') + '\n');
    const app = await _electron.launch({ executablePath, args: [path.join(root, 'app'), '--force-device-scale-factor=1'], env });
    try {
      const page = await app.firstWindow(); page.setDefaultTimeout(30000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      // Job liveness verifies executor creation time; use this fresh test instance,
      // not the generator process which may have spent minutes rendering media.
      const runningFile = path.join(home, 'jobs/demo-intro/status.json');
      const running = JSON.parse(await readFile(runningFile, 'utf8'));
      running.pid = await app.evaluate(() => process.pid);
      running.startedAt = running.updatedAt = new Date().toISOString();
      await writeFile(runningFile, JSON.stringify(running));
      // Refresh discovery too: a seed initially classified as lost is not watched.
      await writeFile(path.join(home, 'jobs.jsonl'), index.map(JSON.stringify).join('\n') + '\n');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
      await page.locator('[data-job="demo-intro"] .tag.running').waitFor();
      await page.locator('[data-job="demo-intro"]').click();
      await page.waitForFunction(() => document.querySelector('#tab-content img')?.naturalWidth > 0);
      assert.equal(await page.locator('[data-job]').count(), 5);
      assert.equal(await page.locator('.tag.running').count(), 1); assert.equal(await page.locator('.tag.queued').count(), 1);
      assert.equal(await page.locator('.tag.succeeded').count(), 3);
      const snap = async name => {
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(1270, 790);
        // Wait for compositor and existing UI transitions without changing app CSS.
        await page.waitForTimeout(250);
        const text = await page.locator('body').innerText();
        for (const privateValue of [root, work, process.env.USERPROFILE].filter(Boolean)) assert.ok(!text.toLowerCase().includes(privateValue.toLowerCase()));
        await page.screenshot({ path: path.join(output, name) }); report.images.push({ name, window: [1280, 800], fixture: '1 running (58/96), 1 queued, 3 completed' });
      };
      for (const theme of ['light', 'dark']) {
        await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        await snap(`app-jobs-${locale}-${theme}.png`);
      }
      // Environment fixtures use public example values; no real machine details reach screenshots.
      await app.evaluate(({ ipcMain, nativeTheme }, version) => {
        nativeTheme.themeSource = 'light';
        ipcMain.removeHandler('doctor'); ipcMain.handle('doctor', () => ({ schema: 'multiplane/1', type: 'result', command: 'doctor', ok: true,
          data: { checks: [
            { name: 'node', ok: true, detail: 'Node v24.10.0', version: 'v24.10.0' },
            { name: 'browser', ok: true, detail: 'Chromium is installed.' },
            { name: 'gpu', ok: true, detail: 'Hardware acceleration available.' },
            { name: 'ffmpeg', ok: true, detail: 'FFmpeg 8.0', path: 'D:\\demo\\tools\\ffmpeg.exe' },
            { name: 'libx264', ok: true, detail: 'libx264 available.' },
            { name: 'three', ok: true, detail: 'three.js 0.180.0' }
          ], config: { path: 'D:\\demo\\multiplane\\config.json', exists: true, applied: [] } } }));
        ipcMain.removeHandler('environment'); ipcMain.handle('environment', () => ({
          command: { path: 'D:\\demo\\tools\\multiplane.cmd', bundled: 'D:\\demo\\tools\\multiplane.cmd', version, error: null },
          skills: ['claude', 'codex'].map(host => ({ host, target: `D:\\demo\\agents\\${host}\\skills\\multiplane`, detected: true, availableVersion: version, version, state: 'latest' }))
        }));
      }, release.version);
      await page.locator('[data-page="environment"]').click();
      await page.locator('[data-check="three"]').waitFor();
      assert.equal(await page.locator('[data-check]').count(), 6);
      assert.equal(await page.locator('[data-check] .ri-error-warning-line').count(), 0);
      await snap(`app-environment-${locale}.png`);
      assert.deepEqual(errors, []);
    } finally {
      // Synthetic active jobs intentionally trigger the normal quit confirmation.
      // Exit only this owned test instance, without traversing or killing processes.
      await app.evaluate(({ app }) => app.exit(0)).catch(error => {
        if (!/closed|destroyed/i.test(error.message)) throw error;
      });
      await app.close();
    }
  }
}
