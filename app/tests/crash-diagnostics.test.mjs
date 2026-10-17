import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { createTempDirectory } from './helpers.mjs';
import { launchExecutor } from '../src/main/hosted.mjs';
import { launchResume } from '../src/main/resume.mjs';
import { JobStore } from '../src/main/store.mjs';
import { errorTail, retainResumeLog } from '../src/main/diagnostics.mjs';
const schema = 'multiplane/1';
const message = 'fatal native error\nsecond line\n';

test('hosted executor retains stderr from a real nonzero child', async () => {
  const jobDir = createTempDirectory(); let done;
  await launchExecutor({ node: process.execPath, bin: 'unused', command: 'render', args: [], jobDir, cwd: jobDir, env: process.env }, (file, _args, options) => {
    const child = spawn(file, ['-e', `process.stderr.write(${JSON.stringify(message)});process.exitCode=7`], options);
    done = once(child, 'exit'); return child;
  });
  assert.equal((await done)[0], 7);
  assert.equal(await readFile(path.join(jobDir, 'stderr.log'), 'utf8'), message);
});
test('resume retains stderr in the newly indexed job, including late writes', async () => {
  const home = createTempDirectory(), jobDir = path.join(home, 'new-job'); await mkdir(jobDir);
  await writeFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: 'new-job', jobDir }) + '\n');
  const event = { schema, type: 'start', command: 'render', jobId: 'new-job' };
  const events = [];
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(event)+'\n')});process.stderr.write(${JSON.stringify(message.split('\n')[0]+'\n')});setTimeout(()=>{process.stderr.write(${JSON.stringify(message.split('\n')[1]+'\n')});process.exitCode=7},180);`;
  const code = await launchResume('unused', home, 'old', e => events.push(e), { create: (_file, _args, options) => spawn(process.execPath, ['-e', script], options) });
  assert.equal(code, 7); assert.equal(events[0].jobId, 'new-job');
  assert.equal(await readFile(path.join(jobDir, 'stderr.log'), 'utf8'), message);
});
test('store restores resume diagnostics after app exit and projects only the last 20 lines', async t => {
  const home = createTempDirectory(), jobDir = path.join(home, 'job'); await mkdir(jobDir);
  await writeFile(path.join(home, 'jobs.jsonl'), JSON.stringify({ schema, jobId: 'job', jobDir })+'\n');
  await writeFile(path.join(jobDir, 'status.json'), JSON.stringify({schema,jobId:'job',shot:'shot.html',command:'render',state:'running',pid:1,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
  const store = new JobStore(home, { alive: () => false }); t.after(() => store.close());
  await store.refresh(); assert.equal(store.jobs[0].stderr, '');
  const attempt = path.join(home, 'desktop-resume', 'attempt-recovery'); await mkdir(attempt, { recursive: true });
  await writeFile(path.join(attempt,'stdout.jsonl'),JSON.stringify({schema,type:'start',command:'render',jobId:'job'})+'\n');
  const lines = Array.from({length:25},(_,i)=>`error ${i}`);
  await writeFile(path.join(attempt,'stderr.log'),lines.join('\r\n')+'\r\n');
  await store.refresh(); assert.equal(store.jobs[0].stderr, lines.slice(-20).join('\n'));
  assert.equal(await readFile(path.join(jobDir,'stderr.log'),'utf8'),lines.join('\r\n')+'\r\n');
  await appendFile(path.join(jobDir,'stderr.log'),'last');
  assert.equal((await errorTail(path.join(jobDir,'stderr.log'))).split('\n').at(-1),'last');
});

test('resume archive crosses volumes and preserves existing hosted diagnostics', async () => {
  const home = createTempDirectory(), jobDir = createTempDirectory(path.resolve('out-093-job-'));
  const records = new Map([['job', {jobDir}]]);
  const attempt = path.join(home, 'attempt'); await mkdir(attempt);
  await writeFile(path.join(attempt, 'stdout.jsonl'), JSON.stringify({schema,type:'start',command:'render',jobId:'job'})+'\n');
  await writeFile(path.join(attempt, 'stderr.log'), message);
  await retainResumeLog(attempt, records, true);
  assert.equal(await readFile(path.join(jobDir, 'stderr.log'), 'utf8'), message);
  await writeFile(path.join(attempt, 'stderr.log'), 'waiter error\n');
  assert.equal(await retainResumeLog(attempt, records), false);
  assert.equal(await readFile(path.join(jobDir, 'stderr.log'), 'utf8'), message);
  await retainResumeLog(attempt, records, true);
  await retainResumeLog(attempt, records, true);
  assert.equal(await readFile(path.join(jobDir, 'stderr.log'), 'utf8'), message+'waiter error\n');
});
test('diagnostic tail preserves UTF-8, unterminated lines and empty logs', async () => {
  const file = path.join(createTempDirectory(), 'stderr.log');
  for (const text of ['', '\r\n', 'single line']) {
    await writeFile(file, text); assert.equal(await errorTail(file), text.trim());
  }
  const lines = Array.from({length:30}, (_,i)=>`${i}:`+'\u9519\u8bef'.repeat(700));
  await writeFile(file, lines.join('\n'));
  assert.equal(await errorTail(file), lines.slice(-20).join('\n'));
});
