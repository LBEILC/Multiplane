import { mkdir, cp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkFont, prepareFont } from './fonts.mjs';
import { generateNotices } from './notices.mjs';
import { npm, run } from '../../tools/process.mjs';
import { ensureElectron } from './electron.mjs';
import { bundleThree } from './bundle-three.mjs';

const app = fileURLToPath(new URL('../', import.meta.url)), root = path.resolve(app, '..');
process.chdir(app);
await ensureElectron(app);
if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw Error('Unsupported packaging host');
const pkg = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
const rendererPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== rendererPackage.version) throw Error('Desktop and renderer versions must match before packaging');
try { await checkFont(); } catch { await prepareFont(); }
await checkFont();
const appOutput = path.resolve(app, 'dist');
if (path.relative(app, appOutput) !== 'dist') throw Error('Unsafe desktop staging path');
await rm(appOutput, { recursive: true, force: true });
await run(process.execPath, ['tools/build.mjs'], { cwd: app });
const stage = path.resolve(app, 'build/renderer');
if (path.relative(path.resolve(app, 'build'), stage) !== 'renderer') throw Error('Unsafe renderer staging path');
await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
for (const name of ['bin', 'src', 'skills', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'tools/install-browser.mjs']) {
  const target = path.join(stage, name); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(root, name), target, { recursive: true });
}
await npm(['ci', '--omit=dev'], { cwd: stage, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
try { await stat(path.join(stage, 'node_modules/three')); throw Error('three unexpectedly installed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await bundleThree(root, stage);
const require = createRequire(path.join(stage, 'package.json'));
await require('sharp')({ create: { width: 1, height: 1, channels: 4, background: '#fff' } }).png().toBuffer();
const manifest = await generateNotices(root, app, stage, path.join(app, 'dist'));
await writeFile(path.join(app, 'dist/package.json'), JSON.stringify({ name: pkg.name, productName: 'Multiplane', description: 'Local HTML video renderer companion', version: pkg.version, private: true, license: pkg.license, main: 'main.cjs' }, null, 2) + '\n');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const { build, Platform, Arch } = await import('electron-builder');
const target = { win32: [Platform.WINDOWS, 'nsis'], darwin: [Platform.MAC, 'dmg'], linux: [Platform.LINUX, 'AppImage'] }[process.platform];
await build({ targets: target[0].createTarget(target[1], Arch[process.arch]), publish: 'never', config: 'electron-builder.config.cjs' });
console.log(JSON.stringify({ version: pkg.version, renderer: 'resources/renderer', dependencyPackages: manifest.packages.length, licenseFiles: manifest.files.length }));
