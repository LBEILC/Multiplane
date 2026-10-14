// Only fallback CLI fixtures preload this module. Production defaults and
// diagnostic text remain untouched; the real handoff receives short parameters.
import { registerHooks } from 'node:module';

const hosted = new URL('../src/hosted.mjs', import.meta.url).href;
const original = hosted + '?original-test-handoff';
registerHooks({
  load(url, context, nextLoad) {
    if (url !== hosted) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export * from ${JSON.stringify(original)};
      import { handoff as originalHandoff } from ${JSON.stringify(original)};
      export function handoff(request, options) {
        return originalHandoff(request, { timeout: 250, startTimeout: 250, interval: 5, ...options });
      }
    ` };
  },
});
