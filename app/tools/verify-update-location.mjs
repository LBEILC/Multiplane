import { build as bundle } from 'esbuild';
import { build, Platform, Arch } from 'electron-builder';
import { cp, mkdir, readFile, writeFile, stat, rm, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { run } from '../../tools/process.mjs';

// Run inside the repository's owned Job Object, retaining the supervisor while
// Electron quits and its installer runs. Never use the production identifiers.
if (!process.argv.includes('--owned')) {
  await run(process.execPath, [fileURLToPath(import.meta.url), '--owned', ...process.argv.slice(2)], { timeout: 900000 });
  process.exit(0);
}
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(appRoot, '..');
const require = createRequire(import.meta.url);
const config = require('../electron-builder.config.cjs');
const configJson = JSON.stringify(config);
const { UUID } = require('builder-util-runtime');
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');
const name = 'multiplane-update-test-064', product = 'MultiplaneUpdateTest064';
const appId = 'io.github.lbeilc.multiplane.test064';
const guid = String(UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
const keys = ['HKCU', 'HKLM'].flatMap(hive => [`${hive}\\Software\\${guid}`, `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`]);
const mode = process.argv.includes('--fixed') ? 'fixed' : 'baseline';
const stale = process.argv.includes('--stale-state');
const out = path.join(root, 'out/064-update', mode);
const results = path.join(out, stale ? 'stale' : 'normal');
const installation = path.join(out, 'custom space', product);
const data = path.join(out, 'desktop');
const cache = path.join(process.env.LOCALAPPDATA, name + '-updater');
const defaultInstall = path.join(process.env.LOCALAPPDATA, 'Programs', product);
const exists = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const registry = () => keys.map(key => { try { return execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return ''; } });
assert.equal(process.platform, 'win32');
assert.notEqual(appId, config.appId);
assert.ok(registry().every(value => !value), 'A previous test installation must be cleaned first');
assert.equal(await exists(cache), false, 'Refusing to reuse an existing test updater cache');
assert.equal(await exists(defaultInstall), false, 'Refusing to reuse an existing default test installation');
assert.equal(await exists(installation), false, 'Refusing to overwrite a test installation');
await mkdir(out, { recursive: true });
await mkdir(results, { recursive: true });
const requests = [];
const server = createServer(async (req, res) => {
  try {
    const fileName = path.basename(new URL(req.url, 'http://localhost').pathname);
    assert.match(fileName, /^(latest\.yml|MultiplaneUpdateTest064-Setup-0\.3\.9[01]-x64\.exe(?:\.blockmap)?)$/);
    const version = fileName.includes('0.3.90') ? '0.3.90' : '0.3.91';
    const file = path.join(out, version, fileName);
    const size = (await stat(file)).size;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : size - 1;
    assert.ok(start >= 0 && end < size && start <= end);
    res.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    const row = { fileName, range: req.headers.range ?? null, bytes: 0 }; requests.push(row);
    const stream = createReadStream(file, { start, end });
    stream.on('data', chunk => { row.bytes += chunk.length; }); stream.pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(19464, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}/`;
const evidence = { mode, stale, appId, product, requests };
const wait = async (fn, timeout = 120000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw Error('Timed out waiting for update verification');
};
let electron, clicker;
let logOffset = 0;
try {
  await cp(path.join(appRoot, 'dist'), path.join(out, 'app'), { recursive: true });
  // The baseline cleanup macro hardcodes the production cache name. Replace it
  // only in the test include, so even its empty-directory cleanup stays isolated.
  await writeFile(path.join(out, 'installer.nsh'), (await readFile(path.join(appRoot, 'tools/installer.nsh'), 'utf8')).replaceAll('multiplane-desktop-updater', name + '-updater'));
  await mkdir(data, { recursive: true });
  if (await exists(path.join(data, 'logs/desktop.log'))) logOffset = (await readFile(path.join(data, 'logs/desktop.log'), 'utf8')).length;
  await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ wizardDone: true, autoCheckUpdates: false, language: 'en', notifications: false }));
  for (const version of ['0.3.90', '0.3.91']) {
    if (process.argv.includes('--reuse-builds') && await exists(path.join(out, version, `${product}-Setup-${version}-x64.exe.blockmap`))) continue;
    await writeFile(path.join(out, 'app/package.json'), JSON.stringify({ name, productName: product, version, main: 'main.cjs' }));
    await bundle({ absWorkingDir: appRoot, entryPoints: ['src/main/index.ts'], outfile: path.join(out, 'app/main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24',
      banner: { js: `process.env.MULTIPLANE_APP_DATA=${JSON.stringify(data)};process.env.MULTIPLANE_HOME=${JSON.stringify(path.join(out, 'home'))};` },
      plugins: [{ name: 'isolated-update-test', setup(b) { b.onLoad({ filter: /src[\\/]main[\\/]index\.ts$/ }, async args => {
        let contents = await readFile(args.path, 'utf8');
        // Baseline retains diagnostics but disables task 064's two repairs.
        if (mode === 'baseline') contents = contents.replace('new WindowsUpdater()', 'platformUpdater').replace("installationDirectory: path.dirname(app.getPath('exe')),", '');
        contents = contents.replace('updates.configureAutomatic(prefs.value.autoCheckUpdates);', `autoUpdater.setFeedURL({provider:'generic',url:${JSON.stringify(url)},useMultipleRangeRequest:false});\n globalThis.__updateTest = updates;\n updates.configureAutomatic(false);\n if (app.getVersion() === '0.3.91') { await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(path.join(out, 'restarted.json'))}, JSON.stringify({version:app.getVersion(),executable:process.execPath}))); app.exit(); }`);
        return { loader: 'ts', contents };
      }); } }] });
    await build({ projectDir: appRoot, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config: {
      ...JSON.parse(configJson), appId, productName: product,
      directories: { app: path.join(out, 'app'), output: path.join(out, version), buildResources: path.join(appRoot, 'build') },
      extraResources: JSON.parse(configJson).extraResources.map(item => ({ ...item, from: path.join(appRoot, item.from) })),
      publish: [{ provider: 'generic', url }],
      nsis: { ...config.nsis, include: path.join(out, 'installer.nsh'), artifactName: product + '-Setup-${version}-${arch}.${ext}', createDesktopShortcut: false, createStartMenuShortcut: false },
    } });
  }
  const installer = version => path.join(out, version, `${product}-Setup-${version}-x64.exe`);
  const maps = await Promise.all(['0.3.90', '0.3.91'].map(async version => JSON.parse(gunzipSync(await readFile(installer(version) + '.blockmap')))));
  evidence.expectedDownloadBytes = computeOperations(...maps, { info() {}, warn() {}, debug() {} }).filter(op => op.kind === OperationKind.DOWNLOAD).reduce((n, op) => n + op.end - op.start, 0);
  evidence.fullBytes = (await stat(installer('0.3.91'))).size;
  await run(installer('0.3.90'), ['/S', '/currentuser', `/D=${installation}`], { windowsVerbatimArguments: true, timeout: 120000 });
  evidence.beforeRegistry = registry();
  if (stale) {
    // Reproduce the observed registry/path disagreement and the upstream
    // download-before-install cache window, only under the test identity.
    execFileSync('reg.exe', ['add', keys[0], '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', defaultInstall, '/f'], { windowsHide: true });
    await cp(installer('0.3.91') + '.blockmap', path.join(cache, 'current.blockmap'));
    evidence.staleRegistry = registry();
  }
  await rm(path.join(out, 'restarted.json'), { force: true });
  console.log('Installed isolated baseline', evidence.beforeRegistry);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ executablePath: path.join(installation, product + '.exe'), env });
  const page = await electron.firstWindow();
  await page.locator('[data-page=about]').click();
  await page.locator('[data-pref=update-check]').click();
  await page.locator('[data-update-phase=available]').waitFor();
  await page.locator('[data-pref=update-download]').click();
  await page.locator('[data-update-phase=downloaded]').waitFor({ timeout: 120000 });
  evidence.downloadState = await electron.evaluate(() => globalThis.__updateTest.state);
  evidence.installerBytesServed = requests.filter(row => row.fileName.endsWith('.exe')).reduce((n, row) => n + row.bytes, 0);
  evidence.networkBodyBytes = requests.reduce((n, row) => n + row.bytes, 0);
  await page.screenshot({ path: path.join(results, 'downloaded.png') });
  const pending = path.join(cache, 'pending', path.basename(installer('0.3.91')));
  clicker = spawn('powershell.exe', ['-NoProfile', '-File', path.join(appRoot, 'tools/update-installer-ui.ps1'), '-Installer', pending, '-Evidence', path.join(results, 'installer-ui.json')], { windowsHide: true, stdio: 'inherit' });
  const clickerDone = new Promise((resolve, reject) => { clicker.on('exit', code => code === 0 ? resolve() : reject(Error(`Installer UI exited ${code}`))); clicker.on('error', reject); });
  await page.locator('[data-pref=update-install]').click();
  await clickerDone;
  await wait(() => exists(path.join(out, 'restarted.json')));
  evidence.restart = JSON.parse(await readFile(path.join(out, 'restarted.json'), 'utf8'));
  evidence.afterRegistry = registry();
  evidence.updatedInPlace = evidence.restart.executable.toLowerCase() === path.join(installation, product + '.exe').toLowerCase();
  evidence.log = (await readFile(path.join(data, 'logs/desktop.log'), 'utf8')).slice(logOffset);
  if (mode === 'fixed') {
    assert.equal(evidence.updatedInPlace, true);
    assert.equal(evidence.installerBytesServed, evidence.expectedDownloadBytes);
    assert.equal(evidence.downloadState.total, evidence.expectedDownloadBytes);
    assert.match(evidence.afterRegistry[1], /DisplayVersion\s+REG_SZ\s+0\.3\.91/);
  }
  console.log(JSON.stringify({ ...evidence, log: undefined, requests: undefined }, null, 2));
} finally {
  // Only the two exact test destinations can contain this test uninstaller.
  try { await electron?.close(); } catch {}
  for (const folder of [installation, defaultInstall]) {
    const uninstaller = path.join(folder, `Uninstall ${product}.exe`);
    if (await exists(uninstaller)) await run(uninstaller, ['/S', '/currentuser', `_?=${folder}`], { windowsVerbatimArguments: true, timeout: 120000 });
  }
  evidence.cleanedRegistry = registry();
  assert.ok(evidence.cleanedRegistry.every(value => !value), 'Test registry keys remain');
  if (await exists(cache)) { assert.equal(path.basename(cache), name + '-updater'); await rm(cache, { recursive: true }); }
  for (const folder of [installation, defaultInstall]) if (await exists(folder)) {
    assert.equal(path.basename(folder), product); await rm(folder, { recursive: true });
  }
  evidence.cleaned = true;
  server.close();
  await writeFile(path.join(results, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
