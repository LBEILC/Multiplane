import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { cliEntry, copyableCommand } from '../src/main/cli-entry.mjs';
import { launcherText, writeLauncher } from '../tools/cli-launcher.mjs';
import { entryCommand } from '../tools/entry-command.mjs';
import { createTempDirectory } from './helpers.mjs';
import { findCommand } from '../src/main/settings.mjs';
import { generateAppRunScript } from 'app-builder-lib/out/targets/appimage/appImageUtil.js';
import { createRequire } from 'node:module';

test('packaging pins the quiet static AppImage runtime instead of the noisy legacy default', () => {
  const require = createRequire(import.meta.url);
  const config = require('../electron-builder.config.cjs');
  const { appimageChecksums } = require('app-builder-lib/out/toolsets/linux.js');
  assert.equal(config.toolsets.appimage, '1.0.3');
  assert.equal(appimageChecksums[config.toolsets.appimage]['appimage-tools-runtime-20251108.tar.gz'], '84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665');
});

test('AppRun CLI emits only version or NDJSON in mounted and extracted environments', async t => {
  const shell = await findCommand('bash');
  assert.ok(shell, 'Bash is required to verify the Linux launcher');
  const root = createTempDirectory('multiplane-stdout-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'multiplane-desktop'), `#!/bin/sh
shift
case "$1" in
  --version) printf '0.3.6\\n';;
  config) printf '%s\\n' '{"type":"result","ok":true,"data":{}}';;
  *) exit 9;;
esac
`, { mode: 0o755 });
  await writeLauncher('linux', root, path.join(root, 'resources'));
  await writeFile(path.join(root, 'AppRun'), generateAppRunScript({ ExecutableName: 'multiplane-desktop' }), { mode: 0o755 });
  await writeFile(path.join(root, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const extracted of [false, true]) for (const args of [['--version'], ['config', 'get', '--json']]) {
    const env = { ...process.env, APPDIR: root.replaceAll('\\', '/'), APPIMAGE: '/download/Multiplane.AppImage', APPIMAGE_EXIT_AFTER_INSTALL: '' };
    delete env.APPIMAGE_EXTRACT_AND_RUN;
    if (extracted) env.APPIMAGE_EXTRACT_AND_RUN = '1';
    const child = spawn(shell, [path.join(root, 'AppRun').replaceAll('\\', '/'), '--multiplane-cli', ...args], { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end();
    assert.equal(await done, 0, stderr);
    assert.equal(stdout, args[0] === '--version' ? '0.3.6\n' : '{"type":"result","ok":true,"data":{}}\n');
  }
});

test('bundled entry paths and copyable commands cover all three platforms', () => {
  assert.deepEqual(cliEntry('win32','C:\\Install space\\Multiplane.exe','unused',{}), { path: 'C:\\Install space\\multiplane.cmd', args: [] });
  assert.deepEqual(cliEntry('darwin','unused','/Applications/Multiplane.app/Contents/Resources',{}), { path: '/Applications/Multiplane.app/Contents/Resources/bin/multiplane', args: [] });
  assert.deepEqual(cliEntry('linux','/mount/multiplane-runtime','unused',{ APPIMAGE: '/download/Multiplane.AppImage' }), { path: '/download/Multiplane.AppImage', args: ['--multiplane-cli'] });
  assert.equal(copyableCommand({ path: '/download/with space.AppImage', args: ['--multiplane-cli'] },'linux'), "'/download/with space.AppImage' --multiplane-cli");
  assert.equal(copyableCommand({ path: '/a\'b', args: [] },'darwin'), "'/a'\\''b'");
  assert.equal(copyableCommand({ path: 'C:\\Install space\\multiplane.cmd', args: [] },'win32'), '"C:\\Install space\\multiplane.cmd"');
});

test('Windows packaged command forwards spaces, quotes, Unicode, stdin, stdout and exit status', { skip: process.platform !== 'win32' }, async t => {
  const root = createTempDirectory('multiplane-entry-'); t.after(() => rm(root,{recursive:true,force:true}));
  const install = path.join(root,'install space 字符'), resources = path.join(install,'resources');
  await mkdir(path.join(resources,'renderer/bin'),{recursive:true});
  // Node exercises the same argument/stdin contract as ELECTRON_RUN_AS_NODE.
  await cp(process.execPath,path.join(install,'Multiplane.exe'));
  await writeFile(path.join(resources,'renderer/bin/multiplane'), "process.stdin.setEncoding('utf8'); let input=''; process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input,node:process.env.ELECTRON_RUN_AS_NODE}));process.exitCode=7;});");
  await writeLauncher('win32',install,resources);
  const args = ['space path/file.html','embedded"quote','路径/镜头.html','','trailing\\'];
  const command = entryCommand(cliEntry('win32',path.join(install,'Multiplane.exe'),resources), args);
  const child = spawn(command.file,command.args,{...command.options,windowsHide:true});
  let stdout='',stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
  const done = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  child.stdin.end('stdin payload\n');
  assert.equal(await done,7,stderr);
  assert.deepEqual(JSON.parse(stdout),{args,input:'stdin payload\n',node:'1'});
});

test('Unix entry scripts use exec and preserve argument boundaries; Linux forwards only after its explicit switch', () => {
  assert.match(launcherText('darwin'), /exec .*"\$@"/);
  const linux=launcherText('linux');
  assert.match(linux, /--multiplane-cli/); assert.match(linux, /shift\n/); assert.match(linux,/renderer\/bin\/multiplane" "\$@"/);
  assert.match(linux,/fi\nexec "\$base\/multiplane-runtime" --no-sandbox "\$@"/);
});

for (const platform of ['darwin', 'linux', 'linux-AppRun']) test(`${platform} shell entry forwards real argv, stdin and exit status through a runtime fixture`, async t => {
  const shell = process.platform === 'win32' || platform === 'linux-AppRun' ? await findCommand('bash') : '/bin/sh';
  if (!shell) { t.skip('No POSIX shell available'); return; }
  const root = createTempDirectory('multiplane-shell-'); t.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, 'install space'), resources = platform === 'darwin' ? path.join(install, 'Multiplane.app/Contents/Resources') : path.join(install, 'resources');
  const runtime = platform === 'darwin' ? path.join(resources, '../MacOS/Multiplane') : path.join(install, 'multiplane-desktop');
  await mkdir(path.dirname(runtime), { recursive: true });
  await writeFile(runtime, '#!/bin/sh\nprintf \'%s\\0\' "${ELECTRON_RUN_AS_NODE-}" "$@"\ncat\nexit 7\n', { mode: 0o755 });
  await writeLauncher(platform === 'darwin' ? platform : 'linux', install, resources);
  let entry = platform === 'darwin' ? path.join(resources, 'bin/multiplane') : path.join(install, 'multiplane-desktop');
  if (platform === 'linux-AppRun') {
    entry = path.join(install, 'AppRun');
    await writeFile(entry, generateAppRunScript({ ExecutableName: 'multiplane-desktop' }), { mode: 0o755 });
    // Force AppRun's real fallback branch on every test host.
    await writeFile(path.join(install, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const args = ['two words', 'embedded"quote', '路径/镜头', ''];
  const child = spawn(shell, [entry.replaceAll('\\', '/'), ...(platform.startsWith('linux') ? ['--multiplane-cli'] : []), ...args], { windowsHide: true,
    env: { ...process.env, APPDIR: install.replaceAll('\\', '/'), APPIMAGE_EXTRACT_AND_RUN: '1', APPIMAGE_EXIT_AFTER_INSTALL: '' } });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end('stdin payload'); assert.equal(await done, 7, stderr);
  const parts = stdout.split('\0');
  assert.equal(parts[0], '1'); assert.match(parts[1], /\/renderer\/bin\/multiplane$/);
  assert.deepEqual(parts.slice(2), [...args, 'stdin payload']);
});
