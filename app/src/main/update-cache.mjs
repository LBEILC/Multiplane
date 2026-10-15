import { createReadStream } from 'node:fs';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const markerName = 'blockmap-pair.json';
async function digest(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

// electron-updater 6.8.9 promotes the new blockmap at download completion,
// but NSIS replaces installer.exe only at installation. Verify the pair before
// trusting that map, including after a postponed or interrupted installation.
export async function prepareUpdateCache(cacheDir, logger) {
  const blockmap = path.join(cacheDir, 'current.blockmap');
  let marker;
  try { marker = JSON.parse(await readFile(path.join(cacheDir, markerName), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  try {
    const blockmapSha512 = await digest(blockmap);
    if (marker?.blockmapSha512 === blockmapSha512 && marker.installerSha512 === await digest(path.join(cacheDir, 'installer.exe'))) {
      logger.info('Cached blockmap matches installer.exe; using the verified pair');
      return;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A missing/unverified map is safe: upstream fetches the map for the running
  // version from its provider and retains its final installer SHA-512 check.
  await unlink(blockmap).catch(error => { if (error.code !== 'ENOENT') throw error; });
  logger.info('Cached blockmap pair is missing or unverified; fetching the previous version blockmap from the provider');
}

export async function recordUpdateCache(cacheDir, installer, logger) {
  if (!installer) return;
  try {
    const [installerSha512, blockmapSha512] = await Promise.all([digest(installer), digest(path.join(cacheDir, 'current.blockmap'))]);
    const target = path.join(cacheDir, markerName), temporary = target + '.tmp';
    await writeFile(temporary, JSON.stringify({ installerSha512, blockmapSha512 }) + '\n');
    await rename(temporary, target);
    logger.info('Recorded downloaded installer/blockmap pair; it becomes reusable after installation');
  } catch (error) {
    // Missing blockmaps/full-download-only servers must not block installation.
    logger.warn(`Could not record installer/blockmap pair: ${error.message}`);
  }
}
