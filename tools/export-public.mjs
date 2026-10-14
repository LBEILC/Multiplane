import { nativeRealpath } from './native-realpath.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, lstat, mkdir, readdir, writeFile, rm, rmdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from './process.mjs';
import { ensureLocalFfmpeg } from '../tests/local-ffmpeg.mjs';

export const excluded = name => ['AGENTS.md', 'docs/requirements.md', 'docs/internal.md', 'docs/design.md'].includes(name) || ['docs/roles/', 'docs/specs/', 'tools/reports/', '.claude/', 'app/design/preview.'].some(prefix => name.startsWith(prefix));
const git = (root, args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
async function noLinks(file, root) {
  for (let current = path.resolve(file); current !== root; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error(`Symbolic links are not allowed: ${file}`); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (current === path.dirname(current)) throw Error('Path is outside the validation root');
  }
}
export async function resolveExportPaths(root, output, { paths = path, canonical = nativeRealpath } = {}) {
  // Resolve existing ancestors too: a new output may sit below an OS path alias.
  const resolveOutput = async file => {
    try { return await canonical(file); }
    catch (error) {
      const parent = paths.dirname(file);
      if (error.code !== 'ENOENT' || parent === file) throw error;
      return paths.join(await resolveOutput(parent), paths.basename(file));
    }
  };
  root = await canonical(paths.resolve(root));
  output = await resolveOutput(paths.resolve(output));
  const relation = paths.relative(output, root);
  if (!relation || (!relation.startsWith('..' + paths.sep) && relation !== '..' && !paths.isAbsolute(relation))) throw Error('Output cannot be the repository or its ancestor');
  return { root, output };
}
function localLinks(source) {
  const text = source.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]+`/g, '');
  return [
    ...[...text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)].map(m => m[1] || m[2]),
    ...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(m => m[1] || m[2]),
    ...[...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(m => m[1])
  ].filter(link => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link));
}
export async function exportPublic(root, output, log = console.log, { message } = {}) {
  if (!output) throw Error('Usage: npm run export:public -- <output-directory>');
  ({ root, output } = await resolveExportPaths(root, output));
  let incremental = false, previous = [];
  try {
    if (!(await lstat(output)).isDirectory()) throw Error('Output directory must be empty or a marked public repository');
    if ((await readdir(output)).length) {
      await noLinks(path.join(output, '.git'), output);
      if (!(await lstat(path.join(output, '.git')).catch(() => null))?.isDirectory()) throw Error('Output directory must be empty or a marked public repository');
      let marker;
      try { marker = git(output, ['config', '--local', '--get', 'multiplane.publicExport']).trim(); } catch {}
      if (marker !== '1') throw Error('Output directory must be empty or a marked public repository');
      if (typeof message !== 'string' || !message.trim()) throw Error('Incremental export requires nonempty --message');
      if (git(output, ['status', '--porcelain', '--untracked-files=all']).trim()) throw Error('Public repository must have a clean working tree');
      // Ignored build products may stay, but cannot hide new export files.
      previous = git(output, ['ls-files', '-z']).split('\0').filter(Boolean);
      incremental = true;
    }
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const internal = await readFile(path.join(root, 'docs/internal.md'), 'utf8');
  const lines = [...internal.matchAll(/^```forbidden\s*\r?\n([\s\S]*?)^```\s*$/gm)].flatMap(m => m[1].split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  if (!lines.length) throw Error('Forbidden rules are required');
  const rules = lines.map((line, i) => { try { return new RegExp(line, 'i'); } catch { throw Error(`Invalid forbidden rule ${i + 1}`); } });
  if (message && rules.some(rule => rule.test(message))) throw Error('Public scan failed: commit message');
  const ignored = new Set(git(root, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']).split('\0'));
  const tracked = new Map();
  for (const row of git(root, ['ls-files', '-z', '--stage']).split('\0').filter(Boolean)) {
    const match = row.match(/^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/);
    if (!match || match[2] !== '0') throw Error('Unmerged or invalid Git index entry');
    tracked.set(match[3], match[1]);
  }
  const files = [...tracked.keys()].filter(name => !excluded(name) && !ignored.has(name)).sort();
  const entries = [], hits = [];
  for (const name of files) {
    if (!['100644', '100755'].includes(tracked.get(name))) throw Error(`Symbolic links and submodules are not allowed: ${name}`);
    if (path.isAbsolute(name) || name.split('/').includes('..')) throw Error('Unsafe tracked path');
    const file = path.join(root, name); await noLinks(file, root);
    const info = await lstat(file);
    if (!info.isFile()) throw Error(`Not a regular file: ${name}`);
    const bytes = await readFile(file);
    // Scan raw byte text plus common Unicode encodings, including binary payloads.
    const texts = [name, bytes.toString('utf8'), bytes.toString('latin1'), bytes.toString('utf16le')];
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - bytes.length % 2)); swapped.swap16(); texts.push(swapped.toString('utf16le'));
    rules.forEach((rule, i) => { if (texts.some(text => rule.test(text))) hits.push(`${name}: rule ${i + 1}`); });
    entries.push({ name, bytes, mode: tracked.get(name) === '100755' ? 0o755 : 0o644 });
  }
  if (hits.length) throw Error(`Public scan failed:\n${hits.join('\n')}`);
  const links = [];
  for (const entry of entries.filter(e => /\.md$/i.test(e.name))) for (const link of localLinks(entry.bytes.toString('utf8'))) {
    let target;
    try { target = decodeURIComponent(link.split(/[?#]/)[0]).replaceAll('\\', '/'); } catch { links.push(`${entry.name}: invalid link`); continue; }
    if (!target) continue;
    target = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(entry.name), target)).replace(/\/$/, '');
    if (target === '.') continue;
    if (!files.includes(target) && !files.some(file => file.startsWith(target + '/'))) links.push(`${entry.name}: ${link}`);
  }
  if (links.length) throw Error(`Links outside the export set:\n${links.join('\n')}`);
  const destination = name => {
    const target = path.resolve(output, name), relative = path.relative(output, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative.split(path.sep)[0] === '.git') throw Error('Unsafe destination path');
    return target;
  };
  if (incremental) {
    const checkDirectory = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + '/' + entry.name;
        if (entry.isSymbolicLink()) throw Error(`Symbolic links are not allowed: ${name}`);
        if (entry.isDirectory()) {
          if (!previous.some(file => file.startsWith(name + '/'))) throw Error(`Export would replace an untracked directory: ${name}`);
          await checkDirectory(destination(name), name);
        }
        else if (!previous.includes(name)) throw Error(`Export would replace an untracked file: ${name}`);
      }
    };
    for (const entry of entries) {
      const target = destination(entry.name); await noLinks(target, output);
      try {
        const info = await lstat(target);
        if (info.isDirectory()) {
          if (!previous.some(file => file.startsWith(entry.name + '/'))) throw Error(`Export would replace an untracked directory: ${entry.name}`);
          await checkDirectory(target, entry.name);
        }
        else if (!previous.includes(entry.name)) throw Error(`Export would replace an untracked file: ${entry.name}`);
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    for (const name of previous) await noLinks(destination(name), output);
  }
  // Resolve identity and all validation before writing any output.
  const name = git(root, ['config', 'user.name']).trim(), email = git(root, ['config', 'user.email']).trim();
  if (!name || !email) throw Error('Git user.name and user.email are required');
  await mkdir(output, { recursive: true });
  const removed = previous.filter(name => !files.includes(name));
  for (const name of removed) {
    await rm(destination(name));
    // Remove only empty ancestors, allowing file/directory transitions.
    for (let dir = path.dirname(destination(name)); dir !== output; dir = path.dirname(dir)) {
      try { await rmdir(dir); } catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) break; throw error; }
    }
  }
  for (const entry of entries) {
    const target = destination(entry.name); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: incremental ? 'w' : 'wx', mode: entry.mode });
    await chmod(target, entry.mode);
  }
  if (!incremental) git(output, ['init', '--initial-branch=main']);
  git(output, ['config', '--local', 'multiplane.publicExport', '1']);
  git(output, ['config', 'user.name', name]); git(output, ['config', 'user.email', email]);
  const candidates = [...new Set([...files, ...removed])];
  const changed = candidates.filter(name => !candidates.some(parent => parent !== name && name.startsWith(parent + '/')));
  for (let i = 0; i < changed.length; i += 40) git(output, ['--literal-pathspecs', 'add', '--', ...changed.slice(i, i + 40)]);
  const regular = entries.filter(entry => entry.mode === 0o644).map(entry => entry.name);
  for (let i = 0; i < regular.length; i += 40) git(output, ['--literal-pathspecs', 'update-index', '--chmod=-x', '--', ...regular.slice(i, i + 40)]);
  const executable = entries.filter(entry => entry.mode === 0o755).map(entry => entry.name);
  for (let i = 0; i < executable.length; i += 40) git(output, ['--literal-pathspecs', 'update-index', '--chmod=+x', '--', ...executable.slice(i, i + 40)]);
  // The destination started clean; include the already staged deletions too.
  // --only (Git's default with paths) mishandles file/directory transitions.
  git(output, ['-c', 'commit.gpgsign=false', 'commit', '--include', '--allow-empty', '-m', incremental ? message : (message?.trim() || 'Initial public release'), '--', ...files]);
  const distribution = {};
  for (const file of files) { const top = file.includes('/') ? file.split('/')[0] + '/' : '(root)'; distribution[top] = (distribution[top] || 0) + 1; }
  const summary = { count: files.length, distribution, rules: rules.length, scan: 'passed', links: 'passed', commit: git(output, ['rev-parse', 'HEAD']).trim() };
  log(JSON.stringify(summary, null, 2)); return summary;
}
export async function validatePublicExport(output, npmCommand = npm) {
  // The public copy has no per-machine settings of its own; use this checkout's FFmpeg for its tests.
  ensureLocalFfmpeg();
  const timeout = 30 * 60000;
  for (const args of [['ci'], ['test']]) {
    const command = args.join(' ');
    await npmCommand(args, { cwd: output, timeout, killTree: true,
      timeoutMessage: elapsed => `Public export npm ${command} timed out after ${Number((elapsed / 60000).toFixed(4))} min (limit ${timeout / 60000} min)` });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (![3, 5].includes(process.argv.length) || (process.argv.length === 5 && (process.argv[3] !== '--message' || !process.argv[4].trim()))) throw Error('Usage: npm run export:public -- <output-directory> [--message <commit-message>]');
    const output = path.resolve(process.argv[2]);
    await exportPublic(process.cwd(), output, console.log, { message: process.argv[4] });
    await validatePublicExport(output);
    console.log('Public export: npm ci and npm test (daily suite) passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
