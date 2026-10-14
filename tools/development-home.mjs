import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function isolateDevelopmentHome(name, { args = process.argv.slice(2), env = process.env, directory = root } = {}) {
  // Reading or writing the real home requires an explicit command-line opt-in.
  if (args.includes('--use-user-home')) return env.MULTIPLANE_HOME;
  const home = path.join(directory, 'out', name, 'home');
  mkdirSync(home, { recursive: true });
  env.MULTIPLANE_HOME = home;
  return home;
}
