import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { ensureElectron } from './electron.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = path.join(root, 'out/083');
const home = path.join(out, 'home'), data = path.join(out, 'desktop');
await mkdir(data, { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ theme: 'dark', language: 'zh-CN', wizardDone: true, autoCheckUpdates: false }));
const jobDir = path.join(home, 'jobs', 'startup-example');
await mkdir(jobDir, { recursive: true });
const job = { schema: 'multiplane/1', jobId: 'startup-example', command: 'stills', shot: '/examples/geometry.html', state: 'succeeded', pid: 1, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', result: { ok: true, artifacts: [], elapsedMs: 1000 }, previewFrame: null };
await writeFile(path.join(jobDir, 'status.json'), JSON.stringify(job));
await writeFile(path.join(jobDir, 'events.jsonl'), '');
await writeFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ ...job, jobDir }) + '\n');
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: path.join(out, 'user'), MULTIPLANE_AGENT_HOME: path.join(out, 'user') };
delete env.ELECTRON_RUN_AS_NODE;
const label = process.argv[2] || 'after';
const results = {};
for (const args of label === 'waiting' ? [] : [['config', 'get', '--json'], ['skill', 'status', '--json']]) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['bin/multiplane', ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr || result.stdout);
  results[args[0] + 'Ms'] = Math.round(performance.now() - start);
  await writeFile(path.join(out, `${label}-${args[0]}.jsonl`), result.stdout);
}
const mainFile = path.join(root, 'app/dist/main.cjs'), rendererFile = path.join(root, 'app/dist/renderer.js'), htmlFile = path.join(root, 'app/dist/index.html');
const main = await readFile(mainFile, 'utf8'), renderer = await readFile(rendererFile, 'utf8'), html = await readFile(htmlFile, 'utf8');
// Instrument only disposable build output, never the product's timing path.
const instrumented = main.replace('const config = new Configuration(root, homeDirectory());', `const config = new Configuration(root, homeDirectory()); const originalRead = config.read.bind(config); globalThis.startupConfigReads = 0; config.read = (...args) => { globalThis.startupConfigReads++; return ${label === 'waiting' ? 'new Promise(resolve => { globalThis.releaseStartupConfiguration = resolve; }).then(() => originalRead(...args))' : 'originalRead(...args)'}; };`);
assert.notEqual(instrumented, main, 'Locate the startup configuration adapter');
await writeFile(mainFile, `const originalShow = require('electron').BrowserWindow.prototype.show; require('electron').BrowserWindow.prototype.show = function(...args) { globalThis.startupShownAt = Date.now(); return originalShow.apply(this,args); };\n` + instrumented);
await writeFile(rendererFile, `new MutationObserver(() => { if (!window.startupJobsAt && document.querySelector('[data-job]')) window.startupJobsAt = Date.now(); }).observe(document, {subtree:true,childList:true});\n` + renderer);
await writeFile(path.join(root, 'app/dist/theme-probe.js'), `window.startupParserTheme = document.documentElement.dataset.theme; requestAnimationFrame(() => { window.startupFirstFrameTheme = document.documentElement.dataset.theme; });`);
await writeFile(htmlFile, html.replace('<head>', '<head><script src="theme-probe.js"></script>'));
let electron;
try {
  const executablePath = await ensureElectron();
  const started = Date.now();
  electron = await _electron.launch({ args: [path.join(root, 'app')], executablePath, env });
  const page = await electron.firstWindow();
  if (label === 'waiting') {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.boot-wait')).opacity === '1');
    const pending = await page.evaluate(() => window.multiplane.snapshot());
    assert.equal(pending.ready, false); assert.deepEqual(pending.jobs, []);
    assert.equal(await page.locator('#list').innerText(), '');
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    await page.screenshot({ path: path.join(out, 'dark-waiting.png') });
    await page.locator('[data-page=settings]').click();
    assert.equal(await page.locator('#placeholder [role=status]').count(), 1);
    await page.locator('[data-page=jobs]').click();
    await electron.evaluate(() => globalThis.releaseStartupConfiguration());
  }
  await page.locator('[data-job]').first().waitFor();
  results.windowMs = await electron.evaluate(() => globalThis.startupShownAt) - started;
  results.jobsMs = await page.evaluate(() => window.startupJobsAt) - started;
  results.theme = await page.locator('html').getAttribute('data-theme');
  results.parserTheme = await page.evaluate(() => window.startupParserTheme);
  results.firstFrameTheme = await page.evaluate(() => window.startupFirstFrameTheme);
  if (label !== 'before' && (results.parserTheme !== 'dark' || results.firstFrameTheme !== 'dark')) throw Error('First frame theme mismatch');
  await page.locator('[data-page=settings]').click();
  await page.locator('#input-ffmpeg').waitFor();
  results.configReads = await electron.evaluate(() => globalThis.startupConfigReads);
  if (label !== 'before') assert.equal(results.configReads, 1);
  await writeFile(path.join(out, `${label}-timing.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await electron?.close();
  await writeFile(mainFile, main); await writeFile(rendererFile, renderer); await writeFile(htmlFile, html);
}
