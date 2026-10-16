import path from 'node:path';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { bundledCommand, bundledInvocation } from './settings.mjs';
import { EventTail } from './store.mjs';

// File-backed stdio keeps both the standalone render and hosted waiter alive on app exit.
export async function launchResume(root, home, id, onEvent, { execPath = process.execPath, env = process.env, create = spawn } = {}) {
  const base = path.join(home, 'desktop-resume'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'attempt-'));
  const output = await open(path.join(directory, 'stdout.jsonl'), 'a');
  const error = await open(path.join(directory, 'stderr.log'), 'a');
  const command = bundledInvocation(root, ['resume', id, '--json'], execPath, { ...env, MULTIPLANE_HOME: home });
  let child, exited;
  try {
    child = create(command.file, command.args, { ...command.options, detached: true, windowsHide: true, shell: false, stdio: ['ignore', output.fd, error.fd] });
    exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await output.close(); await error.close(); }
  const tail = new EventTail(); let count = 0, reading = Promise.resolve();
  const read = () => reading = reading.then(async () => { for (const event of (await tail.read(path.join(directory, 'stdout.jsonl'))).slice(count)) { count++; onEvent(event); } });
  const timer = setInterval(() => { read().catch(() => {}); }, 100); timer.unref();
  const code = await exited;
  clearInterval(timer);
  await read(); await rm(directory, { recursive: true, force: true });
  return code;
}

export class ResumeJobs {
  cache = new Map(); attempts = new Map(); signatures = new Map(); selected = ''; closed = false; pending; timer;
  constructor(store, root, { run = bundledCommand, launch = launchResume, changed = (_id) => {}, report = (_e) => {} } = {}) {
    Object.assign(this, { store, root, run, launch, changed, report });
  }
  decorate(jobs) {
    const children = new Map();
    for (const j of jobs) {
      const from = j.result?.data?.resumedFrom ?? j.events.find(e => e.type === 'start')?.resumedFrom;
      if (from && (!children.has(from) || children.get(from).startedAt < j.startedAt)) children.set(from, j);
    }
    return jobs.map(j => ({ ...j, resume: this.cache.get(j.jobId), ...this.attempts.get(j.jobId), resumedBy: children.get(j.jobId)?.jobId }));
  }
  update() {
    for (const j of this.decorate(this.store.jobs)) {
      const signature = JSON.stringify([j.state, j.updatedAt, j.resumedBy]);
      if (this.signatures.get(j.jobId) !== signature) { this.cache.delete(j.jobId); this.signatures.set(j.jobId, signature); }
    }
    this.schedule();
  }
  prioritize(id) { this.selected = id; this.schedule(); }
  candidates() {
    const jobs = this.store.jobs.filter(j => j.command === 'render' && ['failed', 'cancelled'].includes(j.state)).sort((a,b) => b.startedAt.localeCompare(a.startedAt));
    const selected = jobs.find(j => j.jobId === this.selected);
    return [...(selected ? [selected] : []), ...jobs.filter(j => j !== selected)].slice(0,20);
  }
  schedule() {
    if (this.closed || this.pending || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pending = this.drain().finally(() => { this.pending = null; }); }, 100);
  }
  async drain() {
    while (!this.closed) {
      const j = this.candidates().find(j => !this.cache.has(j.jobId)); if (!j) return;
      const signature = this.signatures.get(j.jobId);
      // Cache failures as well, avoiding an endless retry loop on a broken CLI.
      this.cache.set(j.jobId, null);
      try {
        // IDs resolve relative to CLI config, while the desktop index spans job directories.
        const { stdout } = await this.run(this.root, ['status', j.jobDir, '--json'], { ...process.env, MULTIPLANE_HOME: this.store.home });
        const result = stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(e => e.type === 'result');
        if (signature === this.signatures.get(j.jobId) && result?.ok && result.data?.resume) this.cache.set(j.jobId, result.data.resume);
      } catch (e) { this.report(e); }
      if (!this.closed) this.changed();
    }
  }
  async resume(id) {
    const job = this.store.job(id);
    if (job.command !== 'render' || !['failed','cancelled'].includes(job.state)) throw Error('Invalid resume job');
    if (this.attempts.get(id)?.resuming) return;
    this.attempts.set(id, { resuming: true }); this.changed();
    let newId, result;
    try {
      await this.launch(this.root, this.store.home, job.jobDir, event => {
        if (event.type === 'result') result = event;
        if (!newId && typeof event.jobId === 'string' && event.jobId !== id && event.command === 'render') {
          newId = event.jobId;
          void this.store.refresh().then(() => { if (!this.closed) this.changed(newId); }).catch(this.report);
        }
        if (event.type === 'result' && event.code === 'resume_unavailable') {
          this.attempts.set(id, { resuming: false, resumeError: event.details }); this.changed();
        }
      });
      if (!result) throw Error('Resume command exited without a result');
      if (!result.ok && result.code !== 'resume_unavailable' && !newId) throw Error(result.message ?? result.code);
    } finally {
      this.attempts.set(id, { ...this.attempts.get(id), resuming: false });
      this.cache.delete(id); this.schedule(); if (!this.closed) this.changed();
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
