import path from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink, appendFile, utimes, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { processIdentity, jobAlive } from './process-identity.mjs';
const schema = 'multiplane/1';
export async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; } }
export async function atomic(file, value) { await writeFile(file + '.app-tmp', JSON.stringify(value) + '\n'); await rename(file + '.app-tmp', file); }
const exists = file => stat(file).then(() => true, () => false);
function jobReference(r, id) {
  return r?.schema === schema && r.jobId === id && typeof r.jobDir === 'string' && path.isAbsolute(r.jobDir) && path.basename(r.jobDir) === id;
}
export async function validRequest(r, id, { execPath = process.execPath } = {}) {
  if (!jobReference(r, id)
    || !['jobDir', 'node', 'bin', 'cwd'].every(key => typeof r[key] === 'string' && path.isAbsolute(r[key]))
    || path.basename(r.jobDir) !== id
    || !['render', 'stills', 'verify', 'resume'].includes(r.command) || !Array.isArray(r.args) || !r.args.every(a => typeof a === 'string')
    || !r.env || typeof r.env !== 'object' || Array.isArray(r.env) || Object.values(r.env).some(v => typeof v !== 'string')) return false;
  if (!/^node(\.exe)?$/i.test(path.basename(r.node))) {
    if (r.env.ELECTRON_RUN_AS_NODE !== '1') return false;
    try {
      const [requested, own] = await Promise.all([realpath(r.node), realpath(execPath)]);
      const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (normalize(requested) !== normalize(own)) return false;
    } catch { return false; }
  }
  const pkg = await json(path.resolve(r.bin, '../../package.json'));
  const s = await json(path.join(r.jobDir, 'status.json'));
  return pkg?.name === 'multiplane' && s?.jobId === id && s.schema === schema
    && await stat(r.node).then(info => info.isFile(), () => false) && await stat(r.bin).then(info => info.isFile(), () => false);
}
export function launchExecutor(r, create = spawn) {
  return new Promise((resolve, reject) => {
    const child = create(r.node, [r.bin, r.command, ...r.args, '--job-dir-exact', r.jobDir, '--hosted-executor'], { cwd: r.cwd, env: r.env, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}
export class Hosted {
  enabled = false; closed = false; pending; timer; launching = new Map(); queueSignature = '';
  constructor(home, version, { inspect = processIdentity, alive = jobAlive, launch = launchExecutor, report = (_error) => {}, changed = () => {} } = {}) { Object.assign(this, { home, version, inspect, alive, launch, report, changed }); this.directory = path.join(home, 'hosted'); }
  async start() { await mkdir(this.directory, { recursive: true }); this.identity = await this.inspect(process.pid); await this.tick(); this.timer = setInterval(() => this.tick().catch(this.report), 500); }
  async publish() { if (!this.identity) return; await atomic(path.join(this.home, 'app.json'), { schema, pid: process.pid, createdAt: this.identity.createdAt, acceptsHosted: this.enabled && !this.closed, version: this.version }); }
  tick() { if (this.pending) return this.pending; this.pending = this.scan().finally(() => { this.pending = null; }); return this.pending; }
  async scan() {
    if (this.closed) return;
    const enabled = (await json(path.join(this.home, 'config.json')))?.hosted === true;
    if (enabled !== this.enabled || !await exists(path.join(this.home, 'app.json'))) { this.enabled = enabled; await this.publish(); this.changed(); }
    let files = await readdir(this.directory);
    if (this.enabled) for (const name of files.filter(n => n.endsWith('.request.json')).sort()) {
      const file = path.join(this.directory, name), id = name.slice(0, -13), r = await json(file);
      if (!await validRequest(r, id)) {
        try { const target = file.replace('.request.json', '.rejected.json'); await rename(file, target); await atomic(target, { ...r, reason: 'Invalid hosted request.' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      try { const target = file.replace('.request.json', '.claimed.json'); await rename(file, target); const now = new Date(); await utimes(target, now, now); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    files = await readdir(this.directory);
    const queued = []; let busy = false;
    for (const name of files.filter(n => /\.(claimed|running)\.json$/.test(n))) {
      const file = path.join(this.directory, name), r = await json(file), id = name.replace(/\.(claimed|running)\.json$/, ''), running = name.endsWith('.running.json');
      // An already-running executor remains authoritative if its package is moved or upgraded.
      if (!jobReference(r, id) || (!running && !await validRequest(r, id))) continue;
      const s = await json(path.join(r.jobDir, 'status.json'));
      if (s?.schema !== schema || s.jobId !== id) { if (running) busy = true; continue; }
      if (s.result || ['cancelled', 'succeeded', 'failed'].includes(s.state)) { this.launching.delete(r.jobId); continue; }
      if (running) {
        if ((s.state === 'queued' && Date.now() - (this.launching.get(r.jobId) ?? (await stat(file)).ctimeMs) < 15000) || (s.state !== 'queued' && await this.alive(s.pid, s) !== false)) busy = true;
        continue;
      }
      if (this.launching.has(r.jobId)) { if (Date.now() - this.launching.get(r.jobId) < 15000) { busy = true; continue; } this.launching.delete(r.jobId); }
      if (await exists(path.join(r.jobDir, 'stop'))) {
        const ts = new Date().toISOString(), result = { schema, type: 'result', command: r.command, jobId: r.jobId, ts, ok: false, code: 'cancelled', message: 'Cancelled.', artifacts: [], data: {}, elapsedMs: 0 };
        await appendFile(path.join(r.jobDir, 'events.jsonl'), JSON.stringify(result) + '\n');
        const { queuePosition, ...rest } = s; await atomic(path.join(r.jobDir, 'status.json'), { ...rest, state: 'cancelled', updatedAt: ts, result });
        continue;
      }
      queued.push({ r, s, at: (await stat(file)).mtimeMs });
    }
    queued.sort((a, b) => a.at - b.at || a.r.jobId.localeCompare(b.r.jobId));
    const signature = JSON.stringify(queued.map(({ r }) => r.jobId));
    for (const [i, { r, s }] of queued.entries()) if (signature !== this.queueSignature || s.state !== 'queued' || s.queuePosition !== i + 1) await atomic(path.join(r.jobDir, 'status.json'), { ...s, state: 'queued', queuePosition: i + 1, updatedAt: new Date().toISOString() });
    this.queueSignature = signature;
    if (!this.closed && !busy && queued.length) {
      const r = queued[0].r; this.launching.set(r.jobId, Date.now());
      try { await this.launch(r); } catch (error) { this.launching.delete(r.jobId); this.report(error); }
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.pending; const file = path.join(this.home, 'app.json'); const current = await json(file); if (current?.pid === process.pid && current.createdAt === this.identity?.createdAt) await unlink(file).catch(() => {}); }
}
