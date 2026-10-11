import { generateBrand } from './brand.mjs';
import { build } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { checkFont, prepareFont, copyFont } from './fonts.mjs';
await generateBrand();
await mkdir('dist', { recursive: true });
await Promise.all([
  ...['main', 'preload', 'renderer'].map(part => build({ entryPoints: [`src/${part}/index.ts`], outfile: `dist/${part}.${part === 'renderer' ? 'js' : 'cjs'}`, bundle: true, platform: part === 'renderer' ? 'browser' : 'node', format: part === 'renderer' ? 'iife' : 'cjs', external: ['electron'], target: part === 'renderer' ? 'chrome140' : 'node24' })),
  copyFile('src/renderer/style.css', 'dist/style.css'),
  copyFile('src/main/browser-worker.cjs', 'dist/browser-worker.cjs'),
  copyFile('design/tokens.css', 'dist/tokens.css'),
  cp('node_modules/remixicon/fonts', 'dist/icons', { recursive: true }),
  copyFile('node_modules/remixicon/License', 'dist/ICON_LICENSE'),
  ...['LICENSE', 'REFERENCE_LICENSE', 'THIRD_PARTY_NOTICES.md'].map(file => copyFile(file, `dist/${file}`))
]);
if (process.env.MULTIPLANE_FONT_CACHE_ONLY === '1') await prepareFont();
else try { await checkFont(); } catch { try { await prepareFont(); } catch (e) { console.warn('Official font download unavailable:', e.message); } }
await copyFont('dist');

await cp('build/icons', 'dist/brand', { recursive: true });
const mark = await readFile('design/icons/mark.svg', 'utf8');
await writeFile('dist/index.html', (await readFile('src/renderer/index.html', 'utf8')).replaceAll('<!-- BRAND_MARK -->', mark.trim().replace('<svg ', '<svg class="brand-mark" aria-hidden="true" ')));
