import { homeDirectory } from './store.mjs';
import { t } from '../shared/i18n.mjs';
import { userError } from '../shared/errors.mjs';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import { spawnOwned, stopOwned } from './owned-process.mjs';

export const rendererRoot = (packaged, resources, appPath) => packaged ? path.join(resources, 'renderer') : path.resolve(appPath, '..');
export function execute(file, args, { env = process.env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnOwned(file, args, { env, cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    let failure, stopping;
    const stop = message => {
      if (stopping || !child.pid) return;
      failure = Error(message);
      stopping = stopOwned(child).catch(error => { failure = Error(`${message}; cleanup failed: ${error.message}`); });
    };
    const timer = setTimeout(() => stop('Command timed out'), timeout);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 4e6) stop('Command output exceeded its limit'); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-16000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', async code => { clearTimeout(timer); await stopping; if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}
export function bundledCommand(root, args, env = process.env, cwd = os.tmpdir()) {
  const command = bundledInvocation(root, args, process.execPath, env, cwd);
  return execute(command.file, command.args, command.options);
}
export async function checkFfmpeg(value, env = process.env, run = execute) {
  // Inspect the saved path itself, even if the renderer has an environment override.
  const file = value || env.MULTIPLANE_FFMPEG || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try {
    const result = await run(file, ['-version'], { env, timeout: 15000 });
    const version = result.stdout.split(/\r?\n/)[0];
    if (result.code !== 0) return { name: 'ffmpeg', ok: false, detail: '', reason: 'cannot-run', diagnostic: `exit ${result.code}` };
    if (!/^ffmpeg version\s/i.test(version)) return { name: 'ffmpeg', ok: false, detail: '', reason: 'not-ffmpeg' };
    return { name: 'ffmpeg', ok: true, detail: version };
  } catch (error) {
    return { name: 'ffmpeg', ok: false, detail: '', reason: error.code === 'ENOENT' ? 'not-found' : 'cannot-run', diagnostic: error.code ?? error.message };
  }
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
export async function pathVersion(file, env = process.env, run = execute) {
  if (!file) return null;
  let result;
  if (/\.(cmd|bat)$/i.test(file)) {
    // npm's Windows shim can be launched through Electron without invoking a shell.
    const shim = await fs.readFile(file, 'utf8');
    const match = shim.match(/"%dp0%[\\/]([^"\r\n]+)"[ \t]+%\*/i);
    if (!match || /[\r\n%]/.test(match[1])) throw Error(t('wrapperVersionError'));
    const script = path.resolve(path.dirname(file), match[1]);
    result = await run(process.execPath, [script, '--version'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
  } else result = await run(file, ['--version'], { env, timeout: 10000 });
  if (result.code !== 0) throw Error(result.stderr || 'Version check failed');
  return result.stdout.trim();
}
export function parseDoctor(stdout) {
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = events.at(-1);
  if (result?.schema !== 'multiplane/1' || result.type !== 'result' || result.command !== 'doctor' || !Array.isArray(result.data?.checks)) throw Error('Invalid doctor result');
  const environment = events.find(event => event.type === 'environment');
  return environment ? { ...result, environment } : result;
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

export async function setupCommand(root, args, env = process.env, run = bundledCommand) {
  const { stdout } = await run(root, [...args, '--json'], env);
  const result = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);
  if (result?.schema !== 'multiplane/1' || result.type !== 'result' || result.command !== args[0]) throw Error('Invalid setup result');
  if (!result.ok) throw Object.assign(Error(result.message ?? result.code), { code: result.code });
  return result.data;
}
export class Configuration {
  constructor(root, home, env = process.env, run = bundledCommand) {
    this.root = root; this.file = path.join(home, 'config.json'); this.env = path.resolve(home) === path.resolve(homeDirectory(env)) ? { ...env } : { ...env, MULTIPLANE_HOME: home }; this.run = run;
  }
  read() { return setupCommand(this.root, ['config', 'get'], this.env, this.run); }
  save(key, value) { return setupCommand(this.root, ['config', value === null ? 'unset' : 'set', key, ...(value === null ? [] : [String(value)])], this.env, this.run); }
}
export class Skills {
  constructor(root, env = process.env, run = bundledCommand) { this.root = root; this.env = env; this.run = run; }
  async list() { return (await setupCommand(this.root, ['skill', 'status'], this.env, this.run)).hosts.map(skillStatus); }
  async status(host) { return skillStatus((await setupCommand(this.root, ['skill', 'status', '--host', host], this.env, this.run)).hosts[0]); }
  async change(host, action, signature, force = false) {
    return (await setupCommand(this.root, ['skill', action, '--host', host, '--expect', signature ?? 'null', ...(force ? ['--force'] : [])], this.env, this.run)).hosts[0];
  }
}
function skillStatus(status) {
  const error = status.error;
  return { ...status, error: !error ? null : /symbolic links/.test(error) ? t('linkedSkill') : /Unsupported skill file/.test(error) ? t('unsupportedFile') : /not a directory|ENOTDIR/.test(error) ? userError({ code: 'ENOTDIR' }) : userError(Error(error)) };
}
