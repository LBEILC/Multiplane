import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm, run } from './process.mjs';

const publicDocs = new Set(['docs/protocol.md', 'docs/protocol.zh-CN.md']);
export const forbiddenPackageFiles = files => files.filter(file => file === 'AGENTS.md' || /^(?:app|tests|out|\.github|tools\/reports)\//.test(file) || (file.startsWith('docs/') && !publicDocs.has(file)));

export function validatePublishConfig(pkg) {
  if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') throw Error('publishConfig.registry must be https://registry.npmjs.org/');
  if (pkg.publishConfig?.access !== 'public') throw Error('publishConfig.access must be public');
}

export function missingReadmeLinks(name, source, files) {
  const text = source.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]+`/g, '');
  const links = [
    ...[...text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)].map(m => m[1] || m[2]),
    ...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(m => m[1] || m[2]),
    ...[...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(m => m[1])
  ];
  return [...new Set(links)].filter(link => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) return false;
    let target;
    try { target = decodeURIComponent(link.split(/[?#]/)[0]).replaceAll('\\', '/'); } catch { return true; }
    if (!target) return false;
    target = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(name), target)).replace(/\/$/, '');
    return target !== '.' && !files.includes(target) && !files.some(file => file.startsWith(target + '/'));
  }).map(link => `${name}: ${link}`);
}

export async function releaseCheck(root, log = console.log) {
  let failed = false;
  const check = async (label, action) => {
    try { const detail = await action(); log(`[PASS] ${label}${detail ? ': ' + detail : ''}`); }
    catch (error) { failed = true; log(`[FAIL] ${label}: ${error.message}`); }
  };
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const git = async args => (await run('git', args, { cwd: root, capture: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  const pkg = await json('package.json');
  await check('npm publish configuration', async () => validatePublishConfig(pkg));
  await check('Versions and lockfiles', async () => {
    const app = await json('app/package.json');
    for (const [file, manifest] of [['package-lock.json', pkg], ['app/package-lock.json', app]]) {
      const lock = await json(file);
      if (manifest.version !== pkg.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw Error(`Version mismatch: ${file}`);
    }
    return pkg.version;
  });
  await check('Clean working tree', async () => {
    const status = (await git(['status', '--porcelain', '--untracked-files=all'])).trim();
    if (status) throw Error('\n' + status);
  });
  let pack;
  await check('npm pack --dry-run', async () => {
    const result = await npm(['pack', '--dry-run', '--json'], { cwd: root, capture: true });
    [pack] = JSON.parse(result.stdout);
    if (!Array.isArray(pack?.files)) throw Error('Missing package file list');
    return `${pack.filename}; ${pack.files.length} files; ${pack.size} bytes packed; ${pack.unpackedSize} bytes unpacked`;
  });
  const files = pack?.files.map(file => file.path) ?? [];
  await check('Package file boundaries and READMEs', async () => {
    if (!pack) throw Error('Package inventory unavailable');
    const forbidden = forbiddenPackageFiles(files);
    if (!files.includes('README.md')) forbidden.push('Missing README.md');
    if (!files.includes('README.en.md')) forbidden.push('Missing README.en.md');
    if (forbidden.length) throw Error('\n' + forbidden.join('\n'));
  });
  await check('README relative links', async () => {
    if (!pack) throw Error('Package inventory unavailable');
    const issues = [];
    for (const name of files.filter(file => /(?:^|\/)readme(?:\.[^/]+)?$/i.test(file))) issues.push(...missingReadmeLinks(name, await readFile(path.join(root, name), 'utf8'), files));
    if (issues.length) throw Error('\n' + issues.join('\n'));
  });
  await check('Executable bin entries with LF', async () => {
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    if (!bins.length) throw Error('No bin entries');
    for (const bin of bins) {
      const name = bin.replace(/^\.\//, '');
      const index = await git(['ls-files', '--stage', '--', name]);
      if (!index.startsWith('100755 ')) throw Error(`${name}: Git executable mode must be 100755`);
      if (process.platform !== 'win32' && !((await stat(path.join(root, name))).mode & 0o111)) throw Error(`${name}: missing filesystem executable bit`);
      const bytes = await readFile(path.join(root, name));
      if (bytes.includes(13) || !bytes.toString('utf8').startsWith('#!/usr/bin/env node\n')) throw Error(`${name}: expected LF and Node shebang`);
      if (!files.includes(name)) throw Error(`${name}: missing from package`);
    }
  });
  log(failed ? 'Release check failed.' : 'Release check passed.');
  return !failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await releaseCheck(fileURLToPath(new URL('../', import.meta.url)))) process.exitCode = 1; }
  catch (error) { console.error(`[FAIL] ${error.message}`); process.exitCode = 1; }
}
