import { lstat, readdir, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Do not follow symlinks (a DMG may link to /Applications).
// Ignore access times, which our own reads can change.
export async function fileSnapshot(root) {
  const entries = [];
  async function visit(relative) {
    const file = path.join(root, relative), info = await lstat(file);
    const entry = { path: relative, mode: info.mode, mtime: info.mtimeMs, ctime: info.ctimeMs };
    if (info.isSymbolicLink()) entry.link = await readlink(file);
    else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      entry.size = info.size; entry.sha256 = hash.digest('hex');
    }
    entries.push(entry);
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
  }
  await visit('');
  return entries;
}
