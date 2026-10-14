import { jobAlive, forceJob } from './process-identity.mjs';

export class JobStopper {
  timers = new Map(); pending = new Set(); closed = false;
  constructor(store, { confirm, confirmForce, changed = async () => {}, alive = jobAlive, force = forceJob, schedule = setTimeout, clear = clearTimeout, report = (_error) => {} }) {
    Object.assign(this, { store, confirm, confirmForce, changed, alive, force, schedule, clear, report });
  }
  async stop(id) {
    if (this.closed || this.pending.has(id) || this.timers.has(id)) return;
    this.pending.add(id);
    try {
      await this.store.refresh();
      const job = this.store.job(id);
      if (!['running', 'queued'].includes(job.state) || !await this.confirm(job) || this.closed) return;
      await this.store.stop(id); await this.changed();
      this.timers.set(id, this.schedule(() => this.escalate(id).catch(this.report).finally(() => this.timers.delete(id)), 15000));
    } finally { this.pending.delete(id); }
  }
  async escalate(id) {
    if (this.closed) return;
    await this.store.refresh(); const job = this.store.job(id);
    if (job.state !== 'running' || !await this.alive(job.pid, job) || !await this.confirmForce(job) || this.closed) return;
    await this.store.refresh(); const latest = this.store.job(id);
    if (latest.state === 'running' && await this.force(latest)) { this.store.forced.add(id); await this.store.refresh(); }
  }
  close() { this.closed = true; for (const timer of this.timers.values()) this.clear(timer); this.timers.clear(); }
}
