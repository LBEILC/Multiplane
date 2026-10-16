import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { renderShot } from '../../src/render.mjs';

const [shot, jobs, output, ready] = process.argv.slice(2);
let jobId;
await renderShot(shot, { root: path.dirname(shot), 'job-dir': jobs, out: output, workers: 1,
  to: 1, 'no-lint': true, 'no-post': true, _segmentFrames: 4,
  onEvent: event => { if (event.type === 'start') jobId = event.jobId; },
  async _segmentHook(phase, index) {
    if (phase !== 'sealed' || index !== 0) return;
    await writeFile(ready, JSON.stringify({ jobId }));
    // The parent terminates this entire owned OS scope, without cleanup handlers.
    await new Promise(() => {});
  },
});
