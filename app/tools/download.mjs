import { setTimeout as delay } from 'node:timers/promises';

// Include response-body consumption: a server may close after sending headers.
export function createRequester({ fetchImpl = fetch, attempts = 4, attemptMs = 60000, totalMs = 300000, backoffMs = 1000, log = console.warn } = {}) {
  const deadline = performance.now() + totalMs;
  return async (url, headers) => {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      try {
        const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(attemptMs, remaining)))) });
        if (!response.ok) {
          await response.body?.cancel();
          const error = Error(`HTTP ${response.status}: ${url}`);
          error.permanent = ![408, 429].includes(response.status) && response.status < 500;
          throw error;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, bytes };
      } catch (error) {
        if (error.permanent) throw error;
        last = error;
        const wait = backoffMs * 2 ** (attempt - 1);
        if (attempt === attempts || performance.now() + wait >= deadline) break;
        log(`Official font download interrupted (attempt ${attempt}/${attempts}); retrying in ${wait} ms: ${error.message}`);
        await delay(wait);
      }
    }
    throw new Error(`Official font download failed within the retry/time limit: ${url}${last ? ` (${last.message})` : ''}`, { cause: last });
  };
}
