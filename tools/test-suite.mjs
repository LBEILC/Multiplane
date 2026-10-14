import { availableParallelism } from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
// Each renderer test may itself launch two Chromium workers plus FFmpeg.
export const concurrency = cores => Math.max(1, Math.min(8, Math.floor(cores / 4)));
// Real deadline/process-liveness checks must run without renderer load.
export const serialFiles = ['ci-run.test.mjs', 'owned-process.test.mjs', 'resources.test.mjs', 'hosted.test.mjs'];

// Start the longest independent files first to avoid a serial tail.
const heavyFiles = ['static-reuse.test.mjs', 'adaptive-blur.test.mjs', 'alpha.test.mjs', 'integration.test.mjs',
  'setup-cli.test.mjs', 'lint.test.mjs', 'output-check.test.mjs', 'draft.test.mjs',
  'user-home.test.mjs', 'jobs.test.mjs', 'browser-recovery.test.mjs', 'frame-rate.test.mjs'];
export async function schedule(files, workers, execute) {
  const parallel = files.filter(file => !serialFiles.includes(file)).sort((a, b) => {
    const rank = file => heavyFiles.includes(file) ? heavyFiles.indexOf(file) : heavyFiles.length;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, parallel.length) }, async () => {
    while (next < parallel.length) await execute(parallel[next++]);
  }));
  for (const file of serialFiles.filter(file => files.includes(file))) await execute(file);
}

export async function runSuite({ full = false, logDirectory } = {}) {
  const started = performance.now();
  const files = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
  await mkdir(path.join(root, 'out/tests'), { recursive: true });
  const directory = logDirectory ? path.resolve(logDirectory) : await mkdtemp(path.join(root, 'out/tests/', full ? 'full-' : 'daily-'));
  await mkdir(directory, { recursive: true });
  const results = [];
  const workers = concurrency(availableParallelism());
  console.log(`Renderer ${full ? 'full' : 'daily'} suite: ${files.length} files, concurrency ${workers}; logs: ${path.relative(root, directory)}`);
  async function execute(file) {
    const start = performance.now(), stem = file.replace('.test.mjs', '');
    const tap = path.join(directory, stem + '.tap'), events = path.join(directory, stem + '.jsonl');
    const args = ['--import', './tests/test-home.mjs', '--test', '--test-reporter=tap',
      '--test-reporter=./tools/test-timings.mjs', `--test-reporter-destination=${tap}`,
      `--test-reporter-destination=${events}`, path.join('tests', file)];
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
      env: { ...process.env, MULTIPLANE_TEST_SUITE: full ? 'full' : 'daily' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.on('data', data => { diagnostic += data; });
    child.stderr.on('data', data => { diagnostic += data; });
    const code = await new Promise(resolve => {
      child.once('error', error => { diagnostic += error.stack; resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    const durationMs = performance.now() - start;
    await writeFile(path.join(directory, stem + '.log'), diagnostic);
    const output = await readFile(tap, 'utf8').catch(() => '');
    // Persist complete output before presenting or analyzing it.
    process.stdout.write(output + diagnostic);
    console.log(`${file}: ${(durationMs / 1000).toFixed(2)}s; exit ${code}`);
    results.push({ file, code, durationMs });
  }
  await schedule(files, workers, execute);
  const summary = { suite: full ? 'full' : 'daily', concurrency: workers,
    durationMs: performance.now() - started, files: results.sort((a, b) => a.file.localeCompare(b.file)) };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Suite: ${(summary.durationMs / 1000).toFixed(2)}s; ${results.filter(item => item.code !== 0).length} failed files.`);
  return results.every(item => item.code === 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--full' && !arg.startsWith('--log-dir='))) throw Error('Usage: test-suite.mjs [--full] [--log-dir=path]');
  if (!await runSuite({ full: args.includes('--full'), logDirectory: args.find(arg => arg.startsWith('--log-dir='))?.slice(10) })) process.exitCode = 1;
}
