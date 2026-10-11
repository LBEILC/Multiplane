import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function findInstaller(directory, platform = process.platform) {
  const extension = { win32: '.exe', darwin: '.dmg', linux: '.AppImage' }[platform];
  if (!extension) throw Error(`Unsupported installer platform: ${platform}`);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(extension)).map(entry => entry.name).sort();
  if (files.length !== 1) throw Error(`Expected exactly one ${extension} installer in ${directory}; found ${files.length}: ${JSON.stringify(files)}`);
  return path.join(directory, files[0]);
}
