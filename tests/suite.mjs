import test from 'node:test';

// Direct node --test invocations stay exhaustive. Only npm test selects daily.
export const isFull = process.env.MULTIPLANE_TEST_SUITE !== 'daily';
export function fullTest(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  return test(name, { ...options, skip: options?.skip || (!isFull && 'Run npm run test:full') }, fn);
}
