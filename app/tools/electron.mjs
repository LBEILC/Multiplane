import { readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../tools/process.mjs';

export async function ensureElectron(app = fileURLToPath(new URL('../', import.meta.url))) {
  const directory = path.join(app, 'node_modules/electron');
  try {
    const lock = JSON.parse(await readFile(path.join(app, 'package-lock.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const wanted = lock.packages['node_modules/electron'].version;
    if (pkg.version !== wanted) throw Error(`Installed package ${pkg.version} differs from lockfile ${wanted}; run npm ci`);
    const executable = { win32: 'electron.exe', linux: 'electron', darwin: 'Electron.app/Contents/MacOS/Electron' }[process.platform];
    if (!executable) throw Error(`Unsupported Electron host: ${process.platform}`);
    // A partial extraction can retain version/path markers while losing licenses.
    const license = path.join(directory, 'dist/LICENSES.chromium.html');
    if (!(await stat(license).catch(() => null))?.size) await rm(path.join(directory, 'path.txt'), { force: true });
    const env = { ...process.env, ELECTRON_INSTALL_PLATFORM: process.platform, ELECTRON_INSTALL_ARCH: process.arch, npm_config_arch: process.arch };
    for (const key of ['ELECTRON_SKIP_BINARY_DOWNLOAD', 'ELECTRON_OVERRIDE_DIST_PATH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums']) delete env[key];
    await run(process.execPath, [path.join(directory, 'install.js')], { cwd: app, env, timeout: 300000 });
    const version = (await readFile(path.join(directory, 'dist/version'), 'utf8')).trim().replace(/^v/, '');
    if (version !== wanted) throw Error(`Binary version ${version} differs from lockfile ${wanted}`);
    if ((await readFile(path.join(directory, 'path.txt'), 'utf8')).trim() !== executable) throw Error('Electron executable path does not match the native host');
    for (const file of [path.join(directory, 'dist', executable), license]) if (!(await stat(file)).size) throw Error(`Empty Electron file: ${path.basename(file)}`);
    console.log(`Electron ${wanted} is installed for ${process.platform}/${process.arch}.`);
    return path.join(directory, 'dist', executable);
  } catch (cause) {
    throw new Error(`Unable to prepare the locked Electron runtime: ${cause.message}`, { cause });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await ensureElectron();
