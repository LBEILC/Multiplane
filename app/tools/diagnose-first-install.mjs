import { launchOwned } from './owned-electron.mjs';
import { mkdir, mkdtemp, writeFile, readFile, readdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { run } from '../../tools/process.mjs';
import { seedFirstInstallJobs, completeFirstInstall } from './first-install-flow.mjs';
import { fileSnapshot } from './file-snapshot.mjs';
import { isolateDevelopmentHome } from '../../tools/development-home.mjs';
import { findCommand } from '../src/main/settings.mjs';

isolateDevelopmentHome('037b');

const root = fileURLToPath(new URL('../../', import.meta.url));
const [executable, ffmpeg, mode = 'single', ffmpegState = 'missing'] = process.argv.slice(2);
assert.ok(executable && ffmpeg, 'Usage: node tools/diagnose-first-install.mjs <executable> <ffmpeg> [single|multi|lock] [missing|available]');
assert.ok(['single', 'multi', 'lock'].includes(mode));
assert.ok(['missing', 'available'].includes(ffmpegState));
// Doctor preserves a bare command name when FFmpeg came from PATH (as on CI).
const ffmpegFile = path.isAbsolute(ffmpeg) || /[\\/]/.test(ffmpeg) ? path.resolve(ffmpeg) : await findCommand(path.parse(ffmpeg).name);
assert.ok(ffmpegFile && existsSync(ffmpegFile), 'The doctor FFmpeg executable must resolve to an existing file');
const installation = path.dirname(path.resolve(executable));
const before = await fileSnapshot(installation);
const out = path.join(root, 'out/037b'); await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(out, `${mode}-${ffmpegState}-`));
const roaming = path.join(work, 'roaming'), user = path.join(work, 'user'), home = path.join(user, '.multiplane'), legacyHome = path.join(roaming, 'multiplane');
for (const dir of [home, user, path.join(work, 'local'), path.join(user, 'AppData/Roaming'), path.join(user, 'AppData/Local'), path.join(user, '.claude'), path.join(user, '.codex')]) await mkdir(dir, { recursive: true });
const expected = await seedFirstInstallJobs(legacyHome, path.join(work, 'jobs'));
// The parent uses the shared isolation entry point. Children deliberately use
// the platform default inside the fake profile to exercise home migration.
const env = { ...process.env, APPDATA: roaming, LOCALAPPDATA: path.join(work, 'local'), HOME: user, USERPROFILE: user, MULTIPLANE_TEST_USER_HOME: user, PLAYWRIGHT_BROWSERS_PATH: path.join(work, 'browsers') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'MULTIPLANE_HOME', 'MULTIPLANE_APP_DATA', 'MULTIPLANE_FFMPEG', 'MULTIPLANE_NO_INDEX', 'MULTIPLANE_JOBS_DIR']) delete env[key];
// Normalize Windows' case-insensitive PATH before changing only the child environment.
const pathKeys = Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort();
const inheritedPath = env[pathKeys[0]] ?? '';
for (const key of pathKeys) delete env[key];
const cleanPath = inheritedPath.split(path.delimiter).filter(directory => directory && !existsSync(path.join(directory.replace(/^"|"$/g, ''), 'ffmpeg.exe')));
assert.equal(path.basename(ffmpegFile).toLowerCase(), 'ffmpeg.exe', 'PATH regression requires the real ffmpeg.exe');
env.PATH = [...(ffmpegState === 'available' ? [path.dirname(ffmpegFile)] : []), ...cleanPath].join(path.delimiter);
// Reuse an isolated verification cache only; never inspect the user's browser cache.
const cache = process.env.MULTIPLANE_DIAGNOSTIC_BROWSER_CACHE;
if (cache) await cp(cache, env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true });
const apps = [], evidence = { mode, ffmpegState, expected, work, executable: path.resolve(executable), phases: [], errors: [] };
try {
  console.log(`First-install FFmpeg scenario: ${ffmpegState}`);
  const launch = async () => {
    const app = await launchOwned(path.resolve(executable), env, owned => { apps.push(owned); console.log('owned PID', owned.pid); });
    const page = app.page; page.setDefaultTimeout(30000);
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.locator('.wizard').waitFor();
    return { app, page };
  };
  let { app, page } = await launch();
  const firstPage = page;
  if (mode === 'multi') ({ app, page } = await launch());
  evidence.desktop = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(evidence.desktop.startsWith(work + path.sep), 'Desktop preferences must stay isolated');
  if (mode === 'lock') {
    await run(path.resolve(executable), [], { env, capture: true, timeout: 15000, killTree: true });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    evidence.lock = true;
  }
  await app.evaluate(({ Notification, BrowserWindow }) => {
    globalThis.observed = { notifications: [], pushes: [] };
    const show = Notification.prototype.show;
    Notification.prototype.show = function () { globalThis.observed.notifications.push({ title: this.title, body: this.body }); return show.call(this); };
    const contents = BrowserWindow.getAllWindows()[0].webContents, send = contents.send.bind(contents);
    contents.send = (channel, ...args) => { if (channel === 'snapshot') globalThis.observed.pushes.push({ count: args[0].jobs.length, at: Date.now() }); return send(channel, ...args); };
  });
  const observe = async phase => {
    const value = await page.evaluate(async () => ({ snapshot: (await window.multiplane.snapshot()).jobs.map(j => j.jobId), rows: Array.from(document.querySelectorAll('[data-job]'), e => e.dataset.job), heading: document.querySelector('#heading').textContent, error: document.querySelector('#error').textContent, own: (await window.multiplane.settings()).own }));
    evidence.phases.push({ phase, ...value }); console.log(phase, value.snapshot.length, value.rows.length);
  };
  await observe('wizard');
  evidence.wizard = await completeFirstInstall(page, ffmpegFile, ffmpegState === 'available');
  await observe('after-wizard');
  const project = path.join(work, 'project'); await mkdir(project);
  await cp(path.join(root, 'examples/animation.html'), path.join(project, 'animation.html'));
  const renderer = path.join(path.dirname(path.resolve(executable)), 'resources/renderer');
  const rendered = await run(path.resolve(executable), [path.join(renderer, 'bin/multiplane'), 'render', path.join(project, 'animation.html'), '--root', project, '--job-dir', path.join(project, 'jobs'), '--workers', '1', '--to', '0.5', '--json'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: project, capture: true, killTree: true });
  evidence.result = rendered.stdout.trim().split('\n').map(JSON.parse).at(-1);
  await page.waitForTimeout(5000);
  await observe('after-cli');
  evidence.observed = await app.evaluate(() => globalThis.observed);
  evidence.index = (await readFile(path.join(home, 'jobs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.jobId === evidence.result.jobId);
  evidence.skills = await page.evaluate(() => window.multiplane.environment());
  if (mode === 'lock') {
    evidence.log = (await readFile(path.join(evidence.desktop, 'logs/desktop.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(evidence.log.some(row => row.scope === 'snapshot-request' && JSON.parse(row.message).wizardDone === false && JSON.parse(row.message).visible === 9));
    assert.ok(evidence.log.some(row => row.scope === 'wizard' && JSON.parse(row.message).done && JSON.parse(row.message).visible === 9));
    assert.equal(evidence.log.filter(row => row.scope === 'job-finished' && row.message === evidence.result.jobId).length, 1);
  }
  assert.equal(evidence.result.ok, true);
  assert.deepEqual(evidence.errors, []);
  for (const phase of evidence.phases) assert.equal(phase.snapshot.length, phase.phase === 'after-cli' ? 10 : 9);
  assert.equal(evidence.phases[1].rows.length, 9);
  assert.equal(evidence.phases[2].rows.length, 10);
  assert.equal(evidence.observed.notifications.length, 1);
  assert.ok(evidence.observed.pushes.some(push => push.count === 9));
  assert.ok(evidence.observed.pushes.filter(push => push.count === 10).length >= 2, 'Live pushes continue across polling intervals');
  assert.deepEqual(evidence.index.map(row => row.event), ['start', 'end']);
  assert.ok(evidence.skills.skills.every(skill => skill.state === 'latest' && skill.target.startsWith(user)));
  if (mode === 'multi') {
    evidence.firstInstanceStillInWizard = await firstPage.evaluate(() => document.querySelector('.wizard') !== null);
    assert.equal(evidence.firstInstanceStillInWizard, true);
  }
  console.log(JSON.stringify({ work, wizard: evidence.wizard, phases: evidence.phases, notifications: evidence.observed.notifications, result: evidence.result.ok }, null, 2));
} catch (error) { evidence.failure = error.stack; evidence.processes = apps.map(app => app.diagnostics()); throw error; }
finally {
  evidence.cleanup = await Promise.allSettled(apps.reverse().map(app => app.close()));
  evidence.pids = apps.map(app => app.pid);
  evidence.installationUnchanged = JSON.stringify(await fileSnapshot(installation)) === JSON.stringify(before);
  // The browser copy is reproducible and never outlives a run. A passing run keeps
  // only evidence.json; a failing one also keeps its simulated profile, jobs and logs.
  evidence.workKept = Boolean(evidence.failure) || !evidence.installationUnchanged || evidence.cleanup.some(result => result.status !== 'fulfilled');
  for (const name of evidence.workKept ? ['browsers'] : await readdir(work)) {
    await rm(path.join(work, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.warn(`Could not remove ${path.join(work, name)}: ${error.code || error.message}`));
  }
  await writeFile(path.join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.ok(evidence.cleanup.every(result => result.status === 'fulfilled'), 'Every diagnostic process tree must be terminated');
  assert.equal(evidence.installationUnchanged, true);
}
