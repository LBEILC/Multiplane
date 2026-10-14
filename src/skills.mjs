import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { MultiplaneError } from './errors.mjs';
export async function findCommand(name, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const search = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  for (const dir of search.split(path.delimiter).filter(Boolean)) for (const ext of extensions) {
    const file = path.resolve(dir.replace(/^"|"$/g, ''), name + ext);
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file; } } catch {}
  }
  return null;
}
const marker = '.multiplane.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
// Resolve existing ancestors without creating directories during inspection.
async function realRoot(root) {
  try {
    const resolved = await fs.realpath(root);
    if (!(await fs.stat(resolved)).isDirectory()) throw Object.assign(Error('Skill root is not a directory'), { code: 'ENOTDIR' });
    return resolved;
  }
  catch (error) {
    if (error.code !== 'ENOENT' || await exists(root)) throw error;
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return path.join(await realRoot(parent), path.basename(root));
  }
}
const linkedSkill = () => Object.assign(Error('Skill directories cannot contain symbolic links'), { code: 'SKILL_LINK' });
export async function treeHashes(root) {
  const files = Object.create(null);
  async function walk(dir, prefix = '') {
    if ((await fs.lstat(dir)).isSymbolicLink()) throw linkedSkill();
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw linkedSkill();
      if (entry.isDirectory()) { files[name + '/'] = null; await walk(path.join(dir, entry.name), name + '/'); }
      else if (entry.isFile()) { if (name !== marker) files[name] = hash(await fs.readFile(path.join(dir, entry.name))); }
      else throw Object.assign(Error('Unsupported skill file type'), { code: 'SKILL_LINK' });
    }
  }
  await walk(root); return files;
}
export class Skills {
  queue = Promise.resolve();
  constructor(source, version, { user = process.env.MULTIPLANE_AGENT_HOME || os.homedir(), env = process.env } = {}) { this.source = source; this.version = version; this.user = user; this.env = env; }
  target(host) {
    if (!['claude', 'codex'].includes(host)) throw Error('Invalid agent');
    return path.join(this.user, host === 'claude' ? '.claude' : '.agents', 'skills', 'multiplane');
  }
  async status(host) {
    const target = path.join(await realRoot(path.dirname(this.target(host))), 'multiplane');
    const detected = await exists(path.join(this.user, host === 'claude' ? '.claude' : '.codex')) || !!await findCommand(host, this.env);
    const base = { host, target, detected, availableVersion: this.version, version: null, state: 'missing', signature: null, blocked: false, error: null };
    if (!await exists(target)) return base;
    let files;
    try { files = await treeHashes(target); }
    catch (error) { if (error.code === 'SKILL_LINK') return { ...base, state: 'modified', blocked: true, error: error.message }; throw error; }
    const signature = hash(JSON.stringify(files));
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(target, marker), 'utf8')); } catch {}
    const current = await treeHashes(this.source);
    const known = record?.v === 1 && record.host === host && record.skill === 'multiplane' && Array.isArray(record.releases)
      ? record.releases.filter(r => r && typeof r.version === 'string' && r.files && typeof r.files === 'object' && !Array.isArray(r.files)) : [];
    const release = [{ version: this.version, files: current }, ...known].find(r => JSON.stringify(r.files) === JSON.stringify(files));
    return { ...base, signature, version: release?.version ?? record?.version ?? null, state: release ? release.version === this.version ? 'latest' : 'update' : 'modified' };
  }
  list(hosts = ['claude', 'codex']) { return Promise.all(hosts.map(async host => {
    try { return await this.status(host); }
    catch (error) { return { host, target: this.target(host), detected: false, availableVersion: this.version, version: null, state: 'error', blocked: true, error: error.message }; }
  })); }
  async backupName(host, date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const base = `multiplane.bak-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const parent = await realRoot(path.dirname(this.target(host)));
    let name = base;
    for (let i = 2; await exists(path.join(parent, name)); i++) name = `${base}-${i}`;
    return name;
  }
  change(host, action, expected, backupName, force = false) {
    const operation = this.queue.then(async () => {
      if (!['install', 'remove'].includes(action)) throw Error('Invalid skill action');
      backupName ??= await this.backupName(host);
      if (!/^multiplane\.bak-\d{8}-\d{6}(?:-[2-9]\d*|-1\d+)?$/.test(backupName)) throw Error('Invalid backup name');
      const before = await this.status(host);
      if (before.blocked) throw new MultiplaneError('skill_blocked', before.error);
      if (expected !== undefined && before.signature !== expected) throw new MultiplaneError('skill_changed');
      if (before.state === 'modified' && !force) throw new MultiplaneError('skill_modified', undefined, { hint: 'Use --force to back up the modified directory before continuing.' });
      const parent = path.dirname(before.target);
      await fs.mkdir(parent, { recursive: true });
      if (await fs.realpath(parent) !== parent) throw Error('Skill path changed');
      const token = randomUUID(), stage = path.join(parent, '.multiplane-new-' + token);
      const old = path.join(parent, backupName);
      if (await exists(old)) throw Error('Backup already exists');
      let moved = false, installed = false;
      const remove = async target => {
        if (path.dirname(path.resolve(target)) !== path.resolve(parent) || path.resolve(target) === path.resolve(parent)) throw Error('Invalid removal target');
        await fs.rm(target, { recursive: true, force: true });
      };
      try {
        if (action === 'install') {
          const files = await treeHashes(this.source);
          await fs.cp(this.source, stage, { recursive: true });
          let previous;
          try { previous = JSON.parse(await fs.readFile(path.join(before.target, marker), 'utf8')); } catch {}
          const releases = previous?.v === 1 && previous.host === host && Array.isArray(previous.releases)
            ? previous.releases.filter(r => r && typeof r.version === 'string' && r.files && typeof r.files === 'object' && !Array.isArray(r.files)) : [];
          await fs.writeFile(path.join(stage, marker), JSON.stringify({ v: 1, host, skill: 'multiplane', version: this.version, installedAt: Date.now(), files, releases: [...releases.filter(r => r.version !== this.version), { version: this.version, files }] }, null, 2));
          if (JSON.stringify(await treeHashes(stage)) !== JSON.stringify(files)) throw Error('Skill source changed during copy');
        }
        const latest = await this.status(host);
        if (latest.blocked || latest.target !== before.target || latest.signature !== before.signature || await fs.realpath(parent) !== parent) throw new MultiplaneError('skill_changed');
        if (before.state !== 'missing') { await fs.rename(before.target, old); moved = true; }
        if (action === 'install') { await fs.rename(stage, before.target); installed = true; }
      } catch (error) {
        if (installed) await remove(before.target);
        if (moved) await fs.rename(old, before.target);
        throw error;
      } finally { await remove(stage); }
      if (moved && before.state !== 'modified') await remove(old);
      return { backup: moved && before.state === 'modified' ? old : null };
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
