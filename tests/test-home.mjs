import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

mkdirSync('out/tests', { recursive: true });
process.env.MULTIPLANE_HOME = mkdtempSync(path.resolve('out/tests/home-'));
delete process.env.MULTIPLANE_NO_INDEX;
delete process.env.MULTIPLANE_JOBS_DIR;
