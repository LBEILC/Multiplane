import { createRenderPool } from '../src/render-pool.mjs';
import { createHash } from 'node:crypto';
const [shot, transport, count, mode] = process.argv.slice(2);
const warnings = [], hashes = [];
const pool = createRenderPool(shot, { root: process.cwd(), raster: 'software', transport,
  'motion-blur': 2, 'adaptive-blur': 0, grain: 2, 'static-reuse': mode === 'static', _stallTimeoutMs: 400 }, 4, Number(count),
  { width: 640, height: 360 }, warning => {
    warnings.push(warning);
    if (mode === 'cancel') queueMicrotask(() => pool.cancel());
  });
let code, exitCode;
try {
  for await (const { png } of pool.frames(0, 4)) hashes.push(createHash('sha256').update(png).digest('hex'));
} catch (error) { code = error.code; exitCode = error.exitCode; }
finally { await pool.close(); }
console.log(JSON.stringify({ warnings, hashes, code, exitCode, frames: pool.stats.frames }));
