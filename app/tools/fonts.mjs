import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const fontFile = 'build/fonts/MiSansVF.ttf';
export const fontHash = '5daf8d5447bfd423cfdec94a0e07c53b205892223ccc6ea21b7b8a37248b44d9';
export const downloadPage = 'https://hyperos.mi.com/font/download';
export async function checkFont(file = fontFile) {
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('MiSans SHA-256 不符');
  return bytes;
}
// Extract only the named entry; never use archive paths as filesystem targets.
function zipDirectory(bytes, offset = 0) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw Error('官方字体包不是有效的 ZIP');
  let at = bytes.readUInt32LE(end + 16) - offset;
  if (at < 0) throw Error('官方字体包目录超过读取范围');
  const entries = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw Error('ZIP 目录无效');
    const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString('utf8');
    entries.push({ name, local: bytes.readUInt32LE(at + 42), size: bytes.readUInt32LE(at + 20), method: bytes.readUInt16LE(at + 10) });
    at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}
function unpack(bytes, method) {
  if (method === 0) return bytes;
  if (method === 8) return inflateRawSync(bytes);
  throw Error('官方字体包使用了不支持的压缩方式');
}
function zipEntry(bytes, pattern) {
  const entry = zipDirectory(bytes).find(e => pattern.test(e.name));
  if (!entry) throw Error('官方包没有所需的字体文件');
  const start = entry.local + 30 + bytes.readUInt16LE(entry.local + 26) + bytes.readUInt16LE(entry.local + 28);
  return unpack(bytes.subarray(start, start + entry.size), entry.method);
}
async function request(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
  return response;
}
async function remoteEntry(url, pattern) {
  // Fetch only the directory and selected entry when range requests are supported.
  const tail = await request(url, { Range: 'bytes=-65557' });
  const bytes = Buffer.from(await tail.arrayBuffer());
  if (tail.status === 200) return zipEntry(bytes, pattern);
  const offset = Number(tail.headers.get('content-range')?.match(/^bytes (\d+)-/)?.[1]);
  if (!Number.isFinite(offset)) throw Error('官方下载返回了无效的范围');
  const entry = zipDirectory(bytes, offset).find(e => pattern.test(e.name));
  if (!entry) throw Error('官方包没有所需的字体文件');
  const headerResponse = await request(url, { Range: `bytes=${entry.local}-${entry.local + 29}` });
  if (headerResponse.status !== 206) { await headerResponse.body.cancel(); throw Error('官方下载不再支持范围读取'); }
  const header = Buffer.from(await headerResponse.arrayBuffer());
  if (header.readUInt32LE(0) !== 0x04034b50) throw Error('ZIP 文件头无效');
  const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const response = await request(url, { Range: `bytes=${start}-${start + entry.size - 1}` });
  if (response.status !== 206) { await response.body.cancel(); throw Error('官方下载不再支持范围读取'); }
  return unpack(Buffer.from(await response.arrayBuffer()), entry.method);
}
export async function prepareFont() {
  const html = await (await request(downloadPage)).text();
  let source = html;
  for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
    const url = new URL(match[1], downloadPage);
    if (url.hostname === 'hyperos.mi.com') source += await (await request(url)).text();
  }
  const match = [...source.matchAll(/["']([^"']*MiSans(?:%20| )[Vv][Ff][^"']*\.ttf|[^"']*MiSans\.zip)["']/g)][0];
  // The official page builds the URL from its origin, directory and downloadLink.
  const directory = source.match(/window\.location\.origin\+["']([^"']+)["']/)?.[1];
  const dynamic = directory && /downloadLink:["']MiSans["']/.test(source) && source.includes('.concat(e.downloadLink,".zip")') ? `${directory}/MiSans.zip` : null;
  if (!match && !dynamic) throw Error('官方下载页未提供可识别的 MiSans 包，请检查站点变更');
  let url = new URL(match?.[1] || dynamic, downloadPage);
  const fontPattern = /(?:^|\/)MiSans ?VF\.ttf$/;
  let bytes = url.pathname.endsWith('.ttf') ? Buffer.from(await (await request(url)).arrayBuffer()) : await remoteEntry(url, fontPattern);
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash && directory && source.includes('/MiSans_Global_ALL.zip')) {
    console.log('单独下载包的字体版本已变化，检查同页官方全量包中的指定版本。');
    url = new URL(`${directory}/MiSans_Global_ALL.zip`, downloadPage);
    bytes = zipEntry(await remoteEntry(url, /(?:^|\/)MiSans\.zip$/), fontPattern);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== fontHash) throw Error('字体版本的 SHA-256 与定稿不一致，拒绝使用');
  await mkdir(path.dirname(fontFile), { recursive: true });
  await writeFile(fontFile, bytes);
  console.log(JSON.stringify({ source: String(url), version: '4.003', sha256: fontHash, bytes: bytes.length }));
}
export async function copyFont(out, source = fontFile) {
  const target = path.join(out, 'fonts', 'MiSansVF.ttf');
  try { const bytes = await checkFont(source); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return true; }
  catch (error) { await rm(target, { force: true }); console.warn(`警告：MiSans 字体缺失或 SHA-256 不符，使用系统字体；运行 npm run fonts。${error.code || error.message}`); return false; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareFont();
