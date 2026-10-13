import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm, run } from './process.mjs';

const [name, cwd, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '') || !cwd || !command) throw Error('Usage: ci-run <log-name> <cwd> <npm|node|executable> [args]');
const minutes = process.env.MULTIPLANE_CI_STEP_TIMEOUT_MINUTES ?? '30';
const timeout = Number(minutes) * 60000;
if (!/^\d+(?:\.\d+)?$/.test(minutes) || !Number.isFinite(timeout) || timeout < 1 || timeout > 2147483647) {
  throw Error('Invalid MULTIPLANE_CI_STEP_TIMEOUT_MINUTES: expected positive decimal minutes (1 ms to 2147483647 ms)');
}
// Resolve logs from the repository, independent of the child working directory.
const logs = fileURLToPath(new URL('../out/ci/', import.meta.url));
await mkdir(logs, { recursive: true });
const log = path.join(logs, name + '.log'); await writeFile(log, '');
// Persist every chunk so failed or interrupted jobs retain partial logs.
const onOutput = (bytes, stream) => { appendFileSync(log, bytes); process[stream].write(bytes); };
try {
  const options = { cwd, capture: true, onOutput, timeout, killTree: true,
    timeoutMessage: elapsed => `Step ${name} timed out after ${Number((elapsed / 60000).toFixed(4))} min (limit ${Number(minutes)} min)` };
  await (command === 'npm' ? npm(args, options) : run(command === 'node' ? process.execPath : command, args, options));
} catch (error) {
  onOutput(Buffer.from(error.message + '\n'), 'stderr');
  process.exitCode = 1;
}
