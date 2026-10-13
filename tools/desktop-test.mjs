import { nativeRealpath } from './native-realpath.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm, run } from './process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Only this step's children see the test cache; never export it to later steps.
const cache = await nativeRealpath(await mkdtemp(path.join(os.tmpdir(), 'multiplane-desktop-test-')));
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache };
console.log(`Desktop test browser cache: ${cache}`);
await run(process.execPath, ['node_modules/playwright/cli.js', 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], { cwd: root, env });
const timeout = 30 * 60000;
await npm(['test'], { cwd: path.join(root, 'app'), env, timeout, killTree: true,
  timeoutMessage: elapsed => `Desktop npm test timed out after ${Number((elapsed / 60000).toFixed(4))} min (limit ${timeout / 60000} min)` });
