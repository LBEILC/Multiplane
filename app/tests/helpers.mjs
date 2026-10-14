import { nativeRealpathSync } from '../../tools/native-realpath.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A passing test process removes every directory it created; a failing one
// leaves them in place as evidence. Crashes and kills skip the exit event.
const created = [];
process.once('exit', code => {
  if (code !== 0 || (process.exitCode ?? 0) !== 0) return;
  for (const directory of created.reverse()) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* still in use; leave it */ }
  }
});

// Absolute prefixes preserve fixtures that need a specific parent directory.
// Resolve after creation so all derived expectations use the filesystem's path.
export function createTempDirectory(prefix = 'multiplane-test-') {
  const directory = nativeRealpathSync(mkdtempSync(path.isAbsolute(prefix) ? prefix : path.join(os.tmpdir(), prefix)));
  created.push(directory);
  return directory;
}
