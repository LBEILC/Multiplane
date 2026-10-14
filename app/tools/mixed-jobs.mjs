import path from 'node:path';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';

// Synthetic historical data only; reusable by unit and packaged verification.
export async function seedMixedJobs(home, directory, { externalDirectory = path.join(directory, 'external-project') } = {}) {
  const schema = 'multiplane/1', timestamp = '2025-01-02T03:04:05.000Z';
  await mkdir(home, { recursive: true });
  const records = [];
  for (const [jobId, fields, jobDir] of [
    ['missing-fields', { result: { artifacts: [null, { path: 17 }, { path: 'unused', kind: 'unknown' }] } }, path.join(directory, 'partial')],
    ['legacy', { command: 'render', startedAt: timestamp, updatedAt: timestamp, result: { artifacts: [], elapsedMs: 100 } }, path.join(directory, 'legacy')],
    ['external', { command: 'stills', startedAt: timestamp, updatedAt: timestamp }, externalDirectory],
    ['invalid-status', { shot: null }, path.join(directory, 'invalid')]
  ]) {
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({ schema, jobId, shot: path.join(jobDir, 'shot.html'), state: 'succeeded', ...fields }));
    await writeFile(path.join(jobDir, 'events.jsonl'), JSON.stringify({ schema, type: 'start', version: '0.1.0', options: {} }) + '\nnull\n{broken\n');
    records.push({ schema, jobId, jobDir });
  }
  records.push({ schema, jobId: 'deleted', jobDir: path.join(directory, 'deleted') });
  await appendFile(path.join(home, 'jobs.jsonl'), records.map(JSON.stringify).join('\n') + '\n{broken\n');
  return ['missing-fields', 'legacy', 'external'];
}
