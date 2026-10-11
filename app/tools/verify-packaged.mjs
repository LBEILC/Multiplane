import { _electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, lstat, cp, chmod, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../../tools/process.mjs';
import { fontHash } from './fonts.mjs';
import { verifyNotices } from './notices.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url)), root = path.resolve(appRoot, '..');
const windows = process.platform === 'win32', mac = process.platform === 'darwin';
const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const installer = path.join(appRoot, 'release', windows ? `Multiplane-Setup-${pkg.version}-x64.exe` : `Multiplane-${pkg.version}-${process.arch}.${mac ? 'dmg' : 'AppImage'}`);
const out = path.join(root, 'out/013-packaged'); await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url), { UUID } = require('builder-util-runtime');
const { appId } = require('../electron-builder.config.cjs');
const guid = String(UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
const keys = [`Software\\${guid}`, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`];
const registryExists = (hive, key) => spawnSync('reg.exe', ['query', `${hive}\\${key}`], { windowsHide: true, stdio: 'ignore' }).status === 0;
const folders = windows ? JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', "@{desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs');local=[Environment]::GetFolderPath('LocalApplicationData')} | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true })) : {};
const shortcuts = windows ? [path.join(folders.desktop, 'Multiplane.lnk'), path.join(folders.programs, 'Multiplane.lnk')] : [];
const cache = windows ? path.join(folders.local, 'multiplane-desktop-updater') : null;
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
if (windows) for (const hive of ['HKCU', 'HKLM']) for (const key of keys) assert.equal(registryExists(hive, key), false, 'Existing installation must not be changed by verification');
for (const file of [...shortcuts, ...(cache ? [cache] : [])]) assert.equal(await exists(file), false, 'Existing shortcuts/cache must not be changed by verification');
const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-packaged-'));
const installation = path.join(work, windows ? 'installed' : mac ? 'mount' : 'squashfs-root'), home = path.join(work, 'renderer-home'), data = path.join(work, 'desktop-home'), user = path.join(work, 'user'), project = path.join(work, 'example');
for (const dir of [home, data, user, project]) await mkdir(dir, { recursive: true });
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ wizardDone: true, notifications: false, theme: 'dark', hidden: [] }));
await cp(path.join(root, 'examples/animation.html'), path.join(project, 'animation.html'));
const env = { ...process.env, ...(windows ? {} : { HOME: user, XDG_CACHE_HOME: path.join(work, 'cache') }), ...(mac || windows ? {} : { APPIMAGE_EXTRACT_AND_RUN: '1' }), MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user, LOCALAPPDATA: path.join(work, 'local') };
delete env.ELECTRON_RUN_AS_NODE; delete env.MULTIPLANE_JOBS_DIR; delete env.MULTIPLANE_NO_INDEX;
delete env.PLAYWRIGHT_BROWSERS_PATH;
// Playwright also accepts npm config aliases. Do not let them bypass isolation.
delete env.npm_config_playwright_browsers_path; delete env.npm_package_config_playwright_browsers_path;
// Always isolate the platform default, including on runners with preinstalled browsers.
// The packaged app, downloader and renderer inherit the same LOCALAPPDATA/HOME/XDG_CACHE_HOME.
const browserCache = windows ? path.join(env.LOCALAPPDATA, 'ms-playwright') : mac ? path.join(user, 'Library/Caches/ms-playwright') : path.join(env.XDG_CACHE_HOME, 'ms-playwright');
const resources = windows ? path.join(installation, 'resources') : mac ? path.join(installation, 'Multiplane.app/Contents/Resources') : path.join(installation, 'resources');
const executable = windows ? path.join(installation, 'Multiplane.exe') : mac ? path.join(installation, 'Multiplane.app/Contents/MacOS/Multiplane') : installer;
const launchArgs = !windows && !mac && process.env.MULTIPLANE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
const evidence = { platform: process.platform, arch: process.arch, launchArgs, appImageExtractAndRun: env.APPIMAGE_EXTRACT_AND_RUN === '1', version: pkg.version, screenshots: [], checks: [], work, install: false, uninstall: false };
evidence.browserDownload = { cache: browserCache, isolation: windows ? 'LOCALAPPDATA' : mac ? 'HOME' : 'XDG_CACHE_HOME', before: null, after: null };
let application, installed = false;
async function bytesIn(dir) {
  let size = 0;
  for (const item of await readdir(dir, { withFileTypes: true })) size += item.isDirectory() ? await bytesIn(path.join(dir, item.name)) : (await stat(path.join(dir, item.name))).size;
  return size;
}
async function waitFor(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= end) throw Error(message); await new Promise(resolve => setTimeout(resolve, 200)); }
}
try {
  evidence.browserDownload.cacheExistedBefore = await exists(browserCache);
  assert.equal(evidence.browserDownload.cacheExistedBefore, false, 'Verification requires a fresh isolated browser cache; existing caches must never be removed');
  if (windows) await run(installer, ['/S', '/currentuser', `/D=${installation}`], { env, timeout: 120000 });
  else if (mac) { await mkdir(installation); await run('hdiutil', ['attach', installer, '-nobrowse', '-readonly', '-mountpoint', installation]); }
  else {
    const extractionEnv = { ...env }; delete extractionEnv.APPIMAGE_EXTRACT_AND_RUN;
    await chmod(installer, 0o755); await run(installer, ['--appimage-extract'], { cwd: work, env: extractionEnv, capture: true });
  }
  installed = true; evidence.install = true;
  console.log('Temporary installation completed; checking bundled files and licenses.');
  const renderer = path.join(resources, 'renderer');
  // Ask the bundled Playwright in the packaged runtime, rather than trusting our path calculation.
  const probe = `const {createRequire}=require('node:module'); const path=require('node:path'); const fs=require('node:fs');
    const req=createRequire(path.join(process.argv[1],'package.json'));
    const core=createRequire(req.resolve('playwright-core/package.json'));
    const {registry:{registry}}=core('./lib/coreBundle');
    console.log(JSON.stringify(['chromium','chromium-headless-shell'].map(name=>{
      const entry=registry.findExecutable(name), executable=entry.executablePath();
      return {name,directory:entry.directory,executable,exists:fs.existsSync(executable),complete:fs.existsSync(path.join(entry.directory,'INSTALLATION_COMPLETE'))};
    })));`;
  const browserState = async () => {
    const result = await run(executable, ['-e', probe, renderer], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, capture: true });
    const entries = JSON.parse(result.stdout.trim());
    for (const entry of entries) assert.equal(path.dirname(entry.directory), browserCache, 'Packaged Playwright must use the isolated platform cache');
    return entries;
  };
  evidence.browserDownload.before = await browserState();
  for (const entry of evidence.browserDownload.before) {
    assert.equal(entry.exists, false, 'Chromium must be absent before the UI download');
    assert.equal(entry.complete, false, 'No completed browser installation may be reused');
  }
  assert.ok(await exists(executable)); assert.equal(await exists(path.join(renderer, 'node_modules/three')), false);
  assert.equal(JSON.parse(await readFile(path.join(renderer, 'package.json'))).version, pkg.version);
  assert.ok((await readdir(path.join(renderer, `node_modules/@img/sharp-${process.platform}-${process.arch}/lib`))).some(name => /^sharp-.*\.node$/.test(name)));
  const licenses = await verifyNotices(path.join(resources, 'app'));
  evidence.licenses = { packages: licenses.packages.length, nativeComponents: licenses.nativeComponents.length, files: licenses.files.length };
  evidence.installerBytes = (await stat(installer)).size;
  evidence.rendererBytes = await bytesIn(renderer); evidence.rendererEntries = await readdir(renderer);
  evidence.fontSha256 = createHash('sha256').update(await readFile(path.join(resources, 'app/fonts/MiSansVF.ttf'))).digest('hex');
  assert.equal(evidence.fontSha256, fontHash);
  application = await _electron.launch({ executablePath: executable, args: launchArgs, env });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  const page = await application.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const shot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name), mask: [page.locator('.path-value'), page.locator('[data-host-card] .mono'), page.locator('.info-row .mono'), page.locator('.setting-row .mono'), page.locator('.job-id'), page.locator('.check-detail')], maskColor: '#777777' });
    evidence.screenshots.push(name);
  };
  await page.locator('[data-page="环境"]').click();
  await page.locator('[data-check=node]').waitFor();
  assert.equal((await page.evaluate(() => window.multiplane.doctor())).data.checks.find(c => c.name === 'browser').ok, false);
  await shot('browser-missing.png');
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options) => {
      if (!options.detail.includes('Playwright 的官方下载服务') || !options.detail.includes('300–500 MB')) throw Error('Download confirmation is missing source or size');
      return { response: 1, checkboxChecked: false };
    };
  });
  await page.getByRole('button', { name: '安装浏览器', exact: true }).click();
  await waitFor(async () => { const state = await page.evaluate(() => window.multiplane.browserInstallState()); return state.running && state.text.includes('Downloading'); }, 'Browser download did not start', 60000);
  evidence.browserDownload.progressObserved = true;
  await page.getByRole('button', { name: '取消安装', exact: true }).click();
  await waitFor(async () => !(await page.evaluate(() => window.multiplane.browserInstallState())).running, 'Browser cancellation did not finish');
  await waitFor(async () => !await exists(path.join(browserCache, '__dirlock')), 'Cancellation left the Playwright cache locked');
  console.log('Browser cancellation released the cache lock; retrying the official download.');
  await page.getByRole('button', { name: '安装浏览器', exact: true }).click();
  await waitFor(async () => { const state = await page.evaluate(() => window.multiplane.browserInstallState()); return !state.running && (state.text === '浏览器安装完成' || state.text.startsWith('安装失败')); }, 'Browser download did not finish', 300000);
  const browserResult = await page.evaluate(() => window.multiplane.browserInstallState());
  assert.equal(browserResult.text, '浏览器安装完成', browserResult.text);
  evidence.browserDownload.after = await browserState();
  for (const entry of evidence.browserDownload.after) {
    assert.equal(entry.exists, true, 'UI download must create the Chromium executable');
    assert.equal(entry.complete, true, 'UI download must complete the browser installation');
  }
  await page.waitForFunction(() => document.querySelector('[data-check=browser] .check-status')?.textContent.startsWith('可用'));
  evidence.checks.push('Fresh browser download: official confirmation, progress, cancellation, lock release, retry and successful installation into the default cache under isolated platform cache');
  const doctor = await page.evaluate(() => window.multiplane.doctor());
  assert.equal(doctor.data.checks.length, 6);
  assert.equal(doctor.data.checks.find(c => c.name === 'browser').ok, true);
  assert.equal(doctor.data.checks.find(c => c.name === 'three').ok, false);
  assert.equal(doctor.data.config.path, path.join(home, 'config.json'));
  assert.equal(await page.locator('[data-check=three] .check-status').innerText(), '由项目自己安装');
  evidence.doctor = doctor.data.checks.map(({ name, ok }) => ({ name, ok }));
  console.log('Fresh browser installation and packaged doctor passed.');
  await shot('environment.png');
  await page.locator('[data-page="设置"]').click();
  await page.getByLabel('并行数', { exact: true }).fill('2'); await page.getByLabel('并行数', { exact: true }).press('Tab');
  await page.waitForFunction(() => !document.querySelector('#input-workers').disabled);
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'))).workers, 2);
  evidence.checks.push('Settings page persisted workers=2 in isolated MULTIPLANE_HOME');
  await shot('settings.png');
  const rendered = await run(executable, [path.join(renderer, 'bin/multiplane'), 'render', path.join(project, 'animation.html'), '--root', project, '--workers', '1', '--to', '0.5', '--json'], { cwd: project, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, capture: true });
  const events = rendered.stdout.trim().split('\n').map(JSON.parse), result = events.at(-1);
  assert.equal(result.ok, true); assert.equal(result.data.frames, 6);
  evidence.render = { command: result.command, ok: result.ok, frames: result.data.frames, bundledRenderer: true };
  console.log('Packaged renderer produced the real verification video.');
  await page.locator('[data-page="作业"]').click();
  await page.locator(`[data-job="${result.jobId}"]`).waitFor();
  await page.locator(`[data-job="${result.jobId}"]`).click();
  await page.locator('video').waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await shot('job.png');
  evidence.checks.push('Installed renderer produced a real six-frame video, listed and playable in packaged UI');
  assert.deepEqual(errors, []);
  await application.close(); application = undefined;
  for (const agent of ['.agents', '.claude', '.codex']) assert.equal(await exists(path.join(user, agent)), false);
  evidence.checks.push('Isolated skill directories remained empty');
} catch (error) {
  evidence.failure = error.message;
  if (application) {
    const page = await application.firstWindow();
    evidence.failureView = await page.locator('#placeholder').innerText().catch(() => 'unavailable');
    evidence.browserState = await page.evaluate(() => window.multiplane.browserInstallState()).catch(() => null);
    evidence.failureDoctor = await page.evaluate(() => window.multiplane.doctor()).catch(() => null);
  }
  throw error;
} finally {
  if (application) await application.close();
  if (windows && (installed || await exists(path.join(installation, 'Uninstall Multiplane.exe')))) {
    // Let NSIS copy itself outside the installation, then wait for its worker to finish.
    await run(path.join(installation, 'Uninstall Multiplane.exe'), ['/S', '/currentuser'], { env, timeout: 120000 });
    await waitFor(async () => !await exists(installation), 'Uninstaller left installation files', 60000);
    for (const file of [...shortcuts, ...(cache ? [cache] : [])]) await waitFor(async () => !await exists(file), 'Uninstaller left shortcuts or installer cache');
    for (const key of keys) assert.equal(registryExists('HKCU', key), false, 'Uninstaller left registry keys');
    evidence.uninstall = true;
    console.log('Uninstall verified: files, shortcuts, installer cache and registry keys removed.');
  }
  if (!windows && installed) {
    if (mac) await run('hdiutil', ['detach', installation]);
    else { await rm(installation, { recursive: true, force: true }); assert.equal(await exists(installation), false); }
    evidence.uninstall = true; evidence.checks.push(mac ? 'DMG detached; no system installation was created' : 'AppImage extraction removed; no system installation was created');
  }
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ ...evidence, work: '<temporary verification directory>' }, null, 2));
