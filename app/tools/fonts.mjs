import { readFile, writeFile, mkdir, rm, rename, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequester } from './download.mjs';
export const fontFile = 'build/fonts/MiSansVF.ttf';
export const fontHash = '5daf8d5447bfd423cfdec94a0e07c53b205892223ccc6ea21b7b8a37248b44d9';
export const downloadPage = 'https://hyperos.mi.com/font/download';
export async function checkFont(file = fontFile) {
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('MiSans SHA-256 mismatch');
  return bytes;
}
// Extract only the named entry; never use archive paths as filesystem targets.
function zipDirectory(bytes, offset = 0) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw Error('Official font archive is not a valid ZIP');
  let at = bytes.readUInt32LE(end + 16) - offset;
  if (at < 0) throw Error('Official font archive directory is outside the downloaded range');
  const entries = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw Error('Invalid ZIP directory');
    const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString('utf8');
    entries.push({ name, local: bytes.readUInt32LE(at + 42), size: bytes.readUInt32LE(at + 20), method: bytes.readUInt16LE(at + 10) });
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}
function unpack(bytes, method) {
  if (method === 0) return bytes;
  if (method === 8) return inflateRawSync(bytes);
  throw Error('Unsupported compression method in official font archive');
}
function zipEntry(bytes, pattern) {
  const entry = zipDirectory(bytes).find(e => pattern.test(e.name));
  if (!entry) throw Error('Required font file is missing from the official archive');
  const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
  return unpack(bytes.subarray(start, start + entry.size), entry.method);
}
async function remoteEntry(request, url, pattern) {
  // Fetch only the directory and selected entry when range requests are supported.
  const tail = await request(url, { Range: 'bytes=-65557' });
  const bytes = tail.bytes;
  if (tail.status === 200) return zipEntry(bytes, pattern);
  const offset = Number(tail.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1]);
  if (!Number.isFinite(offset)) throw Error('Invalid range returned by official download');
  const entry = zipDirectory(bytes, offset).find(e => pattern.test(e.name));
  if (!entry) throw Error('Required font file is missing from the official archive');
  const headerResponse = await request(url, { Range: `bytes=${entry.local}-${entry.local + 29}` });
  if (headerResponse.status !== 206) { throw Error('Official download no longer supports range requests'); }
  const header = headerResponse.bytes;
  if (header.readUInt32LE(0) !== 0x04034b50) throw Error('Invalid ZIP local header');
  const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const response = await request(url, { Range: `bytes=${start}-${start + entry.size - 1}` });
  if (response.status !== 206) { throw Error('Official download no longer supports range requests'); }
  return unpack(response.bytes, entry.method);
}
export async function prepareFont({ file = fontFile, cacheOnly = process.env.MULTIPLANE_FONT_CACHE_ONLY === '1', ...network } = {}) {
  try { await checkFont(file); console.log('Using verified MiSans cache.'); return; }
  catch (error) { if (cacheOnly) throw new Error('Cached MiSans verification failed: ' + error.message, { cause: error }); }
  const request = createRequester(network);
  const html = await request(downloadPage).then(r => r.bytes.toString('utf8'));
  let source = html;
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const url = new URL(match[1], downloadPage);
    if (url.hostname === 'hyperos.mi.com') source += await request(url).then(r => r.bytes.toString('utf8'));
  }
  const match = [...source.matchAll(/["']([^"']*MiSans(?:%20| )[Vv][Ff][^"']*\.ttf|[^"']*MiSans\.zip)["']/g)][0];
  // The official page builds the URL from its origin, directory and downloadLink.
  const directory = source.match(/window\.location\.origin\+["']([^"']+)["']/)?.[1];
  const dynamic = directory && /downloadLink:["']MiSans["']/.test(source) && source.includes('.concat(e.downloadLink,".zip")') ? `${directory}/MiSans.zip` : null;
  if (!match && !dynamic) throw Error('No recognized MiSans archive on the official download page; check for site changes');
  let url = new URL(match?.[1] || dynamic, downloadPage);
  const fontPattern = /(?:^|\/)MiSans ?VF\.ttf$/;
  let bytes = url.pathname.endsWith('.ttf') ? (await request(url)).bytes : await remoteEntry(request, url, fontPattern);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash && directory && source.includes('/MiSans_Global_ALL.zip')) {
    console.log('The standalone font version has changed; checking the full official archive for the pinned version.');
    url = new URL(`${directory}/MiSans_Global_ALL.zip`, downloadPage);
    bytes = zipEntry(await remoteEntry(request, url, /(?:^|\/)MiSans\.zip$/), fontPattern);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('Font SHA-256 differs from the pinned version; refusing to use it');
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(file), '.misans-'));
  try {
    const pending = path.join(temporary, 'MiSansVF.ttf');
    await writeFile(pending, bytes, { flag: 'wx' });
    await checkFont(pending);
    await rename(pending, file);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  console.log(JSON.stringify({ source: String(url), version: '4.003', sha256: fontHash, bytes: bytes.length }));
}
export async function copyFont(out, source = fontFile) {
  const target = path.join(out, 'fonts', 'MiSansVF.ttf');
  try { const bytes = await checkFont(source); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return true; }
  catch (error) { await rm(target, { force: true }); console.warn(`Warning: MiSans is missing or has an incorrect SHA-256; using system fonts. Run npm run fonts. ${error.code || error.message}`); return false; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareFont({ cacheOnly: process.argv.includes('--cache-only') || process.env.MULTIPLANE_FONT_CACHE_ONLY === '1' });
