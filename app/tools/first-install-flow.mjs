import path from 'node:path';
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

export async function completeFirstInstall(page, ffmpeg) {
  await page.locator('.wizard').waitFor();
  await page.locator('[data-pref=next]:not([disabled])').waitFor();
  await page.locator('[data-pref=next]').click();
  await page.locator('#input-ffmpeg').fill(ffmpeg);
  await page.locator('#input-ffmpeg').press('Enter');
  await page.locator('[data-pref=next]:not([disabled])').waitFor();
  await page.locator('[data-pref=next]').click();
  for (const host of ['claude', 'codex']) await page.locator(`input[data-host=${host}]`).check();
  await page.locator('[data-pref=next]').click();
  await page.locator('#jobs').waitFor();
}
