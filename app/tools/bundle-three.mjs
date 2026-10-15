import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function bundleThree(root, renderer) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const source = path.join(root, 'node_modules/three');
  const three = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (three.version !== pkg.devDependencies.three || three.version !== lock.packages['node_modules/three'].version) throw Error('Bundled three.js must match the tested, locked version');
  const target = path.join(renderer, 'vendor/three');
  await mkdir(target, { recursive: true });
  for (const name of ['build', 'examples/jsm', 'package.json', 'LICENSE']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(path.join(source, name), path.join(target, name), { recursive: true,
      filter: async file => (await stat(file)).isDirectory() || ['package.json', 'LICENSE'].includes(name) || file.endsWith('.js') });
  }
  return three.version;
}
