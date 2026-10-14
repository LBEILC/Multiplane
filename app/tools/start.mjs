import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { run } from '../../tools/process.mjs';
import { isolateDevelopmentHome } from '../../tools/development-home.mjs';
import { ensureElectron } from './electron.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
if (!process.argv.includes('--use-user-home')) {
  const home = isolateDevelopmentHome('app-development', { env, args: [] });
  const base = path.dirname(home);
  env.MULTIPLANE_APP_DATA = path.join(base, 'desktop');
  env.MULTIPLANE_TEST_USER_HOME = path.join(base, 'user');
  for (const dir of [env.MULTIPLANE_APP_DATA, env.MULTIPLANE_TEST_USER_HOME]) await mkdir(dir, { recursive: true });
}
delete env.ELECTRON_RUN_AS_NODE;
const executable = await ensureElectron(app);
await run(process.execPath, ['tools/build.mjs'], { cwd: app, env });
const child = spawn(executable, [app], { cwd: app, env, shell: false, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
