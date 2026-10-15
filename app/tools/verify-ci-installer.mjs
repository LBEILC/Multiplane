import { build, Platform, Arch } from 'electron-builder';
import { cp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { run } from '../../tools/process.mjs';
import { runInstaller } from './installer-run.mjs';
import { launchOwned } from './owned-electron.mjs';

// Opt-in real NSIS regression, using a separate product and registry identity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'out/077-installer');
const product = 'MultiplaneInstallerTest077';
const require = createRequire(import.meta.url);
const config = require('../electron-builder.config.cjs');
const { UUID } = require('builder-util-runtime');
const appId = 'io.github.lbeilc.multiplane.test077';
const guid = String(UUID.v5(appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
const keys = ['HKCU', 'HKLM'].flatMap(hive => [`${hive}\\Software\\${guid}`, `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`]);
const exists = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const registry = () => keys.map(key => { try { return execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return ''; } });
assert.equal(process.platform, 'win32');
await mkdir(out, { recursive: true });
process.on('uncaughtException', error => {
  appendFileSync(path.join(out, 'worker-error.log'), `${error.stack}\n`);
  process.exitCode = 1;
});
const installer = path.join(out, 'release', `${product}.exe`);
const installation = path.join(out, 'install space', product);
const diagnostic = path.join(out, 'nsis.txt');
if (process.argv.includes('--build')) {
  await cp(path.join(root, 'app/dist'), path.join(out, 'app'), { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(out, 'app/package.json')));
  await writeFile(path.join(out, 'app/package.json'), JSON.stringify({ ...pkg, name: 'multiplane-installer-test-077', productName: product }));
  const include = (await readFile(path.join(root, 'app/tools/installer.nsh'), 'utf8')).replace(/!macro customInit\r?\n/, `!macro customInit\n  FileOpen $R9 "${diagnostic}" w\n  FileWrite $R9 '$CMDLINE$\\r$\\n'\n  IfSilent +3 0\n  FileWrite $R9 'silent=false$\\r$\\n'\n  Goto +2\n  FileWrite $R9 'silent=true$\\r$\\n'\n  FileClose $R9\n`);
  await writeFile(path.join(out, 'installer.nsh'), include);
  await build({ projectDir: path.join(root, 'app'), targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config: {
    ...config, appId, productName: product, afterPack: undefined,
    directories: { app: path.join(out, 'app'), output: path.join(out, 'release'), buildResources: path.join(root, 'app/build') },
    extraResources: config.extraResources.map(item => ({ ...item, from: path.join(root, 'app', item.from) })),
    nsis: { ...config.nsis, include: path.join(out, 'installer.nsh'), artifactName: `${product}.exe`, createDesktopShortcut: false, createStartMenuShortcut: false },
  } });
} else {
  assert.ok(registry().every(value => !value), 'Test installation already exists');
  assert.equal(await exists(path.join(installation, `${product}.exe`)), false, 'Test executable already exists');
  const env = { ...process.env, MULTIPLANE_HOME: path.join(out, 'home'), MULTIPLANE_APP_DATA: path.join(out, 'desktop'), MULTIPLANE_AGENT_HOME: path.join(out, 'agents') };
  const evidence = { appId, baseline: null, fixed: null };
  try {
    try {
      await run(installer, ['/S', '/currentuser', `/D=${installation}`], { env, timeout: 12000 });
      throw Error('Quoted baseline unexpectedly succeeded');
    } catch (error) {
      assert.match(error.message, /timed out/);
      evidence.baseline = { timeout: true, diagnostic: await readFile(diagnostic, 'utf8') };
      assert.match(evidence.baseline.diagnostic, /silent=false/);
    }
    await runInstaller(installer, ['/S', '/currentuser', `/D=${installation}`], env, { timeout: 120000 });
    evidence.fixed = { diagnostic: await readFile(diagnostic, 'utf8'), installed: await exists(path.join(installation, `${product}.exe`)) };
    assert.match(evidence.fixed.diagnostic, /silent=true/);
    assert.equal(evidence.fixed.installed, true);
    const result = await run(path.join(installation, `${product}.exe`), [path.join(installation, 'resources/renderer/bin/multiplane'), '--version'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, capture: true });
    const expectedVersion = JSON.parse(await readFile(path.join(root, 'app/package.json'))).version;
    assert.equal(result.stdout.trim(), expectedVersion);
    evidence.fixed.version = result.stdout.trim();
    await mkdir(env.MULTIPLANE_APP_DATA, { recursive: true });
    await writeFile(path.join(env.MULTIPLANE_APP_DATA, 'preferences.json'), JSON.stringify({ wizardDone: true, autoCheckUpdates: false, notifications: false }));
    const guiEnv = { ...env }; delete guiEnv.ELECTRON_RUN_AS_NODE;
    const application = await launchOwned(path.join(installation, `${product}.exe`), guiEnv);
    try {
      evidence.fixed.gui = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, version: app.getVersion(), windows: BrowserWindow.getAllWindows().length }));
      assert.equal(evidence.fixed.gui.packaged, true);
      assert.equal(evidence.fixed.gui.version, expectedVersion);
      assert.equal(evidence.fixed.gui.windows, 1);
    } finally { await application.close(); }
    console.log('Quoted baseline timed out; unquoted NSIS installation and packaged CLI passed.');
  } finally {
    const uninstaller = path.join(installation, `Uninstall ${product}.exe`);
    if (await exists(uninstaller)) await runInstaller(uninstaller, ['/S', '/currentuser', `_?=${installation}`], env, { timeout: 120000 });
    evidence.uninstalled = !(await exists(path.join(installation, `${product}.exe`))) && registry().every(value => !value);
    await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    assert.equal(evidence.uninstalled, true);
    assert.equal(path.relative(out, installation), path.join('install space', product));
    await rm(installation, { recursive: true, force: true });
  }
}
