import { nativeRealpathSync } from '../../tools/native-realpath.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Absolute prefixes preserve fixtures that need a specific parent directory.
// Resolve after creation so all derived expectations use the filesystem's path.
export function createTempDirectory(prefix = 'multiplane-test-') {
  return nativeRealpathSync(mkdtempSync(path.isAbsolute(prefix) ? prefix : path.join(os.tmpdir(), prefix)));
}
