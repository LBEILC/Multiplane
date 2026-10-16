import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

// Servers inherit the render's context; unrelated inspect/serve calls do not.
export const inputRecords = new AsyncLocalStorage();
const largeFiles = new WeakMap();
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function recordInput(file) {
  const record = inputRecords.getStore();
  if (!record) return;
  const info = await stat(file);
  // Large media stays streamed. Cache only its digest, never its body.
  if (info.size > 1024 * 1024) {
    let cache = largeFiles.get(record);
    if (!cache) largeFiles.set(record, cache = new Map());
    const previous = cache.get(file);
    const sha256 = previous?.size === info.size && previous.mtimeMs === info.mtimeMs
      ? previous.sha256 : await fileDigest(file);
    cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    record(file, { bytes: info.size, sha256 });
    return;
  }
  const bytes = await readFile(file);
  record(file, { bytes: bytes.length, sha256: digest(bytes) });
  return bytes;
}
