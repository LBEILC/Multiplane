import path from 'node:path';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';

const nativeRealpath = promisify(realpath.native);

// Resolve aliases (including Windows 8.3 names) even for missing descendants.
export async function normalizeResourcePath(file) {
  const absolute = path.resolve(file);
  try { return await nativeRealpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await normalizeResourcePath(parent), path.basename(absolute));
  }
}

export function relativeResourcePath(root, target, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.relative(platform === 'win32' ? root.toLowerCase() : root,
    platform === 'win32' ? target.toLowerCase() : target);
}

export async function isInsideResourceRoot(root, target) {
  const [base, file] = await Promise.all([normalizeResourcePath(root), normalizeResourcePath(target)]);
  const relative = relativeResourcePath(base, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
