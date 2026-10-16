import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const app = fileURLToPath(new URL('../', import.meta.url));
const f = n => Number(n.toFixed(10));
export const arch = (left, right, cy, bottom, stroke) => {
  const r = (right - left) / 2, inner = r - stroke;
  return `M${left} ${bottom}V${cy}A${r} ${r} 0 0 1 ${right} ${cy}V${bottom}H${right - stroke}V${cy}A${inner} ${inner} 0 0 0 ${left + stroke} ${cy}V${bottom}Z`;
};

export function markPath() {
  // Boolean intersection of the rear arch with the half-plane x >= 60.
  const outerY = 54 - Math.sqrt(25 ** 2 - 7 ** 2);
  const innerY = 54 - Math.sqrt(11 ** 2 - 7 ** 2);
  const back = `M60 ${f(outerY)}A25 25 0 0 1 67 29A25 25 0 0 1 92 54V88H78V54A11 11 0 0 0 67 43A11 11 0 0 0 60 ${f(innerY)}Z`;
  return arch(8, 56, 40, 88, 14) + back;
}

export function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(i => i.png)]);
}

export function icns(images) {
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = images.filter(image => types[image.size]).map(({ size, png }) => {
    const header = Buffer.alloc(8); header.write(types[size]); header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

export async function generateBrand() {
  const design = path.join(app, 'design/icons'), build = path.join(app, 'build/icons');
  await mkdir(design, { recursive: true }); await mkdir(build, { recursive: true });
  const d = markPath();
  const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor"><path d="${d}"/></svg>\n`;
  // Visible bounds are [8,16]–[92,88]; fit their width to 64 and center them.
  const scale = 64 / 84;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#1E1C1A"/><path fill="#F4F1EC" transform="translate(${f(50 - 50 * scale)} ${f(50 - 52 * scale)}) scale(${f(scale)})" d="${d}"/></svg>\n`;
  await writeFile(path.join(design, 'mark.svg'), mark); await writeFile(path.join(design, 'app.svg'), tile);
  const traySvg = mark.replace('currentColor', '#000000');
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32], ['tray.png', 32]]) await writeFile(path.join(build, name), await sharp(Buffer.from(traySvg)).resize(size, size).png().toBuffer());
  const busy = tile.replace('</svg>', '<circle cx="81" cy="81" r="16" fill="#7fa7d1" stroke="#1E1C1A" stroke-width="5"/></svg>');
  const busyImages = [];
  for (const size of [16,24,32,48,64,128,256]) {
    const png = await sharp(Buffer.from(busy)).resize(size,size).png().toBuffer();
    await writeFile(path.join(build, 'tray-busy-'+size+'.png'),png); busyImages.push({size,png});
  }
  await writeFile(path.join(build,'tray-busy.ico'),ico(busyImages));
  const busyTemplate = traySvg.replace('</svg>', '<circle cx="84" cy="84" r="16" fill="black"/></svg>');
  for (const [name,size] of [['trayBusyTemplate.png',16],['trayBusyTemplate@2x.png',32]]) await writeFile(path.join(build,name),await sharp(Buffer.from(busyTemplate)).resize(size,size).png().toBuffer());
  const images = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = await sharp(Buffer.from(tile), { density: size * 72 / 100 }).resize(size, size).png().toBuffer();
    await writeFile(path.join(build, `app-${size}.png`), png); images.push({ size, png });
  }
  await writeFile(path.join(build, 'app.ico'), ico(images.filter(i => i.size <= 256)));
  const macImages = [];
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const inset = Math.round(size * .1), content = size - inset * 2;
    const png = await sharp(Buffer.from(tile), { density: size * 72 / 100 }).resize(content, content)
      .extend({ top: inset, bottom: inset, left: inset, right: inset, background: '#00000000' }).png().toBuffer();
    macImages.push({ size, png });
  }
  await writeFile(path.join(build, 'app.icns'), icns(macImages));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateBrand();
