import path from 'node:path';
import { mkdir, readFile, writeFile, rename, open, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { userHome } from './platform.mjs';
import { processCreatedAt } from './process-identity.mjs';
import { errorCodes, MultiplaneError } from './errors.mjs';

const schema = 'multiplane/1';
export const hostedBase = (jobId, home = userHome()) => path.join(home, 'hosted', jobId);
async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function exists(file) { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function move(from, to) {
  try { await rename(from, to); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function hostedAvailable(command, options, env = process.env) {
  if (!['render', 'stills', 'verify'].includes(command) || !options._hostedCLI || options.hosted !== true
    || options['no-hosted'] || options['hosted-executor'] || env.MULTIPLANE_HOSTED === '0') return false;
  try {
    const app = await json(path.join(userHome(env), 'app.json'));
    return app?.schema === schema && app.acceptsHosted === true && typeof app.version === 'string'
      && typeof app.createdAt === 'string' && app.createdAt === await processCreatedAt(app.pid);
  } catch { return false; }
}

export function hostedEnvironment(env) {
  const allowed = /^(PATH|MULTIPLANE_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|ComSpec|PATHEXT|LANG|LC_.*)$/i;
  const secret = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY/i;
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => {
    if (value === undefined || !allowed.test(key) || secret.test(key)) return false;
    // Do not persist proxy passwords or tokens carried in proxy URLs.
    if (/PROXY$/i.test(key) && !/^NO_PROXY$/i.test(key)) {
      try { const url = new URL(value); if (url.username || url.password || url.search || url.hash) return false; }
      catch { return false; }
    }
    return true;
  }));
}

export async function handoff(request, { home = userHome(), timeout = 5000, startTimeout = 15000,
  interval = 100, announce = message => process.stderr.write(message + '\n') } = {}) {
  const base = hostedBase(request.jobId, home);
  try {
    await mkdir(path.dirname(base), { recursive: true });
    await writeFile(base + '.tmp', JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(base + '.tmp', base + '.request.json');
  } catch {
    await unlink(base + '.tmp').catch(() => {});
    return { reason: 'The hosted request could not be published.' };
  }
  const deadline = performance.now() + timeout;
  let accepted = false, startDeadline = Infinity;
  for (;;) {
    if (await exists(base + '.rejected.json')) {
      const rejected = await json(base + '.rejected.json');
      return { reason: typeof rejected?.reason === 'string' ? rejected.reason : 'The app rejected the request.' };
    }
    const running = await exists(base + '.running.json');
    const claimed = await exists(base + '.claimed.json');
    const status = await json(path.join(request.jobDir, 'status.json'));
    const queued = status?.state === 'queued';
    if (!accepted && (claimed || running || status?.result)) {
      accepted = true; startDeadline = performance.now() + startTimeout;
    }
    if (running || status?.result || (accepted && queued)) {
      announce('Job ' + request.jobId + ' has been handed to Multiplane'
        + (queued ? (Number.isSafeInteger(status.queuePosition) && status.queuePosition > 0 ? ' (queued; #' + status.queuePosition + ')' : ' (queued; position unavailable)') : '') + '. Closing this session will not interrupt it.');
      return { hosted: true };
    }
    if (accepted && performance.now() >= startDeadline && status?.state !== 'queued') {
      if (await move(base + '.claimed.json', base + '.withdrawn.json')) return { reason: 'The app did not start the job within 15 seconds.' };
    }
    if (!accepted && performance.now() >= deadline) {
      if (await move(base + '.request.json', base + '.withdrawn.json')) return { reason: 'The app did not claim the job within 5 seconds.' };
    }
    await delay(interval);
  }
}

// Claim before loading config, creating status, linting or opening output files.
export async function claimExecutor(jobDir, command) {
  try {
    if (!path.isAbsolute(jobDir) || !['render', 'stills', 'verify'].includes(command)) return false;
    const jobId = path.basename(jobDir), base = hostedBase(jobId);
    const request = await json(base + '.claimed.json');
    if (request?.schema !== schema || request.jobId !== jobId || request.command !== command
      || path.resolve(request.jobDir ?? '') !== path.resolve(jobDir)) return false;
    return await move(base + '.claimed.json', base + '.running.json');
  } catch { return false; }
}

export const resultExitCode = result => result.ok ? 0 : errorCodes[result.code]?.exitCode ?? 4;

// Keep bytes intact across partial writes and UTF-8 boundaries. Only complete lines
// are published, so timeout diagnostics cannot splice into a partial JSON record.
export async function followJob(directory, { timeout = Infinity, onBytes, onEvent, interval = 100 } = {}) {
  const deadline = performance.now() + timeout * 1000;
  let offset = 0, pending = Buffer.alloc(0);
  for (;;) {
    let handle;
    try {
      handle = await open(path.join(directory, 'events.jsonl'), 'r');
      for (;;) {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, end + 1); pending = pending.subarray(end + 1);
          const event = JSON.parse(line.toString('utf8'));
          await onBytes?.(line); onEvent?.(event);
          if (event.type === 'result') return event;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
    const status = await json(path.join(directory, 'status.json'));
    if (status?.schema !== schema || !Number.isSafeInteger(status.pid) || status.pid <= 0
      || typeof status.state !== 'string') throw new MultiplaneError('job_not_found');
    // A result is committed to the event log before status; read the next poll.
    if (!status.result && status.state === 'running') {
      try { process.kill(status.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') throw new MultiplaneError('internal_error', 'Job process exited without a result.'); }
    }
    if (performance.now() >= deadline) throw new MultiplaneError('wait_timeout');
    await delay(interval);
  }
}
