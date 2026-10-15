import { _electron } from 'playwright';
import { spawnOwned, stopOwned } from '../src/main/owned-process.mjs';
import { processIdentity } from '../src/main/process-identity.mjs';
import { privacyMasks } from './smoke-diagnostics.mjs';
import { json } from '../src/main/hosted.mjs';
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureLocalFfmpeg } from '../../tests/local-ffmpeg.mjs';
import { entryCommand } from './entry-command.mjs';
import { run } from '../../tools/process.mjs';

// The hosted executor encodes video, so it needs FFmpeg like the tests do.
ensureLocalFfmpeg();

const root = fileURLToPath(new URL('../../', import.meta.url));
const unpacked = path.resolve(process.argv[2] ?? path.join(root, 'app/release/win-unpacked'));
const executable = process.platform === 'win32' ? path.join(unpacked, 'Multiplane.exe') : process.platform === 'darwin' ? path.join(unpacked, 'Multiplane.app/Contents/MacOS/Multiplane') : path.join(unpacked, 'multiplane-runtime');
const resources = process.platform === 'darwin' ? path.join(unpacked, 'Multiplane.app/Contents/Resources') : path.join(unpacked, 'resources');
const out = path.join(root, 'out/070'); await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, 'packaged-'));
const home = path.join(work, 'renderer-home'), data = path.join(work, 'desktop-home');
await mkdir(home); await mkdir(data);
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ wizardDone: true, language: 'zh-CN', theme: 'light', notifications: false, autoCheckUpdates: false }));
const shot = path.join(work, 'sample.html');
await writeFile(shot, '<div id="stage" style="width:320px;height:180px;background:#ddd"><div id="box" style="width:40px;height:40px;background:#333"></div></div><script>window.SHOT={duration:4,fps:24,async render(t){document.getElementById("box").style.transform=`translateX(${t*40}px)`;await new Promise(resolve=>setTimeout(resolve,80));}}</script>');
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: work };
delete env.ELECTRON_RUN_AS_NODE; delete env.MULTIPLANE_NO_INDEX; delete env.MULTIPLANE_JOBS_DIR;
let desktop, terminal, desktopIdentity, desktopChild; let desktopLog = '';
const evidence = { packaged: false, handedOff: false, terminalEnded: false, completed: false };
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (desktopChild && desktopChild.exitCode !== null) throw Error('Packaged app exited: ' + desktopLog); const value = await fn(); if (value) return value; await delay(100); }
  throw Error('Hosted verification timed out.');
}
try {
  desktop = await _electron.launch({ executablePath: executable, args: [], env, timeout: 30000 });
  desktopChild = desktop.process(); desktopIdentity = await processIdentity(desktopChild.pid);
  desktopChild.stderr.on('data', bytes => { desktopLog = (desktopLog + bytes).slice(-12000); });
  desktopChild.on('exit', (code, signal) => console.log('Packaged app exit:', code, signal, desktopLog));
  console.log('Packaged app launched.');
  const page = await desktop.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(30000); await page.locator('[data-page=settings]').click();
  console.log('Settings ready.');
  evidence.packaged = await desktop.evaluate(({ app }) => app.isPackaged); assert.equal(evidence.packaged, true);
  await page.locator('[data-pref=hosted]').click(); await until(async () => (await json(path.join(home, 'app.json')))?.acceptsHosted);
  await page.locator('[data-pref=hosted][aria-checked=true]:not([disabled])').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, 'packaged-settings.png'), mask: privacyMasks(page), maskColor: '#e8e7e4' });
  const bin = path.join(resources, 'renderer/bin/multiplane');
  const entry = process.platform === 'win32' ? { path: path.join(unpacked, 'multiplane.cmd'), args: [] }
    : process.platform === 'darwin' ? { path: path.join(resources, 'bin/multiplane'), args: [] }
      : { path: path.join(unpacked, 'multiplane-desktop'), args: ['--multiplane-cli'] };
  const command = entryCommand(entry, ['render', shot, '--workers', '1', '--raster', 'software', '--no-lint', '--no-post', '--json']);
  // The terminal and waiter share an owned Job Object/process group.
  // The app's executor must remain outside it.
  let stderr = '';
  terminal = spawnOwned(command.file, command.args, { ...command.options, cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  terminal.stdout.on('data', () => {}); terminal.stderr.on('data', bytes => { stderr += bytes; });
  await until(() => {
    if (stderr.includes('Rendering locally:') || terminal.exitCode !== null) throw Error('Bundled entry did not hand off: ' + stderr);
    return stderr.includes('has been handed to Multiplane');
  });
  evidence.handedOff = true;
  const request = await until(async () => { const name = (await readdir(path.join(home, 'hosted'))).find(name => name.endsWith('.running.json')); return name && json(path.join(home, 'hosted', name)); });
  assert.equal(request.node, executable); assert.equal(request.bin, bin);
  assert.equal(request.env.ELECTRON_RUN_AS_NODE, '1'); evidence.bundledEntry = true;
  await until(async () => (await json(path.join(request.jobDir, 'status.json')))?.phase === 'capture');
  const before = await json(path.join(request.jobDir, 'status.json'));
  const identity = await processIdentity(before.pid); assert.ok(identity);
  await stopOwned(terminal); evidence.terminalEnded = true; terminal = null;
  assert.equal((await processIdentity(before.pid))?.createdAt, identity.createdAt);
  const waitCommand = entryCommand(entry, ['wait', request.jobDir, '--json', '--timeout', '120']);
  const waited = run(waitCommand.file, waitCommand.args, { ...waitCommand.options, cwd: work, env, capture: true, timeout: 130000 });
  // Attach immediately while UI evidence is captured.
  waited.catch(() => {});
  await page.locator('[data-page=jobs]').click();
  await page.locator(`[data-job="${request.jobId}"]`).click();
  await page.screenshot({ path: path.join(out, 'packaged-job.png') });
  const result = await until(async () => (await json(path.join(request.jobDir, 'status.json')))?.result, 120000);
  assert.equal(result.ok, true, JSON.stringify(result)); evidence.completed = true;
  const resumed = await waited;
  const final = JSON.parse(resumed.stdout.trim().split('\n').at(-1));
  assert.equal(final.ok, true); assert.equal(final.jobId, request.jobId); evidence.waitReconnected = true;
  evidence.artifacts = result.artifacts.map(a => ({ kind: a.kind, bytes: a.bytes }));
  await desktop.close(); desktop = null;
  assert.equal(await json(path.join(home, 'app.json')), null);
  evidence.presenceWithdrawn = true;
  console.log(JSON.stringify(evidence));
} finally {
  if (terminal) await stopOwned(terminal);
  if (desktop && desktopChild?.exitCode === null) {
    const deadline = setTimeout(async () => {
      // Only the directly launched app, with its recorded creation time.
      if (desktopIdentity && (await processIdentity(desktopChild.pid))?.createdAt === desktopIdentity.createdAt) desktopChild.kill();
    }, 10000);
    try { await desktop.close(); } finally { clearTimeout(deadline); }
  }
  await writeFile(path.join(out, 'packaged-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
