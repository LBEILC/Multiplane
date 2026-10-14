import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRenderPool } from '../../src/render-pool.mjs';
import { isolateDevelopmentHome } from '../development-home.mjs';

isolateDevelopmentHome('bench-static-reuse');
await mkdir('out/bench', { recursive: true });
const results = [], references = new Map();
for (const blur of [1, 6]) {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
      const options = { transport: 'raw', 'motion-blur': blur, 'no-static-reuse': !enabled };
      const started = performance.now();
      const pool = createRenderPool('tools/bench/shots/static-half.html', options, 30, 1, { width: 1920, height: 1080 });
      const hashes = [];
      try {
        for await (const item of pool.frames(0, 120)) hashes.push(createHash('sha256').update(item.png).digest('hex'));
        if (!enabled) references.set(blur, hashes);
        else if (hashes.some((hash, frame) => hash !== references.get(blur)[frame])) throw Error('Static reuse changes frame pixels.');
        results.push({ blur, enabled, repeat, frames: hashes.length, elapsedMs: performance.now() - started,
          staticReuse: pool.staticReuse, stats: pool.stats, pixelEquivalent: true });
      } finally { await pool.close(); }
      console.log(JSON.stringify(results.at(-1)));
      await writeFile('out/bench/static-reuse.json', JSON.stringify(results, null, 2));
    }
  }
}
