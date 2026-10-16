import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir, copyFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { run, npm } from './process.mjs';

export const steps = ['prepare', 'verify', 'export', 'push', 'collect', 'draft'];
const repository = 'LBEILC/Multiplane';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => !!await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
export function checkDesignFiles(files) {
  const forbidden = files.filter(file => file.startsWith('app/design/') && file !== 'app/design/tokens.css' && !file.startsWith('app/design/icons/'));
  if (forbidden.length) throw Error(`Forbidden design files: ${forbidden.join(', ')}`);
}
export function artifactNames(version) {
  const exe = `Multiplane-Setup-${version}-x64.exe`;
  return [exe, `Multiplane-${version}-arm64.dmg`, `Multiplane-${version}-x64.dmg`, `Multiplane-${version}-x86_64.AppImage`, 'latest.yml', `${exe}.blockmap`];
}
export async function checkArtifacts(directory, version) {
  const names = artifactNames(version), hashes = {};
  for (const name of names) {
    const file = path.join(directory, name), info = await lstat(file);
    if (!info.isFile() || !info.size) throw Error(`Missing or empty artifact: ${name}`);
    hashes[name] = digest(await readFile(file));
  }
  const metadata = await readFile(path.join(directory, 'latest.yml'), 'utf8');
  const values = key => [...metadata.matchAll(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+?)\\s*$`, 'gm'))].map(m => m[1].replace(/^['"]|['"]$/g, ''));
  const exe = await readFile(path.join(directory, names[0]));
  if (!values('sha512').length || values('sha512').some(value => value !== digest(exe, 'sha512', 'base64'))) throw Error('Installer SHA-512 mismatch');
  if (!values('size').length || values('size').some(value => Number(value) !== exe.length)) throw Error('Installer size mismatch');
  if (!values('version').includes(version) || !values('path').includes(names[0]) || !values('url').includes(names[0]) || [...values('path'), ...values('url')].some(value => value !== names[0])) throw Error('Update metadata version or filename mismatch');
  return hashes;
}

// The injectable command boundary lets failure tests exercise the actual pipeline offline.
export async function release(options, { execute, log = console.log, sleep = delay } = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(options.version ?? '')) throw Error('--version is required');
  const directory = path.resolve(options.output ?? path.join(root, 'out', `release-${options.version}`));
  await mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, 'state.json');
  const lockFile = path.join(directory, 'running.lock');
  const lock = await open(lockFile, 'wx').catch(() => { throw Error(`Release is locked: ${lockFile}. After confirming the previous process ended, remove this lock to resume.`); });
  await lock.writeFile(String(process.pid));
  let state;
  try {
    state = await exists(stateFile) ? await json(stateFile) : {
      version: options.version, root, worktree: path.resolve(options.worktree ?? path.join(directory, 'worktree')),
      publicRepo: path.resolve(options.publicRepo ?? path.join(root, 'out/public-repo')),
      notes: path.resolve(options.notes ?? path.join(root, `out/release-notes-${options.version}.md`)), completed: [], runs: {},
    };
    for (const [key, value] of Object.entries({ version: options.version, root, worktree: options.worktree && path.resolve(options.worktree), publicRepo: options.publicRepo && path.resolve(options.publicRepo), notes: options.notes && path.resolve(options.notes) })) {
      if (value && value !== state[key]) throw Error(`Saved ${key} differs; use a new output directory`);
    }
    const save = async () => { await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n'); await rename(stateFile + '.tmp', stateFile); };
    const command = async (label, file, args, cwd = state.worktree) => {
      const logs = path.join(directory, 'logs'); await mkdir(logs, { recursive: true });
      const stepLabel = state.current && !label.startsWith(state.current + '-') ? `${state.current}-${label}` : label;
      const logfile = path.join(logs, `${stepLabel}.log`);
      const handle = await open(logfile, 'a');
      let writes = Promise.resolve();
      await handle.write(`\n${file} ${JSON.stringify(args)}\n`);
      log(`${label}: ${logfile}`);
      try {
        // Keep release subprocesses away from the user's renderer and agent homes.
        const env = { ...process.env, MULTIPLANE_HOME: path.join(directory, 'home'), MULTIPLANE_AGENT_HOME: path.join(directory, 'agent-home') };
        const config = { cwd, env, capture: true, timeout: 90 * 60000, onOutput: bytes => { writes = writes.then(() => handle.write(bytes)); writes.catch(() => {}); } };
        const result = execute ? await execute(file, args, config) : file === 'npm' ? await npm(args, config) : await run(file, args, config);
        if (result?.code && result.code !== 0) throw Error(`Exit ${result.code}`);
        if (execute) await handle.write((result?.stdout ?? '') + (result?.stderr ?? ''));
        return result?.stdout?.trim() ?? '';
      } catch (error) { await writes; await handle.write(`\nFAILED: ${error.message}\n`); throw Error(`${label} failed; log: ${logfile}\n${error.message.slice(-3000)}`); }
      finally { try { await writes; } finally { await handle.close(); } }
    };
    const git = (args, cwd = state.worktree) => command('git', 'git', args, cwd);
    const gh = (args, label = 'github') => command(label, 'gh', args[0] === 'api' ? args : [...args, '-R', repository]);
    const clean = async cwd => { if (await git(['status', '--porcelain', '--untracked-files=all'], cwd)) throw Error(`Working tree is not clean: ${cwd}`); };
    const source = async () => {
      await clean(state.worktree);
      if (await git(['rev-parse', 'HEAD']) !== state.commit) throw Error('Validation worktree commit changed');
      if ((await json(path.join(state.worktree, 'package.json'))).version !== state.version) throw Error('Version differs from selected commit');
    };
    const publicCheck = async () => {
      if (await git(['config', '--local', '--get', 'multiplane.publicExport'], state.publicRepo) !== '1') throw Error('Public export marker missing');
      const remote = await git(['remote', 'get-url', 'origin'], state.publicRepo);
      if (!['https://github.com/' + repository, 'https://github.com/' + repository + '.git', 'git@github.com:' + repository + '.git'].includes(remote)) throw Error('Unexpected public remote');
      if (await git(['branch', '--show-current'], state.publicRepo) !== 'main') throw Error('Public checkout must be on main');
    };
    const boundary = async () => checkDesignFiles((await git(['ls-tree', '-rz', '--name-only', 'HEAD', '--', 'app/design'], state.publicRepo)).split('\0').filter(Boolean));
    const rollback = async () => {
      const head = await git(['rev-parse', 'HEAD'], state.publicRepo);
      if (head !== state.exportBase) {
        if (await git(['rev-parse', 'HEAD^'], state.publicRepo) !== state.exportBase) throw Error('Unexpected public history; refusing rollback');
        const remote = await git(['ls-remote', 'origin', 'refs/heads/main'], state.publicRepo);
        if (!remote.startsWith(state.exportBase + '\t')) throw Error('Remote changed; refusing rollback');
      }
      await git(['reset', '--hard', state.exportBase], state.publicRepo);
      state.exportPending = false; delete state.publicCommit; await save();
    };
    const waitRuns = async () => {
      const pending = new Set(['ci.yml', 'release.yml']);
      for (const workflow of pending) if (!state.runs[workflow]) throw Error(`Missing run: ${workflow}`);
      for (let attempt = 0; attempt < 360; attempt++) {
        for (const workflow of pending) {
          const id = state.runs[workflow];
          const result = JSON.parse(await gh(['run', 'view', String(id), '--json', 'headSha,status,conclusion,jobs,url'], `run-${id}`));
          if (result.headSha !== state.publicCommit) throw Error(`Wrong commit for run ${id}`);
          if (result.status === 'completed' && result.conclusion === 'success') pending.delete(workflow);
          else if (result.status === 'completed' || attempt === 359) {
            const failed = result.jobs?.filter(job => job.conclusion !== 'success' && job.conclusion !== 'skipped').map(job => job.name).join(', ');
            try { await gh(['run', 'view', String(id), '--log-failed'], `run-${id}-failed`); } catch { /* The run status remains the authoritative failure. */ }
            throw Error(`CI failed or timed out: ${id}; jobs: ${failed || result.conclusion}; ${result.url}; logs: ${path.join(directory, 'logs')}`);
          }
        }
        if (!pending.size) return;
        await sleep(15000);
      }
    };
    const actions = {
      async prepare() {
        const commit = await git(['rev-parse', '--verify', `${options.commit ?? state.commit ?? 'main'}^{commit}`], root);
        if (state.commit && state.commit !== commit) throw Error('Selected commit changed; use a new output directory');
        state.commit = commit; await save();
        if (!await exists(state.worktree)) await git(['worktree', 'add', '--detach', state.worktree, commit], root);
        const registered = await git(['worktree', 'list', '--porcelain'], root);
        if (!registered.replaceAll('\\', '/').includes(`worktree ${state.worktree.replaceAll('\\', '/')}\n`)) throw Error('Not a registered worktree');
        if (await git(['branch', '--show-current'])) throw Error('Validation requires a detached worktree');
        await source();
        for (const base of [state.worktree, path.join(state.worktree, 'app')]) {
          const modules = path.join(base, 'node_modules');
          if (await exists(modules) && (await lstat(modules)).isSymbolicLink()) throw Error(`Dependencies must be locally installed: ${modules}`);
          await command(base === state.worktree ? 'prepare-root' : 'prepare-app', 'npm', ['ci'], base);
        }
        await source();
      },
      async verify() {
        await source();
        if ((await lstat(path.join(state.worktree, 'app/node_modules'))).isSymbolicLink()) throw Error('app/node_modules cannot be linked');
        state.verified ??= [];
        for (const [label, file, args] of [
          ['verify-full', 'npm', ['run', 'test:full']], ['verify-app', 'npm', ['--prefix', 'app', 'test']],
          ['verify-package', 'npm', ['--prefix', 'app', 'run', 'dist']],
          ['verify-hosted', process.execPath, ['app/tools/verify-hosted.mjs']], ['verify-release', 'npm', ['run', 'release:check']],
        ]) {
          if (state.verified.includes(label)) { log(`${label}: already passed for ${state.commit}`); continue; }
          state.verifying = label; await save();
          await command(label, file, args);
          state.verified.push(label); delete state.verifying; await save();
        }
        await source();
      },
      async export() {
        await source(); await publicCheck();
        if (state.exportPending) await rollback();
        await clean(state.publicRepo);
        state.exportBase = await git(['rev-parse', 'HEAD'], state.publicRepo);
        if (!(await git(['ls-remote', 'origin', 'refs/heads/main'], state.publicRepo)).startsWith(state.exportBase + '\t')) throw Error('Public main must start at remote main');
        state.exportPending = true; await save();
        try {
          await command('export-public', 'npm', ['run', 'export:public', '--', state.publicRepo, '--message', options.message ?? `Release ${state.version}`]);
          await clean(state.publicRepo); await boundary();
          state.publicCommit = await git(['rev-parse', 'HEAD'], state.publicRepo);
          if (await git(['rev-parse', 'HEAD^'], state.publicRepo) !== state.exportBase) throw Error('Export must append exactly one commit');
          // Clear the rollback marker atomically with the completed-step record below.
        } catch (error) {
          try { await rollback(); } catch (rollbackError) { throw Error(`${error.message}\nRollback stopped: ${rollbackError.message}`); }
          throw error;
        }
      },
      async push() {
        await publicCheck(); await clean(state.publicRepo); await boundary();
        if (await git(['rev-parse', 'HEAD'], state.publicRepo) !== state.publicCommit) throw Error('Public commit changed');
        await git(['push', 'origin', 'HEAD:refs/heads/main'], state.publicRepo);
        if (!(await git(['ls-remote', 'origin', 'refs/heads/main'], state.publicRepo)).startsWith(state.publicCommit + '\t')) throw Error('Remote main differs');
        if (!state.dispatchStarted) {
          state.dispatchStarted = new Date().toISOString(); await save();
          const dispatched = await gh(['workflow', 'run', 'release.yml', '--ref', 'main'], 'dispatch-release');
          const id = dispatched.match(/https:\/\/github\.com\/LBEILC\/Multiplane\/actions\/runs\/(\d+)/)?.[1];
          if (id) { state.runs['release.yml'] = Number(id); await save(); }
        }
        for (const workflow of ['ci.yml', 'release.yml']) {
          if (state.runs[workflow]) continue;
          for (let attempt = 0; attempt < 40; attempt++) {
            const runs = JSON.parse(await gh(['run', 'list', '--workflow', workflow, '--commit', state.publicCommit, '--branch', 'main', '--event', workflow === 'ci.yml' ? 'push' : 'workflow_dispatch', '--limit', '100', '--json', 'databaseId,headSha,createdAt']));
            const matches = runs.filter(item => item.headSha === state.publicCommit && (workflow === 'ci.yml' || item.createdAt >= state.dispatchStarted.slice(0, 19) + 'Z'));
            if (matches.length === 1) { state.runs[workflow] = matches[0].databaseId; await save(); break; }
            if (matches.length > 1) throw Error(`Ambiguous ${workflow} runs; inspect saved state`);
            await sleep(3000);
          }
          if (!state.runs[workflow]) throw Error(`No ${workflow} run found; inspect workflow dispatch before retrying`);
        }
        await waitRuns();
      },
      async collect() {
        await waitRuns();
        // A fresh attempt avoids mixing partial downloads or stale installer files.
        const download = await mkdtemp(path.join(directory, 'artifacts-'));
        await gh(['run', 'download', String(state.runs['release.yml']), '--pattern', 'installer-*', '--dir', download], 'download');
        const files = [];
        async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files.push(file); } }
        await walk(download);
        const final = path.join(directory, 'final'); await mkdir(final, { recursive: true });
        for (const name of artifactNames(state.version)) {
          const found = files.filter(file => path.basename(file) === name);
          if (found.length !== 1) throw Error(`Expected one artifact ${name}, found ${found.length}`);
          await copyFile(found[0], path.join(final, name));
        }
        await command('verify-update-artifacts', process.execPath, ['app/tools/verify-update-artifacts.mjs', final]);
        state.hashes = await checkArtifacts(final, state.version);
        await source();
        await copyFile(path.join(state.worktree, 'docs/release-notes', `${state.version}.json`), path.join(final, 'release-notes.json'));
        state.hashes['release-notes.json'] = digest(await readFile(path.join(final, 'release-notes.json')));
        const table = '| File | SHA-256 |\n|---|---|\n' + Object.entries(state.hashes).map(([name, hash]) => `| ${name} | \`${hash}\` |`).join('\n') + '\n';
        await writeFile(path.join(directory, 'SHA256.md'), table); log(table);
      },
      async draft() {
        await waitRuns();
        const final = path.join(directory, 'final');
        const hashes = await checkArtifacts(final, state.version);
        hashes['release-notes.json'] = digest(await readFile(path.join(final, 'release-notes.json')));
        if (JSON.stringify(hashes) !== JSON.stringify(state.hashes)) throw Error('Collected artifacts changed');
        if (!(await readFile(state.notes, 'utf8')).trim()) throw Error('Release notes are empty');
        const releases = JSON.parse(await gh(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'])).flat();
        let draft = releases.find(item => item.tag_name === `v${state.version}`);
        if (draft && (!draft.draft || draft.target_commitish !== state.publicCommit)) throw Error('Existing release is not the matching draft');
        if (!draft) {
          await gh(['release', 'create', `v${state.version}`, '--draft', '--target', state.publicCommit, '--title', `Multiplane ${state.version}`, '--notes-file', state.notes, ...Object.keys(hashes).map(name => path.join(final, name))], 'draft-create');
        } else {
          const missing = Object.keys(hashes).filter(name => !draft.assets.some(asset => asset.name === name));
          if (missing.length) await gh(['release', 'upload', `v${state.version}`, ...missing.map(name => path.join(final, name))], 'draft-upload');
        }
        draft = JSON.parse(await gh(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'])).flat().find(item => item.tag_name === `v${state.version}`);
        if (!draft?.draft || draft.target_commitish !== state.publicCommit || draft.body !== await readFile(state.notes, 'utf8') || draft.assets.length !== 7 || draft.assets.some(asset => asset.digest !== `sha256:${hashes[asset.name]}`)) throw Error('Draft contents or uploaded digests differ');
        state.draftUrl = draft.html_url; log(draft.html_url);
      },
    };
    const start = options.step ?? options.from ?? steps.find(step => !state.completed.includes(step));
    if (!start) return state;
    const end = options.step ?? options.to ?? 'draft';
    if (!steps.includes(start) || !steps.includes(end) || steps.indexOf(end) < steps.indexOf(start)) throw Error('Invalid step range');
    if (options.commit && state.commit && await git(['rev-parse', '--verify', `${options.commit}^{commit}`], root) !== state.commit) throw Error('Selected commit differs from saved state');
    for (const step of steps.slice(steps.indexOf(start), steps.indexOf(end) + 1)) {
      const index = steps.indexOf(step);
      if (steps.slice(0, index).some(previous => !state.completed.includes(previous))) throw Error(`Prerequisite missing for ${step}`);
      if (state.completed.includes(step)) { log(`${step}: already completed`); continue; }
      state.current = step; state.status = 'running'; delete state.error; await save();
      try { await actions[step](); if (step === 'export') state.exportPending = false; state.completed.push(step); state.status = 'passed'; await save(); }
      catch (error) { state.status = 'failed'; state.error = error.message; await save(); throw error; }
    }
    return state;
  } finally { await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, keys = { version: 'version', commit: 'commit', worktree: 'worktree', 'public-repo': 'publicRepo', notes: 'notes', output: 'output', step: 'step', from: 'from', to: 'to', message: 'message' };
    const args = process.argv.slice(2);
    if (args.includes('--help')) console.log('npm run release -- --version <version> [--commit main] [--step prepare|verify|export|push|collect|draft | --from <step> --to <step>] [--output <directory>] [--worktree <directory>] [--public-repo <directory>] [--notes <file>] [--message <public commit message>]\nDefault: resume the first unfinished step through draft. Use --to verify for local validation only.');
    else {
      for (let i = 0; i < args.length; i += 2) { const key = keys[args[i]?.slice(2)]; if (!args[i]?.startsWith('--') || !key || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Invalid argument; use --help'); options[key] = args[i + 1]; }
      if (options.step && (options.from || options.to)) throw Error('--step cannot be combined with --from/--to');
      await release(options);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
