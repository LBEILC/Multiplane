import copy from '../src/shared/copy/en.mjs';
import { nativeRealpath } from '../../tools/native-realpath.mjs';
import { _electron } from 'playwright';
import { launchOwned } from './owned-electron.mjs';
import { ensureWindowManager } from './window-smoke.mjs';
import { stopOwned } from '../src/main/owned-process.mjs';
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
import { findInstaller } from './installer-file.mjs';
import { packagedLaunch, packagedNodeCommand } from './packaged-launch.mjs';
import { fileSnapshot } from './file-snapshot.mjs';
import { privacyMasks } from './smoke-diagnostics.mjs';
import { seedMixedJobs } from './mixed-jobs.mjs';
import { cliEntry } from '../src/main/cli-entry.mjs';
import { entryCommand } from './entry-command.mjs';
import { doctorCopy } from '../src/shared/doctor-copy.mjs';
import { t } from '../src/shared/i18n.mjs';
import { runInstaller } from './installer-run.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url)), root = path.resolve(appRoot, '..');
const windows = process.platform === 'win32', mac = process.platform === 'darwin';
const ownedProcesses = [];
const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const unpackedIndex = process.argv.indexOf('--unpacked');
const unpacked = unpackedIndex < 0 ? null : path.resolve(process.argv[unpackedIndex + 1] || (() => { throw Error('--unpacked requires a directory'); })());
const installer = unpacked ? null : await findInstaller(path.join(appRoot, 'release'));
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
if (windows && !unpacked) for (const hive of ['HKCU', 'HKLM']) for (const key of keys) assert.equal(registryExists(hive, key), false, 'Existing installation must not be changed by verification');
if (!unpacked) for (const file of [...shortcuts, ...(cache ? [cache] : [])]) assert.equal(await exists(file), false, 'Existing shortcuts/cache must not be changed by verification');
const work = await nativeRealpath(await mkdtemp(path.join(out, 'work-')));
// Keep the runtime outside the checkout: Node must not resolve optional packages
// from the repository's ancestor node_modules and hide missing bundled files.
const installationWork = await nativeRealpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-packaged-')));
const installation = path.join(installationWork, windows ? 'installed' : mac ? 'mount' : 'squashfs-root'), home = windows ? path.join(work, 'user', '.multiplane') : path.join(work, 'renderer-home'), data = windows ? path.join(home, 'desktop') : path.join(work, 'desktop-home'), user = path.join(work, 'user'), project = path.join(work, 'example space');
for (const dir of [home, data, user, project]) await mkdir(dir, { recursive: true });
const legacyHome = path.join(work, 'roaming', 'multiplane');
const preferenceSource = windows ? path.join(legacyHome, 'desktop') : data;
await mkdir(preferenceSource, { recursive: true });
await writeFile(path.join(preferenceSource, 'preferences.json'), JSON.stringify({ language: 'en', wizardDone: true, notifications: false, theme: 'dark', hidden: [] }));
await cp(path.join(root, 'examples/animation.html'), path.join(project, 'animation.html'));
const env = { ...process.env, ...(windows ? {} : { HOME: user, XDG_CACHE_HOME: path.join(work, 'cache') }), ...(mac || windows ? {} : { APPIMAGE_EXTRACT_AND_RUN: '1' }), MULTIPLANE_HOME: windows ? '' : home, MULTIPLANE_APP_DATA: windows ? '' : data, USERPROFILE: user, APPDATA: path.join(work, 'roaming'), MULTIPLANE_TEST_USER_HOME: user, MULTIPLANE_AGENT_HOME: user, LOCALAPPDATA: path.join(work, 'local') };
delete env.ELECTRON_RUN_AS_NODE; delete env.MULTIPLANE_JOBS_DIR; delete env.MULTIPLANE_NO_INDEX;
delete env.PLAYWRIGHT_BROWSERS_PATH;
// Playwright also accepts npm config aliases. Do not let them bypass isolation.
delete env.npm_config_playwright_browsers_path; delete env.npm_package_config_playwright_browsers_path;
// Always isolate the platform default, including on runners with preinstalled browsers.
// The packaged app, downloader and renderer inherit the same LOCALAPPDATA/HOME/XDG_CACHE_HOME.
const browserCache = windows ? path.join(env.LOCALAPPDATA, 'ms-playwright') : mac ? path.join(user, 'Library/Caches/ms-playwright') : path.join(env.XDG_CACHE_HOME, 'ms-playwright');
const resources = windows ? path.join(installation, 'resources') : mac ? path.join(installation, 'Multiplane.app/Contents/Resources') : path.join(installation, 'resources');
const launch = packagedLaunch(process.platform, installation, installer, process.env.MULTIPLANE_NO_SANDBOX === '1');
if (unpacked && process.platform === 'linux') launch.gui = launch.node;
const executable = launch.gui, launchArgs = launch.guiArgs;
const evidence = { mode: unpacked ? 'unpacked' : 'installer', platform: process.platform, arch: process.arch, launchArgs, appImageExtractAndRun: env.APPIMAGE_EXTRACT_AND_RUN === '1', version: pkg.version, screenshots: [], checks: [], work, install: false, uninstall: false };
evidence.browserDownload = { cache: browserCache, isolation: windows ? 'LOCALAPPDATA' : mac ? 'HOME' : 'XDG_CACHE_HOME', before: null, after: null };
let application, windowManager, installed = false, externalDirectory;
const snapshots = new Map();
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
  windowManager = await ensureWindowManager(evidence);
  evidence.browserDownload.cacheExistedBefore = await exists(browserCache);
  assert.equal(evidence.browserDownload.cacheExistedBefore, false, 'Verification requires a fresh isolated browser cache; existing caches must never be removed');
  if (unpacked) { await cp(unpacked, installation, { recursive: true }); assert.ok(await exists(executable), 'Unpacked executable is missing'); }
  else if (windows) await runInstaller(installer, ['/S', '/currentuser', `/D=${installation}`], { ...env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data });
  else if (mac) { await mkdir(installation); await run('hdiutil', ['attach', installer, '-nobrowse', '-readonly', '-mountpoint', installation]); }
  else {
    const extractionEnv = { ...env }; delete extractionEnv.APPIMAGE_EXTRACT_AND_RUN;
    await chmod(installer, 0o755); await run(installer, ['--appimage-extract'], { cwd: installationWork, env: extractionEnv, capture: true });
  }
  installed = !unpacked; evidence.install = !unpacked;
  snapshots.set(installation, await fileSnapshot(installation));
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
    const command = packagedNodeCommand(launch.node, ['-e', probe, renderer], env);
    const result = await run(command.file, command.args, { env: command.env, capture: true });
    const entries = JSON.parse(result.stdout.trim());
    for (const entry of entries) assert.equal(path.dirname(entry.directory), browserCache, 'Packaged Playwright must use the isolated platform cache');
    return entries;
  };
  assert.ok(await exists(launch.node), 'Packaged Node must be the extracted executable');
  if (process.platform === 'linux') {
    const binary = await readFile(launch.node);
    assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46', 'Node entry must be an ELF binary, not AppRun');
    const appRun = await readFile(path.join(installation, 'AppRun'), 'utf8');
    const desktop = await readFile(path.join(installation, 'multiplane-desktop.desktop'), 'utf8');
    evidence.linuxSandbox = {
      chromeSandboxMode: ((await stat(path.join(installation, 'chrome-sandbox'))).mode & 0o7777).toString(8),
      desktopExec: desktop.split('\n').find(line => line.startsWith('Exec=')),
      appRunChecksUserNamespaces: appRun.includes('unshare -Ur true'),
      appRunCanDisableSandbox: appRun.includes('NO_SANDBOX=(--no-sandbox)')
    };
  }
  assert.ok(await exists(executable)); assert.equal(await exists(path.join(renderer, 'node_modules/three')), false);
  assert.equal(JSON.parse(await readFile(path.join(renderer, 'package.json'))).version, pkg.version);
  assert.ok((await readdir(path.join(renderer, `node_modules/@img/sharp-${process.platform}-${process.arch}/lib`))).some(name => /^sharp-.*\.node$/.test(name)));
  const licenses = await verifyNotices(path.join(resources, 'app'));
  evidence.licenses = { packages: licenses.packages.length, nativeComponents: licenses.nativeComponents.length, files: licenses.files.length };
  evidence.installerBytes = installer ? (await stat(installer)).size : null;
  evidence.rendererBytes = await bytesIn(renderer); evidence.rendererEntries = await readdir(renderer);
  evidence.fontSha256 = createHash('sha256').update(await readFile(path.join(resources, 'app/fonts/MiSansVF.ttf'))).digest('hex');
  assert.equal(evidence.fontSha256, fontHash);
  externalDirectory = await nativeRealpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-external-job-')));
  const historical = await seedMixedJobs(windows ? legacyHome : home, path.join(work, 'historical'), { externalDirectory });
  if (windows) {
    await writeFile(path.join(legacyHome, 'config.json'), '{"workers":1}');
    await writeFile(path.join(preferenceSource, 'Cache'), 'keep');
  }
  evidence.mixedJobs = { expected: historical, externalDrive: path.parse(externalDirectory).root !== path.parse(home).root };
  application = windows ? await launchOwned(executable, env, owned => ownedProcesses.push(owned)) : await _electron.launch({ executablePath: executable, args: launchArgs, env });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  evidence.runtime = await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const { rendererRoot } = require(app.getAppPath());
    return { execPath: process.execPath, renderer: rendererRoot(app.isPackaged, process.resourcesPath, app.getAppPath()), argv: process.argv, noSandbox: app.commandLine.hasSwitch('no-sandbox') };
  });
  if (process.platform === 'linux') {
    assert.notEqual(evidence.runtime.execPath, installer, 'App must call the mounted Electron binary, not the AppImage shell');
    assert.equal(path.basename(evidence.runtime.execPath), 'multiplane-runtime');
    assert.equal(evidence.runtime.renderer, path.join(path.dirname(evidence.runtime.execPath), 'resources/renderer'));
    const runtimeInstallation = path.dirname(evidence.runtime.execPath);
    if (runtimeInstallation !== installation) snapshots.set(runtimeInstallation, await fileSnapshot(runtimeInstallation));
  }
  const page = await application.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const shot = async name => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name), mask: [...privacyMasks(page), page.locator('.job-id')], maskColor: '#777777' });
    evidence.screenshots.push(name);
  };
  for (const id of historical) await page.locator(`[data-job="${id}"]`).waitFor();
  assert.equal(await page.locator('[data-job="invalid-status"]').count(), 0);
  if (windows) {
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), data);
    assert.equal(await readFile(path.join(home, 'jobs.jsonl'), 'utf8'), await readFile(path.join(legacyHome, 'jobs.jsonl'), 'utf8'));
    assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'))).workers, 1);
    assert.equal(await exists(path.join(preferenceSource, 'preferences.json')), false);
    assert.equal(await readFile(path.join(preferenceSource, 'Cache'), 'utf8'), 'keep');
    evidence.checks.push('Default Windows profile home: CLI migrated old config and index before first job list; desktop preferences moved and old cache retained');
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await waitFor(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), 'Owner did not minimize');
  // Without FUSE, both AppImage copies would extract to the same /tmp directory, and the
  // runtime deletes it when the second copy exits, taking the first copy's files with it.
  const contenderEnv = env.APPIMAGE_EXTRACT_AND_RUN === '1' ? { ...env, TMPDIR: path.join(work, 'contender-tmp') } : env;
  if (contenderEnv !== env) await mkdir(contenderEnv.TMPDIR, { recursive: true });
  const contender = await run(executable, launchArgs, { env: contenderEnv, capture: true, timeout: 15000, killTree: true });
  assert.equal(contender.code, 0);
  await waitFor(() => application.evaluate(({ BrowserWindow }) => { const windows = BrowserWindow.getAllWindows(); return windows.length === 1 && !windows[0].isMinimized() && windows[0].isVisible(); }), 'Owner window was not restored');
  evidence.checks.push('Second packaged instance exited and restored the existing window');
  await page.locator('[data-page="environment"]').click();
  const checkDoctor = async browserAvailable => {
    // These rows only exist after the environment page's real IPC doctor completes.
    const requiredChecks = ['browser', 'ffmpeg', 'gpu', 'libx264', 'node', 'three'];
    await page.waitForFunction(names => names.every(name => document.querySelector(`[data-check="${name}"]`)), requiredChecks);
    assert.equal(await page.locator('[data-check=three] .check-status').innerText(), copy.projectInstalled);
    const doctor = await page.evaluate(() => window.multiplane.doctor());
    const checkNames = doctor.data.checks.map(c => c.name).sort();
    for (const name of requiredChecks) assert.ok(checkNames.includes(name), `Missing required doctor check: ${name}`);
    assert.deepEqual(await page.locator('[data-check]').evaluateAll(rows => rows.map(row => row.dataset.check).sort()), checkNames);
    for (const name of ['node', 'ffmpeg', 'libx264']) assert.equal(doctor.data.checks.find(c => c.name === name).ok, true, name);
    assert.equal(doctor.data.checks.find(c => c.name === 'browser').ok, browserAvailable);
    assert.equal(doctor.data.checks.find(c => c.name === 'three').ok, false);
    const gpu = doctor.data.checks.find(c => c.name === 'gpu');
    assert.equal(typeof gpu.ok, 'boolean');
    if (!browserAvailable) assert.equal(gpu.ok, false);
    for (const c of doctor.data.checks.filter(c => c.name !== 'three')) {
      const content = doctorCopy(c, { ffmpeg: doctor.data.checks.find(c => c.name === 'ffmpeg').ok, packaged: true });
      assert.equal(await page.locator(`[data-check="${c.name}"] .check-status`).textContent(), 'raw' in content ? content.raw : t(content.status, content.values));
    }
    assert.equal(doctor.data.config.path, path.join(home, 'config.json'));
    return doctor;
  };
  evidence.doctorBeforeDownload = (await checkDoctor(false)).data.checks;
  console.log('Real packaged environment page passed before any verification-side Node probe.');
  evidence.browserDownload.before = await browserState();
  for (const entry of evidence.browserDownload.before) {
    assert.equal(entry.exists, false, 'Chromium must be absent before the UI download');
    assert.equal(entry.complete, false, 'No completed browser installation may be reused');
  }
  await shot('browser-missing.png');
  await application.evaluate(({ dialog }, expected) => {
    dialog.showMessageBox = async (_window, options) => {
      if (options.detail !== expected) throw Error('Download confirmation is missing source or size');
      return { response: 1, checkboxChecked: false };
    };
  }, copy.browserConfirmDetail);
  await page.getByRole('button', { name: copy.installBrowser, exact: true }).click();
  await waitFor(async () => { const state = await page.evaluate(() => window.multiplane.browserInstallState()); return state.running && state.text.includes('Downloading'); }, 'Browser download did not start', 60000);
  evidence.browserDownload.progressObserved = true;
  await page.getByRole('button', { name: copy.cancelInstall, exact: true }).click();
  await waitFor(async () => !(await page.evaluate(() => window.multiplane.browserInstallState())).running, 'Browser cancellation did not finish');
  await waitFor(async () => !await exists(path.join(browserCache, '__dirlock')), 'Cancellation left the Playwright cache locked');
  console.log('Browser cancellation released the cache lock; retrying the official download.');
  await page.getByRole('button', { name: copy.installBrowser, exact: true }).click();
  await waitFor(async () => { const state = await page.evaluate(() => window.multiplane.browserInstallState()); return !state.running && (state.text === copy.browserInstalled || [copy.installError, copy.installExitError].some(text => state.text.startsWith(text.split('{')[0]))); }, 'Browser download did not finish', 300000);
  const browserResult = await page.evaluate(() => window.multiplane.browserInstallState());
  assert.equal(browserResult.text, copy.browserInstalled, browserResult.text);
  evidence.browserDownload.after = await browserState();
  for (const entry of evidence.browserDownload.after) {
    assert.equal(entry.exists, true, 'UI download must create the Chromium executable');
    assert.equal(entry.complete, true, 'UI download must complete the browser installation');
  }
  await page.waitForFunction(() => document.querySelector('[data-check=browser] > span')?.classList.contains('succeeded'));
  evidence.checks.push('Fresh browser download: official confirmation, progress, cancellation, lock release, retry and successful installation into the default cache under isolated platform cache');
  const doctor = await checkDoctor(true);
  evidence.doctor = doctor.data.checks.map(({ name, ok }) => ({ name, ok }));
  console.log('Fresh browser installation and packaged doctor passed.');
  await shot('environment.png');
  await page.locator('[data-page="settings"]').click();
  await page.getByLabel(copy.workers, { exact: true }).fill('2'); await page.getByLabel(copy.workers, { exact: true }).press('Tab');
  await page.waitForFunction(() => !document.querySelector('#input-workers').disabled);
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'))).workers, 2);
  evidence.checks.push('Settings page persisted workers=2 in the isolated renderer home');
  await shot('settings.png');
  const entry = cliEntry(process.platform, launch.node, resources, unpacked ? {} : { ...env, APPIMAGE: installer });
  const invoke = args => { const command = entryCommand(entry, args); return run(command.file, command.args, { ...command.options, env, cwd: project, capture: true, killTree: true }); };
  // With APPIMAGE_EXTRACT_AND_RUN, the AppImage runtime lists the files it extracts on stdout first.
  const commandVersion = await invoke(['--version']); assert.equal(commandVersion.stdout.trim().split('\n').at(-1).trim(), pkg.version);
  const commandDoctor = await invoke(['doctor', '--json']);
  assert.equal(JSON.parse(commandDoctor.stdout.trim().split('\n').at(-1)).ok, true);
  const commandConfig = await invoke(['config', 'get', '--json']);
  assert.equal(JSON.parse(commandConfig.stdout.trim().split('\n').at(-1)).data.file, path.join(home, 'config.json'));
  evidence.cliEntry = { version: true, doctor: true, config: true, spacePath: true };
  const rendered = await invoke(['render', path.join(project, 'animation.html'), '--root', project, '--job-dir', path.join(project, 'out/jobs'), '--workers', '1', '--to', '0.5', '--json']);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const events = rendered.stdout.trim().split('\n').map(JSON.parse), result = events.at(-1);
  assert.equal(result.ok, true); assert.equal(result.data.frames, 6);
  for (const artifact of result.artifacts) assert.ok(artifact.path.startsWith(project + path.sep), 'Render artifacts must stay in the temporary project');
  assert.ok(await exists(path.join(project, 'out/jobs', result.jobId, 'status.json')));
  evidence.render = { command: result.command, ok: result.ok, frames: result.data.frames, bundledRenderer: true, launchedByEntry: true, execPath: evidence.runtime.execPath, renderer: evidence.runtime.renderer };
  console.log('Packaged renderer produced the real verification video.');
  await page.locator('[data-page="jobs"]').click();
  await page.locator(`[data-job="${result.jobId}"]`).waitFor();
  await waitFor(async () => (await page.evaluate(() => window.multiplane.snapshot())).jobs.find(job => job.jobId === result.jobId)?.state === 'succeeded', 'New job did not reach its terminal desktop snapshot');
  for (const id of historical) await page.locator(`[data-job="${id}"]`).waitFor();
  evidence.mixedJobs.actual = await page.locator('[data-job]').evaluateAll(rows => rows.map(row => row.dataset.job));
  const logRows = (await readFile(path.join(data, 'logs/desktop.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(logRows.filter(row => row.scope === 'job-finished' && row.message === result.jobId).length, 1);
  assert.ok(logRows.some(row => row.scope === 'jobs' && row.message.includes('missing-fields')));
  await page.evaluate(() => window.multiplane.reportFault('Packaged verification renderer fault'));
  await waitFor(async () => (await readFile(path.join(data, 'logs/desktop.log'), 'utf8')).includes('Packaged verification renderer fault'), 'Renderer fault was not persisted');
  evidence.checks.push('Mixed historical jobs and the newly rendered job coexist in the packaged UI');
  await page.locator(`[data-job="${result.jobId}"]`).click();
  await page.locator('video').waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  await shot('job.png');
  evidence.checks.push('Installed renderer produced a real six-frame video, listed and playable in packaged UI');
  assert.deepEqual(errors, []);
  // AppImage extract-and-run may remove its runtime tree on exit.
  for (const [directory, before] of snapshots) if (directory !== installation) {
    assert.deepEqual(await fileSnapshot(directory), before, 'Runtime installation changed during verification');
    snapshots.delete(directory);
  }
  await application.close(); application = undefined;
  if (windows) {
    evidence.firstInstall = [];
    for (const ffmpegState of ['missing', 'available']) {
      await run(process.execPath, [path.join(appRoot, 'tools/diagnose-first-install.mjs'), executable, doctor.environment.ffmpeg.path, 'lock', ffmpegState], {
        env: { ...env, MULTIPLANE_DIAGNOSTIC_BROWSER_CACHE: browserCache }, capture: true, killTree: true,
        onOutput: bytes => process.stdout.write(bytes)
      });
      evidence.firstInstall.push({ ffmpegState, passed: true });
    }
    evidence.checks.push('No preferences: FFmpeg missing (steps 1/2/3, saved manual path) and available on PATH (steps 1/3); both isolated skills, nine old jobs, CLI render, ten rows, one notification and single-instance lock in each scenario');
  }
  if (process.platform === 'linux') {
    // Also observe AppRun's default policy, independently of the CI GUI override.
    const defaultEnv = { ...env }; delete defaultEnv.MULTIPLANE_NO_SANDBOX;
    application = await _electron.launch({ executablePath: executable, args: [], env: defaultEnv });
    await application.firstWindow();
    evidence.linuxSandbox.withoutCiOverride = await application.evaluate(({ app }) => ({ noSandbox: app.commandLine.hasSwitch('no-sandbox'), argv: process.argv }));
    await application.close(); application = undefined;
  }
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
  try {
    if (application) await application.close();
    for (const owned of ownedProcesses) await owned.close();
  } finally {
    if (windowManager) await stopOwned(windowManager);
  }
  let snapshotError;
  if (snapshots.has(installation)) {
    try {
      assert.deepEqual(await fileSnapshot(installation), snapshots.get(installation), 'Installed files changed during verification');
      evidence.installationUnchanged = true;
      evidence.checks.push('Installation file inventory, SHA-256 contents and modification metadata unchanged');
    } catch (error) { snapshotError = error; evidence.installationUnchanged = false; evidence.failure ??= error.message; }
  }
  if (windows && !unpacked && (installed || await exists(path.join(installation, 'Uninstall Multiplane.exe')))) {
    // Let NSIS copy itself outside the installation, then wait for its worker to finish.
    await runInstaller(path.join(installation, 'Uninstall Multiplane.exe'), ['/S', '/currentuser'], { ...env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data });
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
  // The downloaded browsers, the installation copy and the seeded external job are
  // reproducible and never outlive a run. A passing run also drops its simulated
  // profile; a failing one keeps it beside evidence.json for inspection.
  evidence.workKept = Boolean(evidence.failure);
  for (const directory of [browserCache, installationWork, ...(externalDirectory ? [externalDirectory] : []), ...(evidence.workKept ? [] : [work])]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
      (evidence.cleanupErrors ??= []).push(`${path.basename(directory)}: ${error.code || error.message}`);
      console.warn(`Could not remove ${directory}: ${error.code || error.message}`);
    });
  }
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (snapshotError) throw snapshotError;
}
console.log(JSON.stringify({ ...evidence, work: '<temporary verification directory>' }, null, 2));
