import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Desktop bundles keep the tested subset separate from optional npm peers.
export async function resolveThree() {
  let root = fileURLToPath(new URL('../vendor/three/', import.meta.url));
  let source = 'bundled';
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    root = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('three'))));
    pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    source = 'project';
  }
  return { root, version: pkg.version, source };
}

export async function threeCheck() {
  try {
    const { root, version, source } = await resolveThree();
    await readFile(path.join(root, 'build/three.module.js'));
    return { name: 'three', ok: true, detail: `three.js ${version} is available (${source === 'bundled' ? 'bundled with software' : 'installed by project'}).` };
  } catch { return { name: 'three', ok: false, detail: 'Optional three.js is not installed.' }; }
}
