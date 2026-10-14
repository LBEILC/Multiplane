import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Complete historical records keep this regression independent of malformed-job handling.
export async function seedFirstInstallJobs(home, directory) {
  const schema = 'multiplane/1', ts = '2025-01-02T03:04:05.000Z', records = [];
  await mkdir(home, { recursive: true });
  for (let i = 0; i < 9; i++) {
    const jobId = `historical-${i}`, jobDir = path.join(directory, jobId), shot = path.join(jobDir, 'shot.html');
    const command = ['render', 'stills', 'verify'][i % 3], state = ['succeeded', 'failed', 'cancelled'][i % 3];
    const result = { schema, type: 'result', command, ts, jobId, ok: state === 'succeeded', code: state === 'succeeded' ? 'ok' : state === 'cancelled' ? 'cancelled' : 'internal_error', artifacts: [], data: {}, elapsedMs: 100 };
    await mkdir(jobDir, { recursive: true });
    await writeFile(shot, '<!doctype html><div id="stage"></div><script>window.render = t => {};</script>');
    const start = { schema, type: 'start', command, ts, jobId, options: { root: directory } };
    await writeFile(path.join(jobDir, 'events.jsonl'), [start, result].map(JSON.stringify).join('\n') + '\n');
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ schema, jobId, shot, command, state, pid: 1, phase: 'finalize', done: 1, total: 1, fps: 0, etaMs: 0, previewFrame: null, memoryBytes: 0, startedAt: ts, updatedAt: ts, result }));
    records.push({ schema, event: 'start', jobId, jobDir, shot, command, pid: 1, ts }, { schema, event: 'end', jobId, jobDir, state, ts });
  }
  await writeFile(path.join(home, 'jobs.1.jsonl'), records.slice(0, 8).map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(home, 'jobs.jsonl'), records.slice(8).map(JSON.stringify).join('\n') + '\n');
  return Array.from({ length: 9 }, (_, i) => `historical-${i}`);
}

export async function completeFirstInstall(page, ffmpeg, ffmpegAvailable = false) {
  await page.locator('.wizard').waitFor();
  await page.locator('[data-pref=next]:not([disabled])').waitFor();
  assert.equal(await page.locator('.wizard-steps > span.active').evaluate(el => Array.from(el.parentElement.children).indexOf(el)), 0);
  const doctor = await page.evaluate(() => window.multiplane.doctor());
  assert.equal(doctor.data.checks.find(check => check.name === 'ffmpeg')?.ok, ffmpegAvailable, 'Controlled FFmpeg availability must match the wizard scenario');
  await page.locator('[data-pref=next]').click();
  if (!ffmpegAvailable) {
    await page.locator('#input-ffmpeg').fill(ffmpeg);
    assert.equal(await page.locator('.wizard-steps > span.active').evaluate(el => Array.from(el.parentElement.children).indexOf(el)), 1);
    await page.locator('#input-ffmpeg').press('Enter');
    await page.locator('[data-pref=next]:not([disabled])').waitFor();
    const settings = await page.evaluate(() => window.multiplane.settings());
    assert.equal(settings.values.ffmpeg, ffmpeg, 'Manual FFmpeg path must be persisted');
    assert.match(await page.locator('.ffmpeg-feedback .mono').innerText(), /^ffmpeg version\s/i, 'The saved path must have successful FFmpeg feedback');
    await page.locator('[data-pref=next]').click();
  }
  await page.locator('input[data-host=claude]').waitFor();
  assert.equal(await page.locator('.wizard-steps > span.active').evaluate(el => Array.from(el.parentElement.children).indexOf(el)), 2);
  assert.equal(await page.locator('#input-ffmpeg').count(), 0);
  if (ffmpegAvailable) assert.ok(!(await page.evaluate(() => window.multiplane.settings())).values.ffmpeg, 'Skipped step must not save an explicit FFmpeg path');
  for (const host of ['claude', 'codex']) await page.locator(`input[data-host=${host}]`).check();
  await page.locator('[data-pref=next]').click();
  await page.locator('[data-pref=hosted]').waitFor();
  assert.equal(await page.locator('[data-pref=hosted]').getAttribute('aria-checked'), 'false');
  await page.locator('[data-pref=next]').click();
  await page.locator('#jobs').waitFor();
  return { ffmpegAvailable, steps: ffmpegAvailable ? [1, 3, 4] : [1, 2, 3, 4], manualPathSaved: !ffmpegAvailable };
}
