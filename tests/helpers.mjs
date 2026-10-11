import { nativeRealpathSync } from '../tools/native-realpath.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Absolute prefixes preserve fixtures that need a specific parent directory.
// Resolve after creation so all derived expectations use the filesystem's path.
export function createTempDirectory(prefix = 'multiplane-test-') {
  return nativeRealpathSync(mkdtempSync(path.isAbsolute(prefix) ? prefix : path.join(os.tmpdir(), prefix)));
}

import { spawn } from 'node:child_process';

export function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
