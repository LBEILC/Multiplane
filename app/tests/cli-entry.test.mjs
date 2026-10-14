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

for (const platform of ['darwin', 'linux']) test(`${platform} shell entry forwards real argv, stdin and exit status through a runtime fixture`, async t => {
  const shell = process.platform === 'win32' ? await findCommand('bash') : '/bin/sh';
  if (!shell) { t.skip('No POSIX shell available'); return; }
  const root = createTempDirectory('multiplane-shell-'); t.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, 'install space'), resources = platform === 'darwin' ? path.join(install, 'Multiplane.app/Contents/Resources') : path.join(install, 'resources');
  const runtime = platform === 'darwin' ? path.join(resources, '../MacOS/Multiplane') : path.join(install, 'multiplane-desktop');
  await mkdir(path.dirname(runtime), { recursive: true });
  await writeFile(runtime, '#!/bin/sh\nprintf \'%s\\0\' "${ELECTRON_RUN_AS_NODE-}" "$@"\ncat\nexit 7\n', { mode: 0o755 });
  await writeLauncher(platform, install, resources);
  const entry = platform === 'darwin' ? path.join(resources, 'bin/multiplane') : path.join(install, 'multiplane-desktop');
  const args = ['two words', 'embedded"quote', '路径/镜头', ''];
  const child = spawn(shell, [entry.replaceAll('\\', '/'), ...(platform === 'linux' ? ['--multiplane-cli'] : []), ...args], { windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end('stdin payload'); assert.equal(await done, 7, stderr);
  const parts = stdout.split('\0');
  assert.equal(parts[0], '1'); assert.match(parts[1], /\/renderer\/bin\/multiplane$/);
  assert.deepEqual(parts.slice(2), [...args, 'stdin payload']);
});
