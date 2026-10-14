import copy from '../src/shared/copy/en.mjs';
import { nativeRealpath } from '../../tools/native-realpath.mjs';
import { _electron } from 'playwright';
import { ensureElectron } from './electron.mjs';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { captureWindow, checkWindowControls, ensureWindowManager } from './window-smoke.mjs';
import { checkEnvironmentIsolation } from './environment-smoke.mjs';
import { captureFailure, privacyMasks } from './smoke-diagnostics.mjs';
import { stopOwned } from '../src/main/owned-process.mjs';

const appRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = path.resolve(appRoot, '../out/ci/smoke'); await mkdir(out, { recursive: true });
// Do not let a previous successful capture masquerade as evidence for a failed run.
await rm(path.join(out, 'window.png'), { force: true });
await rm(path.join(out, 'failure.png'), { force: true });
const work = await nativeRealpath(await mkdtemp(path.join(out, 'work-')));
const home = path.join(work, 'renderer'), data = path.join(work, 'desktop'), user = path.join(work, 'user');
const realUser = path.join(work, 'real-user');
for (const dir of [home, data, realUser]) await mkdir(dir);
await symlink(realUser, user, process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ language: 'en', wizardDone: true, theme: 'dark', notifications: false, hidden: [] }));
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user, MULTIPLANE_NO_INDEX: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const args = [appRoot, ...(process.platform === 'linux' && process.env.MULTIPLANE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])];
let app, page, windowManager;
const errors = [], evidence = { platform: process.platform, arch: process.arch, args: args.slice(1), screenshots: [], wholeWindow: { status: 'not-attempted', reason: 'Smoke stopped before native capture' }, windowControls: { status: 'not-attempted', reason: 'Smoke stopped before window-control checks' } };
try {
  windowManager = await ensureWindowManager(evidence);
  app = await _electron.launch({ executablePath: await ensureElectron(), args, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.documentElement.dataset.platform);
  assert.equal(await page.locator('html').getAttribute('data-platform'), process.platform);
  for (const name of ['jobs', 'environment', 'settings', 'about']) {
    await page.locator(`[data-page="${name}"]`).click();
    if (name === 'environment') await page.locator('[data-check=node]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const file = `page-${evidence.screenshots.length + 1}.png`;
    await page.screenshot({ path: path.join(out, file), mask: privacyMasks(page) });
    evidence.screenshots.push(file);
  }
  // Native captures cannot use Playwright masks. This isolated, empty jobs page has no local paths.
  await page.locator('[data-page="jobs"]').click();
  await page.evaluate(() => document.fonts.ready);
  await captureWindow(app, out, evidence);
  const doctor = await page.evaluate(() => window.multiplane.doctor());
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  evidence.doctor = doctor.data.checks.map(({ name, ok }) => ({ name, ok }));
  evidence.menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.role) ?? []);
  assert.equal(evidence.menu.length > 0, process.platform === 'darwin');
  if (process.platform === 'darwin') {
    await page.locator('[data-page="settings"]').click();
    await page.getByRole('button', { name: copy.revealFinder }).waitFor();
    assert.equal(await page.locator('.titlebar > .brand-lockup').evaluate(el => getComputedStyle(el).paddingLeft), '78px');
  }
  await checkEnvironmentIsolation(app, page, user, work, out, evidence, doctor);
  assert.deepEqual(errors, []);
  await checkWindowControls(app, page, work, out, evidence);
} catch (error) {
  evidence.failure = await captureFailure(page, out, error);
  if (evidence.failure.screenshot) evidence.screenshots.push(evidence.failure.screenshot);
  throw error;
}
finally {
  try { await app?.close(); } catch (error) { evidence.cleanup = error.message; }
  if (windowManager) await stopOwned(windowManager);
  // A passing run leaves nothing to inspect in its simulated profile; a failing one keeps it.
  if (!evidence.failure) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => console.warn(`Could not remove ${work}: ${error.code || error.message}`));
  await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
