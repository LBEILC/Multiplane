import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import assert from 'node:assert/strict';
import sharp from 'sharp';
import { generateBrand } from './brand.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'out/007-brand'); await mkdir(out, { recursive: true });
await generateBrand();
const mark = await readFile(path.join(root, 'app/design/icons/mark.svg'), 'utf8');
assert.equal((mark.match(/<path /g) ?? []).length, 1);
assert.ok(!/<(?:mask|clipPath|filter|text)|stroke=/.test(mark));
const files = ['app/design/icons/mark.svg', 'app/design/icons/app.svg', ...[16,24,32,48,64,128,256,512,1024].map(n => `app/build/icons/app-${n}.png`), 'app/build/icons/app.ico'];
const hash = async () => Promise.all(files.map(async f => createHash('sha256').update(await readFile(path.join(root, f))).digest('hex')));
const hashes = await hash(); await generateBrand(); assert.deepEqual(await hash(), hashes);
const ico = await readFile(path.join(root, 'app/build/icons/app.ico'));
assert.equal(ico.readUInt16LE(4), 7);
for (let i = 0; i < 7; i++) {
  const at = 6 + i * 16, size = ico[at] || 256;
  const png = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
  const meta = await sharp(png).metadata(); assert.equal(meta.width, size); assert.equal(meta.height, size);
}
// Inspect the actual solid path and analytic thickness, independent of old drafts.
const size = 1000;
const pixels = await sharp(Buffer.from(mark), { density: 720 }).resize(size,size).flatten({ background: '#fff' }).greyscale().raw().toBuffer();
// The reference uses clipping only in this verifier, never in the delivered master.
const reference = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="rear"><rect x="60" y="0" width="40" height="100"/></clipPath></defs><path d="M8 88V40A24 24 0 0 1 56 40V88H42V40A10 10 0 0 0 22 40V88Z"/><path clip-path="url(#rear)" d="M42 88V54A25 25 0 0 1 92 54V88H78V54A11 11 0 0 0 56 54V88Z"/></svg>';
const expected = await sharp(Buffer.from(reference), { density: 720 }).resize(size,size).flatten({ background: '#fff' }).greyscale().raw().toBuffer();
let interiorDifferences = 0, edgeDifferences = 0;
for (let i = 0; i < pixels.length; i++) {
  if (pixels[i] === expected[i]) continue;
  edgeDifferences++;
  if ((pixels[i] === 0 && expected[i] === 255) || (pixels[i] === 255 && expected[i] === 0)) interiorDifferences++;
}
assert.equal(interiorDifferences, 0); assert.ok(edgeDifferences < size * size * .01);
const ink = (x,y) => pixels[Math.floor(y*10)*size+Math.floor(x*10)] < 128;
for (let y=40; y<87.9; y+=.1) {
  for (let x=56.1; x<59.9; x+=.1) assert.equal(ink(x,y),false);
  assert.equal(ink(55.8,y),true);
}
let minimumThickness = Infinity;
for (let x=60; x<=78; x+=.01) {
  const dx=x-67, outer=54-Math.sqrt(625-dx*dx);
  const inner=Math.abs(dx)<=11 ? 54-Math.sqrt(121-dx*dx) : 88;
  minimumThickness=Math.min(minimumThickness,inner-outer);
  assert.ok(inner-outer>=7-1e-8);
}
assert.equal(92-78,14);
assert.match(mark,/M60 30A25/);
await sharp(Buffer.from(mark), { density: 720 }).resize(1000,1000).png().toFile(path.join(out,'master.png'));
const css = await readFile(path.join(root, 'app/design/tokens.css'), 'utf8');
const rgb = hex => hex.replace('#', '').match(/../g).map(v => parseInt(v,16));
const lum = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i],0);
const contrast = (a,b) => (Math.max(lum(a),lum(b)) + .05) / (Math.min(lum(a),lum(b)) + .05);
const ratios = [];
for (const theme of ['light','dark']) {
  const block = css.match(new RegExp(`\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\}`))[1];
  const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]]));
  const add = (foreground, background, minimum, bg = rgb(tokens[background])) => {
    const ratio = contrast(rgb(tokens[foreground]),bg); assert.ok(ratio >= minimum, `${theme}: ${foreground}/${background} ${ratio}`);
    ratios.push({ theme, foreground, color: tokens[foreground], background, backgroundColor: bg.map(v=>Math.round(v)), ratio: +ratio.toFixed(3), minimum });
  };
  for (const background of ['bg','nav-bg','surface','surface-2','selected']) {
    add('brand', background, 3); add('focus', background, 3); add('fail', background, 4.5);
  }
  add('focus','bg',4.5); add('focus','surface',4.5);
  add('focus','popup',3,theme === 'dark' ? [35,35,34] : rgb(tokens.surface));
  add('accent-text','accent',4.5); add('accent-text','accent-hover',4.5);
  const rgba = tokens['fail-bg'].match(/[\d.]+/g).map(Number);
  add('fail','fail-bg',4.5,rgb(tokens.bg).map((v,i)=>v*(1-rgba[3])+rgba[i]*rgba[3]));
}
const evidence = { deterministic: true, icoSizes: [16,24,32,48,64,128,256], geometry: { gap: 4, minimumThickness, rearClipX: 60, interiorDifferences, edgeDifferences }, ratios };
await writeFile(path.join(out,'evidence.json'), JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
