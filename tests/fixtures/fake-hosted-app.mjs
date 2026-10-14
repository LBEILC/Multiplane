import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, rename, stat } from 'node:fs/promises';
import { processCreatedAt } from '../../src/process-identity.mjs';
import { spawnOwned, stopOwned } from '../../app/src/main/owned-process.mjs';

export function launch(file, args, options = {}) {
  const child = spawnOwned(file, args, { ...options, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  done.catch(() => {});
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// Deliberately independent of each waiter. All executors belong to test-owned OS
// scopes, so killing a waiter cannot kill them and teardown never scans PIDs.
export async function fakeApp(home, { mode = 'run', hold = false } = {}) {
  const directory = path.join(home, 'hosted');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(home, 'app.json'), JSON.stringify({ schema: 'multiplane/1', pid: process.pid,
    createdAt: await processCreatedAt(process.pid), acceptsHosted: true, version: 'test' }));
  const requests = [], queue = [], children = [];
  let busy = false, stopped = false, active = false, failure;
  async function poll() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.request.json') || mode === 'ignore') continue;
        const file = path.join(directory, name), request = JSON.parse(await readFile(file, 'utf8'));
        const base = file.slice(0, -'.request.json'.length);
        try { await rename(file, base + '.claimed.json'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        requests.push(request);
        if (mode === 'crash') continue;
        const pkg = JSON.parse(await readFile(path.join(path.dirname(request.bin), '../package.json')));
        if (mode === 'reject' || pkg.name !== 'multiplane' || !path.isAbsolute(request.node)
          || !/^node(?:\.exe)?$/i.test(path.basename(request.node)) || !(await stat(request.node)).isFile()
          || path.basename(request.jobDir) !== request.jobId || !(await stat(request.jobDir)).isDirectory()) {
          await writeFile(base + '.rejected.tmp', JSON.stringify({ ...request, reason: 'Rejected by the test app.' }));
          await rename(base + '.claimed.json', base + '.rejected.json');
          await rename(base + '.rejected.tmp', base + '.rejected.json');
          continue;
        }
        const statusFile = path.join(request.jobDir, 'status.json');
        const status = JSON.parse(await readFile(statusFile));
        await writeFile(statusFile + '.app.tmp', JSON.stringify({ ...status, state: 'queued', pid: process.pid }));
        await rename(statusFile + '.app.tmp', statusFile);
        queue.push(request);
      }
      for (let i = queue.length - 1; i >= 0; i--) {
        const request = queue[i];
        let cancel = false;
        try { await stat(path.join(request.jobDir, 'stop')); cancel = true; } catch {}
        if (!cancel) continue;
        queue.splice(i, 1);
        const result = { schema: 'multiplane/1', type: 'result', command: request.command, ts: new Date().toISOString(),
          jobId: request.jobId, ok: false, code: 'cancelled', message: 'Job was cancelled.', artifacts: [], elapsedMs: 0, data: {} };
        await writeFile(path.join(request.jobDir, 'events.jsonl'), JSON.stringify(result) + '\n');
        const file = path.join(request.jobDir, 'status.json'), status = JSON.parse(await readFile(file));
        await writeFile(file + '.app.tmp', JSON.stringify({ ...status, state: 'cancelled', result }));
        await rename(file + '.app.tmp', file);
      }
      if (!active && !hold && queue.length) {
        active = true;
        const request = queue.shift();
        const executor = launch(request.node, [request.bin, request.command, ...request.args,
          '--job-dir-exact', request.jobDir, '--hosted-executor'], { cwd: request.cwd, env: request.env });
        children.push(executor);
        executor.done.finally(() => { active = false; }).catch(error => { failure = error; });
      }
    } catch (error) { failure = error; }
    finally { busy = false; }
  }
  const timer = setInterval(poll, 25);
  return { requests, children, release() { hold = false; }, check() { if (failure) throw failure; },
    async close() {
      stopped = true; clearInterval(timer);
      while (busy) await new Promise(resolve => setTimeout(resolve, 10));
      await Promise.all(children.map(item => stopOwned(item.child)));
      if (failure) throw failure;
    } };
}
