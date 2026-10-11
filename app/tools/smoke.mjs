import { _electron } from 'playwright';
import electron from 'electron';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const appRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = path.resolve(appRoot, '../out/ci/smoke'); await mkdir(out, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), 'multiplane-smoke-'));
const home = path.join(work, 'renderer'), data = path.join(work, 'desktop'), user = path.join(work, 'user');
for (const dir of [home, data, user]) await mkdir(dir);
await writeFile(path.join(data, 'preferences.json'), JSON.stringify({ wizardDone: true, theme: 'dark', notifications: false, hidden: [] }));
const env = { ...process.env, MULTIPLANE_HOME: home, MULTIPLANE_APP_DATA: data, MULTIPLANE_TEST_USER_HOME: user, MULTIPLANE_NO_INDEX: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const args = [appRoot, ...(process.platform === 'linux' && process.env.MULTIPLANE_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])];
const app = await _electron.launch({ executablePath: electron, args, env });
const errors = [], evidence = { platform: process.platform, arch: process.arch, args: args.slice(1), screenshots: [] };
try {
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.documentElement.dataset.platform);
  assert.equal(await page.locator('html').getAttribute('data-platform'), process.platform);
  for (const name of ['作业', '环境', '设置', '关于']) {
    await page.locator(`[data-page="${name}"]`).click();
    if (name === '环境') await page.locator('[data-check=node]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const file = `page-${evidence.screenshots.length + 1}.png`;
    await page.screenshot({ path: path.join(out, file), mask: [page.locator('.path-value'), page.locator('.check-detail'), page.locator('.info-row .mono'), page.locator('[data-host-card] .mono')] });
    evidence.screenshots.push(file);
  }
  const doctor = await page.evaluate(() => window.multiplane.doctor());
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  evidence.doctor = doctor.data.checks.map(({ name, ok }) => ({ name, ok }));
  evidence.menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.role) ?? []);
  assert.equal(evidence.menu.length > 0, process.platform === 'darwin');
  if (process.platform === 'darwin') {
    await page.locator('[data-page="设置"]').click();
    await page.getByRole('button', { name: '在访达中显示' }).waitFor();
    assert.equal(await page.locator('.titlebar > .brand-lockup').evaluate(el => getComputedStyle(el).paddingLeft), '78px');
  }
  assert.deepEqual(errors, []);
} catch (error) { evidence.failure = error.message; throw error; }
finally { await app.close(); await writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); }
console.log(JSON.stringify(evidence));
