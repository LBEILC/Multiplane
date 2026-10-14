import { createTempDirectory } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardSkillProcesses } from './skill-isolation.mjs';

const directory = fileURLToPath(new URL('../out/tests/', import.meta.url));
mkdirSync(directory, { recursive: true });
process.env.MULTIPLANE_HOME = createTempDirectory(path.join(directory, 'home-'));
delete process.env.MULTIPLANE_NO_INDEX;
delete process.env.MULTIPLANE_JOBS_DIR;

process.env.MULTIPLANE_AGENT_HOME = createTempDirectory(path.join(directory, 'agents-'));
guardSkillProcesses();
