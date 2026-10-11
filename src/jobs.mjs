import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { jobDirectory, runCommand } from './events.mjs';
import { MultiplaneError } from './errors.mjs';
import { number } from './capture.mjs';

const resolveJob = (target, options) => path.isAbsolute(target) || /[\\/]/.test(target) ? path.resolve(target) : path.join(jobDirectory(options), target);
export async function readStatus(target, options = {}) {
  let status;
  try { status = JSON.parse(await readFile(path.join(resolveJob(target, options), 'status.json'), 'utf8')); }
  catch (cause) { throw new MultiplaneError('job_not_found'); }
  if (!status || status.schema !== 'multiplane/1' || !Number.isSafeInteger(status.pid) || status.pid <= 0
    || !['running', 'succeeded', 'failed', 'cancelled'].includes(status.state)) throw new MultiplaneError('job_not_found');
  if (status.state === 'running') {
    try { process.kill(status.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') {
        // Report a vanished process as failed/internal_error without changing the status file.
        status = { ...status, state: 'failed', result: { schema: 'multiplane/1', type: 'result', command: status.command,
          ts: new Date().toISOString(), ok: false, code: 'internal_error', message: 'Job process exited without a result.',
          artifacts: [], elapsedMs: Math.max(0, Date.now() - Date.parse(status.startedAt)), jobId: status.jobId, data: {} } };
      }
    }
  }
  return status;
}
export const statusJob = (target, options = {}) => runCommand('status', null, options, events => readStatus(target, events.options), false);
export const cancelJob = (target, options = {}) => runCommand('cancel', null, { wait: 30, ...options }, async events => {
  options = events.options;
  const wait = number(options.wait ?? 30, '--wait');
  let status = await readStatus(target, options);
  if (status.state !== 'running') return status;
  await writeFile(path.join(resolveJob(target, options), 'stop'), '');
  const deadline = performance.now() + wait * 1000;
  while (status.state === 'running' && performance.now() < deadline) {
    await setTimeout(100);
    status = await readStatus(target, options);
  }
  if (status.state === 'running') throw new MultiplaneError('cancel_timeout', 'Timed out waiting for job cancellation.', { result: { data: status } });
  return status;
}, false);
