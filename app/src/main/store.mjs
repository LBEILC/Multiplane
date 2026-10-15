import path from 'node:path';
import { jobAlive } from './process-identity.mjs';
import copy from '../shared/copy/en.mjs';
import os from 'node:os';
import { watch } from 'node:fs';
import { readFile, open, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { jobData } from '../shared/job-data.mjs';

export function homeDirectory(env = process.env, platform = process.platform, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.MULTIPLANE_HOME) return p.resolve(env.MULTIPLANE_HOME);
  if (platform === 'win32') return p.join(env.USERPROFILE || home, '.multiplane');
  return p.join(platform === 'darwin' ? p.join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || p.join(home, '.config'), 'multiplane');
}
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
export class EventTail {
  offset = 0; pending = Buffer.alloc(0); rows = []; identity = null; bytesRead = 0;
  constructor(report = (_error) => {}) { this.report = report; }
  async read(file) {
    let fd;
    try {
      fd = await open(file, 'r'); const info = await fd.stat();
      if (this.identity !== info.ino || info.size < this.offset) { this.offset = 0; this.pending = Buffer.alloc(0); this.rows = []; }
      this.identity = info.ino;
      // Read only appended bytes, retaining incomplete UTF-8 lines as bytes.
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(65536, info.size - this.offset));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.bytesRead += bytesRead; this.offset += bytesRead;
        const bytes = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        const end = bytes.lastIndexOf(10);
        if (end >= 0) {
          for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
            const row = parse(line);
            if (row?.schema === 'multiplane/1' && typeof row.type === 'string') this.rows.push(row);
            else if (line.trim()) this.report(Error('Invalid event row'));
          }
        }
        this.pending = Buffer.from(bytes.subarray(end + 1));
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    finally { await fd?.close(); }
    return this.rows;
  }
}
export class Preferences {
  /** @type {{theme: string, language: string, notifications: boolean, hidden: string[], wizardDone: boolean, autoCheckUpdates: boolean, trayExplained: boolean}} */
  value = { theme: 'system', language: 'system', notifications: true, hidden: [], wizardDone: false, autoCheckUpdates: true, trayExplained: false };
  queue = Promise.resolve();
  constructor(directory) { this.file = path.join(directory, 'preferences.json'); }
  async load() {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8'));
      this.value = { language: ['system', 'zh-CN', 'en'].includes(v.language) ? v.language : 'system', theme: ['system', 'light', 'dark'].includes(v.theme) ? v.theme : 'system', notifications: v.notifications !== false, hidden: Array.isArray(v.hidden) ? v.hidden.filter(x => typeof x === 'string') : [], wizardDone: v.wizardDone === true, autoCheckUpdates: v.autoCheckUpdates !== false, trayExplained: v.trayExplained === true };
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    return this.value;
  }
  save(patch) {
    const operation = this.queue.then(async () => {
      const next = { ...this.value, ...patch };
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(next));
      await rename(this.file + '.tmp', this.file);
      this.value = next; return next;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
export class JobStore extends EventEmitter {
  jobs = []; tails = new Map(); watchers = new Map(); timer; debounce; pending; again = false; closed = false; initialized = false;
  forced = new Set();
  progressActivity = new Map();
  seen = new Set(); notified = new Set(); startedAt = Date.now();
  constructor(home, { alive = jobAlive, pollMs = 2000 } = {}) { super(); this.home = home; this.alive = alive; this.pollMs = pollMs; }
  async start() { await this.refresh(); this.timer = setInterval(() => this.schedule(), this.pollMs); }
  schedule() { if (this.closed || this.debounce) return; this.debounce = setTimeout(() => { this.debounce = null; this.refresh().catch(e => this.emit('fault', e)); }, 60); }
  refresh() {
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = (async () => { do { this.again = false; await this.scan(); } while (this.again && !this.closed); })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async scan() {
    const records = new Map();
    for (const name of ['jobs.1.jsonl', 'jobs.jsonl']) {
      try {
        const text = await readFile(path.join(this.home, name), 'utf8');
        for (const [index, line] of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').entries()) {
          const r = parse(line);
          if (r?.schema === 'multiplane/1' && typeof r.jobId === 'string' && typeof r.jobDir === 'string' && path.isAbsolute(r.jobDir)) records.set(r.jobId, r);
          else if (line.trim()) this.emit('fault', Error(`Invalid index row: ${name}:${index + 1}`));
        }
      } catch (e) { if (e.code !== 'ENOENT') this.emit('fault', e); }
    }
    const previous = new Map(this.jobs.map(j => [j.jobId, j]));
    const jobs = [];
    for (const [id, record] of records) {
      try {
        const s = JSON.parse(await readFile(path.join(record.jobDir, 'status.json'), 'utf8'));
        if (s?.schema !== 'multiplane/1' || s.jobId !== id) { this.emit('fault', Error(`Invalid status for job ${id}`)); continue; }
        const tail = this.tails.get(id) ?? new EventTail(error => this.emit('fault', Error(`Job ${id}: ${error.message}`))); this.tails.set(id, tail);
        const events = [...await tail.read(path.join(record.jobDir, 'events.jsonl'))];
        let previewVersion = '';
        try { const p = await stat(path.join(record.jobDir, 'preview.png')); previewVersion = `${p.mtimeMs}:${p.size}`; } catch {}
        const job = jobData({ ...s, jobDir: record.jobDir, events, previewVersion }, error => this.emit('fault', error));
        if (!job) continue;
        job.hosted = await stat(path.join(this.home, 'hosted', id + '.claimed.json')).then(() => true, () => false) || await stat(path.join(this.home, 'hosted', id + '.running.json')).then(() => true, () => false);
        const alive = job.state === 'running' && await this.alive(s.pid, s);
        const previousProgress = this.progressActivity.get(id);
        if (!previousProgress || previousProgress.state !== job.state || previousProgress.phase !== s.phase || s.done > previousProgress.done) {
          const event = events.findLast(e => e.type === 'progress');
          const at = event && event.phase === s.phase && event.done === s.done ? event.ts : s.updatedAt;
          this.progressActivity.set(id, { state: job.state, phase: s.phase, done: s.done, at: Date.parse(at) });
        }
        // Memory samples and preview publication are not capture progress.
        job.stuck = job.state === 'running' && alive !== false && Date.now() - this.progressActivity.get(id).at > 60000;
        job.forced = this.forced.has(id);
        if (job.forced) {
          const options = events.find(e => e.type === 'start')?.options;
          const output = typeof options?.out === 'string' ? options.out : null;
          const request = job.hosted ? await readFile(path.join(this.home, 'hosted', id + '.running.json'), 'utf8').then(parse, () => null) : null;
          // TODO(design): Non-hosted start events lack cwd; retain relative output paths verbatim.
          const outputPath = output && (path.isAbsolute(output) ? output : request?.cwd ? path.resolve(request.cwd, output) : output);
          job.temporaryDirectories = [...new Set([job.jobDir, ...(outputPath ? [job.command === 'render' ? path.dirname(outputPath) : outputPath] : [])])];
        }
        if (job.state === 'running' && alive === false) {
          job.state = 'failed'; job.lost = true;
          job.result = { schema: s.schema, type: 'result', command: s.command, ts: s.updatedAt, ok: false, code: 'internal_error', message: copy.processLost, artifacts: events.filter(e => e.type === 'artifact').map(({ path, kind, bytes }) => ({ path, kind, bytes })), data: {}, elapsedMs: Math.max(0, Date.parse(s.updatedAt) - Date.parse(s.startedAt)) };
        }
        jobs.push(job);
      } catch (e) {
        this.emit('fault', Error(`Job ${id}: ${e.message}`));
        // Keep the last valid snapshot across partial writes and transient access failures.
        if (previous.has(id) && (e.code !== 'ENOENT' || await stat(record.jobDir).then(s => s.isDirectory()).catch(() => false))) jobs.push(previous.get(id));
      }
    }
    this.jobs = jobs;
    for (const id of this.tails.keys()) if (!records.has(id)) this.tails.delete(id);
    for (const id of this.progressActivity.keys()) if (!records.has(id)) this.progressActivity.delete(id);
    this.syncWatchers();
    if (this.initialized) for (const job of jobs) {
      const finishedSinceStartup = !this.seen.has(job.jobId) && Date.parse(job.result?.ts ?? job.updatedAt) >= this.startedAt;
      if (!['running', 'queued'].includes(job.state) && !this.notified.has(job.jobId) && (['running', 'queued'].includes(previous.get(job.jobId)?.state) || finishedSinceStartup)) {
        this.notified.add(job.jobId); this.emit('finished', job);
      }
    }
    for (const job of jobs) this.seen.add(job.jobId);
    this.initialized = true;
    this.emit('change', jobs);
  }
  syncWatchers() {
    if (this.closed) return;
    const dirs = new Set([this.home, ...this.jobs.filter(j => ['running', 'queued'].includes(j.state)).map(j => j.jobDir)]);
    for (const [dir, watcher] of this.watchers) if (!dirs.has(dir)) { watcher.close(); this.watchers.delete(dir); }
    for (const dir of dirs) if (!this.watchers.has(dir)) {
      try {
        const watcher = watch(dir, (_event, file) => { if (!file || ['jobs.jsonl', 'jobs.1.jsonl', 'status.json', 'events.jsonl', 'preview.png'].includes(String(file))) this.schedule(); });
        watcher.on('error', error => { this.emit('fault', error); watcher.close(); this.watchers.delete(dir); }); this.watchers.set(dir, watcher);
      } catch (error) { if (error.code !== 'ENOENT') this.emit('fault', error); /* Polling discovers a home created later. */ }
    }
  }
  job(id) { const job = this.jobs.find(j => j.jobId === id); if (!job) throw Error('Job is no longer available.'); return job; }
  async stop(id) { await this.refresh(); const job = this.job(id); if (['running', 'queued'].includes(job.state)) await writeFile(path.join(job.jobDir, 'stop'), ''); this.schedule(); }
  async close() { this.closed = true; clearInterval(this.timer); clearTimeout(this.debounce); for (const w of this.watchers.values()) w.close(); this.watchers.clear(); await this.pending; }
}
