export { renderShot } from './render.mjs';
export { resumeRender } from './resume.mjs';
export { stillsShot } from './stills.mjs';
export { verifyShot } from './verify.mjs';
export { openShot } from './capture.mjs';
export { inspectShot } from './inspect.mjs';
export { createPostCapture } from './post.mjs';
export { createRenderPool } from './render-pool.mjs';
export { MultiplaneError, errorCodes } from './errors.mjs';
export { doctor } from './doctor.mjs';
export { statusJob, cancelJob, waitJob } from './jobs.mjs';

import { runCommand } from './events.mjs';
import { checkLint } from './lint.mjs';
export const lintShot = (shot, options = {}) => runCommand('lint', shot, options, events => checkLint(shot, events.options, events), false);
