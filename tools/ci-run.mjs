import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm, run } from './process.mjs';

const [name, cwd, command, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(name ?? '') || !cwd || !command) throw Error('Usage: ci-run <log-name> <cwd> <npm|node|executable> [args]');
// Resolve logs from the repository, independent of the child working directory.
const logs = fileURLToPath(new URL('../out/ci/', import.meta.url));
await mkdir(logs, { recursive: true });
const log = path.join(logs, name + '.log'); await writeFile(log, '');
// Persist every chunk so failed or interrupted jobs retain partial logs.
const onOutput = (bytes, stream) => { appendFileSync(log, bytes); process[stream].write(bytes); };
try {
  await (command === 'npm' ? npm(args, { cwd, capture: true, onOutput }) : run(command === 'node' ? process.execPath : command, args, { cwd, capture: true, onOutput }));
} catch (error) {
  onOutput(Buffer.from(error.message + '\n'), 'stderr');
  process.exitCode = 1;
}
