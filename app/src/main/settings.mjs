import { t } from '../shared/i18n.mjs';
import { userError } from '../shared/errors.mjs';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const rendererRoot = (packaged, resources, appPath) => packaged ? path.join(resources, 'renderer') : path.resolve(appPath, '..');
export function execute(file, args, { env = process.env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Command timed out')); }, timeout);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 4e6) child.kill(); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-16000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
export function bundledCommand(root, args, env = process.env, cwd = os.tmpdir()) {
  const command = bundledInvocation(root, args, process.execPath, env, cwd);
  return execute(command.file, command.args, command.options);
}
// execPath is the running Electron binary, including inside an AppImage mount.
// APPIMAGE and the GUI's process.argv must never replace it or supply Node flags.
export function bundledInvocation(root, args, execPath, env, cwd = os.tmpdir()) {
  return { file: execPath, args: [path.join(root, 'bin', 'multiplane'), ...args], options: { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } };
}
export async function findCommand(name, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const search = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  for (const dir of search.split(path.delimiter).filter(Boolean)) for (const ext of extensions) {
    const file = path.resolve(dir.replace(/^"|"$/g, ''), name + ext);
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file; } } catch {}
  }
  return null;
}
export async function pathVersion(file, env = process.env) {
  if (!file) return null;
  let result;
  if (/\.(cmd|bat)$/i.test(file)) {
    // npm's Windows shim can be launched through Electron without invoking a shell.
    const shim = await fs.readFile(file, 'utf8');
    const match = shim.match(/"%dp0%[\\/]([^"\r\n]+)"[ \t]+%\*/i);
    if (!match || /[\r\n%]/.test(match[1])) throw Error(t('wrapperVersionError'));
    const script = path.resolve(path.dirname(file), match[1]);
    result = await execute(process.execPath, [script, '--version'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
  } else result = await execute(file, ['--version'], { env, timeout: 10000 });
  if (result.code !== 0) throw Error(result.stderr || 'Version check failed');
  return result.stdout.trim();
}
export function parseDoctor(stdout) {
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = events.at(-1);
  if (result?.schema !== 'multiplane/1' || result.type !== 'result' || result.command !== 'doctor' || !Array.isArray(result.data?.checks)) throw Error('Invalid doctor result');
  return result;
}
export async function readEnvironment(skills, locate = findCommand, version = pathVersion) {
  const command = async () => {
    let file = null;
    try { file = await locate('multiplane'); return { path: file, version: await version(file), error: null }; }
    catch (error) { return { path: file, version: null, error: userError(error) }; }
  };
  const [agents, executable] = await Promise.all([skills.list(), command()]);
  return { skills: agents, command: executable };
}
export class Configuration {
  queue = Promise.resolve();
  constructor(home, env = process.env) { this.file = path.join(home, 'config.json'); this.env = env; }
  async read() {
    let values = {};
    try { values = JSON.parse(await fs.readFile(this.file, 'utf8')); if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Invalid config.json'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { values, file: this.file, overrides: { ffmpeg: this.env.MULTIPLANE_FFMPEG || null, jobsDir: this.env.MULTIPLANE_JOBS_DIR || null } };
  }
  save(key, value) {
    const valid = value === null || (['ffmpeg', 'jobsDir'].includes(key) ? typeof value === 'string' && !!value.trim() && !value.includes('\0') : key === 'raster' ? ['gpu', 'software'].includes(value) : key === 'encoder' ? ['x264', 'nvenc-h264', 'nvenc-hevc'].includes(value) : key === 'workers' && Number.isSafeInteger(value) && value > 0);
    if (!['ffmpeg', 'jobsDir', 'raster', 'encoder', 'workers'].includes(key) || !valid) return Promise.reject(Error('Invalid setting'));
    const operation = this.queue.then(async () => {
      const { values } = await this.read();
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = this.file + '.tmp';
      try { await fs.writeFile(temp, JSON.stringify({ ...values, schema: 'multiplane/1', [key]: value }, null, 2) + '\n'); await fs.rename(temp, this.file); }
      finally { await fs.unlink(temp).catch(() => {}); }
      return this.read();
    });
    this.queue = operation.catch(() => {}); return operation;
  }
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
const linkedSkill = () => Object.assign(Error(t('linkedSkill')), { code: 'SKILL_LINK' });
export async function treeHashes(root) {
  const files = Object.create(null);
  async function walk(dir, prefix = '') {
    if ((await fs.lstat(dir)).isSymbolicLink()) throw linkedSkill();
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw linkedSkill();
      if (entry.isDirectory()) { files[name + '/'] = null; await walk(path.join(dir, entry.name), name + '/'); }
      else if (entry.isFile()) { if (name !== marker) files[name] = hash(await fs.readFile(path.join(dir, entry.name))); }
      else throw Error(t('unsupportedFile'));
    }
  }
  await walk(root); return files;
}
export class Skills {
  queue = Promise.resolve();
  constructor(source, version, { user = os.homedir(), env = process.env } = {}) { this.source = source; this.version = version; this.user = user; this.env = env; }
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
    catch (error) { if (error.code === 'SKILL_LINK') return { ...base, state: 'modified', blocked: true, error: userError(error) }; throw error; }
    const signature = hash(JSON.stringify(files));
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(target, marker), 'utf8')); } catch {}
    const current = await treeHashes(this.source);
    const known = record?.v === 1 && record.host === host && record.skill === 'multiplane' && Array.isArray(record.releases)
      ? record.releases.filter(r => r && typeof r.version === 'string' && r.files && typeof r.files === 'object' && !Array.isArray(r.files)) : [];
    const release = [{ version: this.version, files: current }, ...known].find(r => JSON.stringify(r.files) === JSON.stringify(files));
    return { ...base, signature, version: release?.version ?? record?.version ?? null, state: release ? release.version === this.version ? 'latest' : 'update' : 'modified' };
  }
  list() { return Promise.all(['claude', 'codex'].map(async host => {
    try { return await this.status(host); }
    catch (error) { return { host, target: this.target(host), detected: false, availableVersion: this.version, version: null, state: 'error', blocked: true, error: userError(error) }; }
  })); }
  async backupName(host, date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const base = `multiplane.bak-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const parent = await realRoot(path.dirname(this.target(host)));
    let name = base;
    for (let i = 2; await exists(path.join(parent, name)); i++) name = `${base}-${i}`;
    return name;
  }
  change(host, action, expected, backupName) {
    const operation = this.queue.then(async () => {
      if (!['install', 'remove'].includes(action)) throw Error('Invalid skill action');
      backupName ??= await this.backupName(host);
      if (!/^multiplane\.bak-\d{8}-\d{6}(?:-[2-9]\d*|-1\d+)?$/.test(backupName)) throw Error('Invalid backup name');
      const before = await this.status(host);
      if (before.blocked) throw Error(before.error);
      if (before.signature !== expected) throw Error(t('skillChanged'));
      const parent = path.dirname(before.target);
      await fs.mkdir(parent, { recursive: true });
      if (await fs.realpath(parent) !== parent) throw Error(t('skillPathChanged'));
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
        if (latest.blocked || latest.target !== before.target || latest.signature !== before.signature || await fs.realpath(parent) !== parent) throw Error(t('skillChanged'));
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
