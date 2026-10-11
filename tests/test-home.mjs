import { createTempDirectory } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

mkdirSync('out/tests', { recursive: true });
process.env.MULTIPLANE_HOME = createTempDirectory(path.resolve('out/tests/home-'));
delete process.env.MULTIPLANE_NO_INDEX;
delete process.env.MULTIPLANE_JOBS_DIR;
