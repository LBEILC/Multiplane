import { nativeRealpath } from '../../tools/native-realpath.mjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function verifyRendererBundle(source, destination) {
  let files = 0, bytes = 0;
  async function walk(prefix = '') {
    for (const entry of await readdir(path.join(source, prefix), { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) { await walk(relative); continue; }
      if (entry.isSymbolicLink()) {
        // npm creates executable shims as symlinks on POSIX systems.
        const resolved = await nativeRealpath(path.join(source, relative));
        const inside = path.relative(source, resolved);
        if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw Error(`Renderer symlink escapes bundle: ${relative}`);
      }
      if (/\.log$/.test(entry.name) || ['.gitkeep', '.DS_Store'].includes(entry.name)) continue;
      const original = await readFile(path.join(source, relative)), packed = await readFile(path.join(destination, relative));
      if (!original.equals(packed)) throw Error(`Bundled renderer differs: ${relative}`);
      files++; bytes += packed.length;
    }
  }
  await walk();
  const sourcePackage = JSON.parse(await readFile(path.join(source, 'package.json')));
  const summary = { version: sourcePackage.version, files, bytes, lockSha256: createHash('sha256').update(await readFile(path.join(destination, 'package-lock.json'))).digest('hex') };
  console.log('Bundled renderer verified:', JSON.stringify(summary)); return summary;
}
