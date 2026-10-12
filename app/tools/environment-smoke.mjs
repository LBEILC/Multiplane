import copy from '../src/shared/copy/en.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink, unlink, writeFile, rmdir } from 'node:fs/promises';
import { privacyMasks } from './smoke-diagnostics.mjs';

export async function checkEnvironmentIsolation(app, page, user, work, out, evidence, doctor) {
  const refresh = async () => {
    await page.getByRole('button', { name: copy.checkAgain, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-pref=check]')?.disabled);
  };
  await page.locator('[data-page="environment"]').click();
  await page.locator('[data-host-card=codex]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-pref=check]')?.disabled);
  await page.evaluate(() => window.multiplane.skill('codex', 'install'));
  const external = path.join(work, 'linked-skill'), root = path.join(user, '.claude', 'skills'), target = path.join(root, 'multiplane');
  await mkdir(external); await mkdir(root, { recursive: true });
  await symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir');
  await refresh();
  const claude = page.locator('[data-host-card=claude]'), codex = page.locator('[data-host-card=codex]');
  await claude.getByText(copy.modified, { exact: true }).waitFor();
  assert.match(await claude.locator('[role=alert]').innerText(), /symbolic links/);
  assert.equal(await claude.locator('button').count(), 0);
  await codex.getByText(copy.upToDate, { exact: true }).waitFor();
  await page.locator('[data-check=node]').waitFor();
  const screenshot = async name => {
    await page.screenshot({ path: path.join(out, name), fullPage: true, mask: privacyMasks(page) });
    evidence.screenshots.push(name);
  };
  await claude.scrollIntoViewIfNeeded();
  await screenshot('environment-linked-skill.png');
  await unlink(target); await rmdir(root); await writeFile(root, 'not a directory');
  await refresh();
  await claude.getByText(copy.skillReadError, { exact: true }).waitFor();
  await codex.getByText(copy.upToDate, { exact: true }).waitFor();
  await page.locator('[data-check=node]').waitFor();
  assert.equal(await page.locator('.banner').count(), 0);
  await claude.scrollIntoViewIfNeeded();
  await screenshot('environment-agent-error.png');
  const failure = await page.evaluate(() => window.multiplane.skill('claude', 'install').then(() => '', error => error.message));
  assert.match(failure, /not a directory/); assert.doesNotMatch(failure, /Error:|invoking remote/);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('doctor');
    ipcMain.handle('doctor', () => { throw Error('browser_launch_failed'); });
  });
  await refresh();
  await page.getByText(/Cannot run checks: Browser failed to launch/).waitFor();
  await codex.getByText(copy.upToDate, { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#placeholder').innerText(), /Error:|invoking remote/);
  await page.getByText(/Cannot run checks: Browser failed to launch/).scrollIntoViewIfNeeded();
  await screenshot('environment-renderer-error.png');
  await app.evaluate(({ ipcMain }, result) => { ipcMain.removeHandler('doctor'); ipcMain.handle('doctor', () => result); }, doctor);
  evidence.environmentIsolation = { linkedAncestor: true, blockedSkillLink: true, independentAgentFailure: true, independentRendererFailure: true, cleanIpcErrors: true };
  await page.locator('[data-page="jobs"]').click();
}
